import { Node, tokenText, type Tree } from "../syntax/tree.ts";
import { type FunctionInfo, Sem, type Semantics, Stage, Stages } from "./check.ts";
import {
    convertValue,
    EvalError,
    f16Max,
    f32Max,
    fail,
    map1,
    type Value,
    zeroValue,
} from "./eval.ts";
import { valueOf } from "./evaluate.ts";
import { evaluateBuiltin } from "./intrinsics.ts";
import { roundUp, sizeOf, strideOf } from "./layout.ts";
import { Kind, loaded, scalarOf, type Type } from "./types.ts";
import { BufferViews } from "./views.ts";

/** Pipeline creation parameters of a shader stage, as in WebGPU's GPUProgrammableStage. */
export interface PipelineStage {
    readonly stage: "vertex" | "fragment" | "compute";
    readonly entryPoint?: string;
    /** Values of the pipeline-overridable constants by name or numeric id. */
    readonly constants: Readonly<Record<string, number>>;
    /** Device limits by WebGPU limit name. */
    readonly limits: Readonly<Record<string, number>>;
    /** Minimum and maximum subgroup sizes of the adapter. */
    readonly subgroupSizes?: readonly [number, number];
}

const stageBits = { vertex: Stages.Vertex, fragment: Stages.Fragment, compute: Stages.Compute };

/**
 * Validates the pipeline creation for a stage of the analyzed module, evaluating the
 * override-expressions with the given constants; returns the error message or undefined.
 */
export function validatePipeline(semantics: Semantics, stage: PipelineStage): string | undefined {
    const bit = stageBits[stage.stage];
    const candidates = [...semantics.functions.values()].filter(f => f.stage === bit);
    const entries =
        stage.entryPoint === undefined
            ? candidates
            : candidates.filter(f => f.name === stage.entryPoint);
    if (entries.length !== 1) return `entry point '${stage.entryPoint ?? ""}' not found`;
    try {
        new PipelineValidator(semantics, stage, entries[0]!).run();
        return undefined;
    } catch (e) {
        if (e instanceof EvalError) return e.message;
        throw e;
    }
}

class PipelineValidator {
    private readonly tree: Tree;
    private readonly overrides = new Map<string, number>();
    private readonly memo = new Map<number, Value | undefined>();
    private readonly functions = new Set<FunctionInfo>();
    private readonly globals = new Set<number>();
    private readonly views: BufferViews;

    constructor(
        private readonly sem: Semantics,
        private readonly stage: PipelineStage,
        private readonly entry: FunctionInfo,
    ) {
        this.tree = sem.tree;
        this.views = new BufferViews({
            tree: sem.tree,
            refs: sem.resolution.refs,
            types: sem.types,
            overloads: sem.overloads,
            value: node => {
                const value = this.eval(node);
                return value === undefined ? undefined : Number(value);
            },
            size: buffer => this.bufferSize(buffer),
            report: (_, message) => fail(message),
        });
    }

    run(): void {
        const { tree, sem } = this;
        for (let node = tree.firsts[0]!; node; node = tree.nexts[node]!) {
            if (tree.kinds[node] !== Node.Override) continue;
            this.overrides.set(this.name(node), node);
            const id = this.attribute(node, "id");
            const value = id ? sem.values[tree.firsts[id]!] : undefined;
            if (value !== undefined) this.overrides.set(String(value), node);
        }
        for (const key of Object.keys(this.stage.constants))
            if (!this.overrides.has(key))
                fail(`pipeline constant '${key}' is not an override declared by the module`);
        this.collect(this.entry);
        for (const decl of sem.resolution.order) {
            const fn = sem.functions.get(decl);
            if (fn && this.functions.has(fn)) this.visit(decl);
        }
        for (const global of this.globals)
            if (tree.kinds[global] === Node.Override) this.override(global);
            else this.visit(global);
        if (this.entry.stage === Stages.Compute) this.compute();
    }

    private collect(fn: FunctionInfo): void {
        if (this.functions.has(fn)) return;
        this.functions.add(fn);
        for (const global of fn.globals) this.globals.add(global);
        for (const callee of fn.callees) {
            const info = this.sem.functions.get(callee);
            if (info) this.collect(info);
        }
    }

    /** Evaluates the override-expressions of the subtree and validates them with the operands. */
    private visit(node: number): void {
        const { tree, sem } = this;
        const value = sem.sems[node] === Sem.Value;
        if (value && sem.stages[node] === Stage.Override) {
            this.eval(node);
            return;
        }
        for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!) this.visit(child);
        if (value && sem.stages[node] === Stage.Runtime) this.partial(node);
    }

    /** Validates a runtime expression's operands known at pipeline creation. */
    private partial(node: number): void {
        const { tree, sem } = this;
        const kind = tree.kinds[node];
        if (kind === Node.Binary) {
            const lhs = tree.firsts[node]!;
            const rhs = tree.nexts[lhs]!;
            const op = tokenText(tree, node);
            if (op !== "<<" && op !== ">>" && op !== "/" && op !== "%") return;
            if (sem.stages[rhs] !== Stage.Override) return;
            const value = this.eval(rhs);
            const res = sem.overloads[node];
            if (value === undefined || !res) return;
            const scalar = scalarOf(res.params[0]!).kind;
            const converted = convertValue(value, loaded(sem.types[rhs]!), res.params[1]!);
            map1(converted, v => {
                if ((op === "<<" || op === ">>") && scalar !== Kind.AbstractInt && Number(v) >= 32)
                    fail(
                        `shift ${op === "<<" ? "left" : "right"} value must be less than the bit width of the lhs, which is 32`,
                    );
                if (
                    (op === "/" || op === "%") &&
                    (scalar === Kind.I32 || scalar === Kind.U32) &&
                    Number(v) === 0
                )
                    fail("integer division by zero is invalid");
                return v;
            });
            return;
        }
        if (kind === Node.Index) {
            const base = tree.firsts[node]!;
            const index = tree.nexts[base]!;
            if (sem.stages[index] !== Stage.Override) return;
            const value = this.eval(index);
            let type = sem.types[base];
            if (value === undefined || !type) return;
            if (
                type.kind === Kind.Reference ||
                type.kind === Kind.Pointer ||
                type.kind === Kind.Swizzle
            )
                type = type.elem!;
            const count =
                type.kind === Kind.Array && type.count < 0 ? this.arrayCount(type) : type.count;
            const position = Number(value);
            if (position < 0 || (count > 0 && position >= count))
                fail(`index ${position} out of bounds [0..${count - 1}]`);
            return;
        }
        if (kind === Node.Call) {
            const decl = sem.resolution.refs[tree.firsts[node]!]!;
            const name = sem.overloads[node]?.overload.name;
            if (tree.kinds[decl] === Node.Function) this.views.userCall(node, decl);
            else if (name === "bufferView" || name === "bufferArrayView") this.views.view(node);
            else this.partialBuiltin(node);
        }
    }

    private partialBuiltin(node: number): void {
        const { tree, sem } = this;
        const res = sem.overloads[node];
        if (!res || res.overload.kind !== "function") return;
        const args: number[] = [];
        for (let arg = tree.nexts[tree.firsts[node]!]!; arg; arg = tree.nexts[arg]!) args.push(arg);
        const known = (indices: readonly number[]): Value[] | undefined => {
            const values: Value[] = [];
            for (const i of indices) {
                const arg = args[i]!;
                const value = sem.stages[arg] === Stage.Runtime ? undefined : this.eval(arg);
                if (value === undefined) return undefined;
                values.push(convertValue(value, loaded(sem.types[arg]!), res.params[i]!));
            }
            return values;
        };
        const zero = (i: number): Value => zeroValue(res.params[i]!);
        const name = res.overload.name;
        let fake: Value[] | undefined;
        if (name === "clamp") {
            const values = known([1, 2]);
            if (values) fake = [values[0]!, values[0]!, values[1]!];
        } else if (name === "smoothstep") {
            const values = known([0, 1]);
            if (values) fake = [values[0]!, values[1]!, values[1]!];
        } else if (name === "ldexp") {
            const values = known([1]);
            if (values) fake = [zero(0), values[0]!];
        } else if (name === "extractBits") {
            const values = known([1, 2]);
            if (values) fake = [zero(0), values[0]!, values[1]!];
        } else if (name === "insertBits") {
            const values = known([2, 3]);
            if (values) fake = [zero(0), zero(1), values[0]!, values[1]!];
        } else if (name.startsWith("subgroupShuffle") || name === "quadBroadcast") {
            const values = known([1]);
            const limit = name === "quadBroadcast" ? 4 : 128;
            const value = values && Number(values[0]);
            if (value !== undefined && (value < 0 || value >= limit))
                fail(
                    `the ${res.overload.params[1]!.name} argument of ${name} must be at least 0 and less than ${limit}`,
                );
        }
        if (fake) evaluateBuiltin(name, fake, res);
    }

    /** Evaluates the const- or override-expression with the pipeline constants. */
    private eval(node: number): Value | undefined {
        const { tree, sem } = this;
        const stage = sem.stages[node];
        if (stage === Stage.Const) return sem.values[node] as Value | undefined;
        if (stage !== Stage.Override) return undefined;
        if (this.memo.has(node)) return this.memo.get(node);
        let value: Value | undefined;
        if (tree.kinds[node] === Node.Ident) {
            const decl = sem.resolution.refs[node]!;
            value = tree.kinds[decl] === Node.Override ? this.override(decl) : undefined;
        } else value = valueOf(sem, node, n => this.eval(n));
        this.memo.set(node, value);
        return value;
    }

    /** Returns the value of the override: the pipeline constant or its initializer. */
    private override(decl: number): Value | undefined {
        if (this.memo.has(decl)) return this.memo.get(decl);
        const { tree, sem } = this;
        const type = sem.types[decl];
        if (!type) return undefined;
        const name = this.name(decl);
        const id = this.attribute(decl, "id");
        const idValue = id ? sem.values[tree.firsts[id]!] : undefined;
        const constant =
            this.stage.constants[name] ??
            (idValue !== undefined ? this.stage.constants[String(idValue)] : undefined);
        let value: Value | undefined;
        if (constant !== undefined) value = convertConstant(constant, type, name);
        else {
            let init = 0;
            for (let child = tree.firsts[decl]!; child; child = tree.nexts[child]!)
                if (
                    tree.kinds[child] !== Node.Attribute &&
                    tree.kinds[child] !== Node.Name &&
                    tree.kinds[child] !== Node.Type
                )
                    init = child;
            if (!init) fail(`pipeline overridable constant '${name}' has no value`);
            const initValue = this.eval(init);
            value =
                initValue === undefined
                    ? undefined
                    : convertValue(initValue, loaded(sem.types[init]!), type);
        }
        this.memo.set(decl, value);
        return value;
    }

    /** Validates the workgroup size, subgroup size and workgroup storage of a compute entry point. */
    private compute(): void {
        const { limits } = this.stage;
        const workgroup = this.attribute(this.entry.node, "workgroup_size");
        const sizes = [1, 1, 1];
        if (workgroup) {
            let i = 0;
            for (let arg = this.tree.firsts[workgroup]!; arg; arg = this.tree.nexts[arg]!, i++) {
                const value = this.eval(arg);
                if (value === undefined) return;
                const size = Number(value);
                if (size < 1) fail("workgroup_size argument must be at least 1");
                sizes[i] = size;
            }
        }
        const names = [
            "maxComputeWorkgroupSizeX",
            "maxComputeWorkgroupSizeY",
            "maxComputeWorkgroupSizeZ",
        ];
        for (let i = 0; i < 3; i++) {
            const limit = limits[names[i]!];
            if (limit !== undefined && sizes[i]! > limit)
                fail(`workgroup_size ${"xyz"[i]} (${sizes[i]}) exceeds the limit of ${limit}`);
        }
        const invocations = limits.maxComputeInvocationsPerWorkgroup;
        if (invocations !== undefined && sizes[0]! * sizes[1]! * sizes[2]! > invocations)
            fail(`the workgroup size exceeds the limit of ${invocations} invocations`);
        const subgroup = this.attribute(this.entry.node, "subgroup_size");
        if (subgroup) {
            const arg = this.tree.firsts[subgroup]!;
            const value = this.eval(arg);
            if (value !== undefined) {
                const size = Number(value);
                if (size < 1 || (size & (size - 1)) !== 0)
                    fail("@subgroup_size must be a power of two");
                const [min, max] = this.stage.subgroupSizes ?? [4, 128];
                if (size < min || size > max)
                    fail(`@subgroup_size must be between ${min} and ${max}`);
                if (sizes[0]! % size !== 0)
                    fail("the workgroup size x must be a multiple of the subgroup size");
            }
        }
        let storage = 0;
        for (const global of this.globals) {
            const type = this.sem.types[global];
            if (this.tree.kinds[global] !== Node.Var || type?.space !== "workgroup") continue;
            const store = type.elem!;
            const size =
                store.kind === Kind.Array && store.count < 0
                    ? this.arrayCount(store) * strideOf(store)
                    : sizeOf(store);
            storage += roundUp(16, size);
        }
        const limit = limits.maxComputeWorkgroupStorageSize;
        if (limit !== undefined && storage > limit)
            fail(`the workgroup storage size (${storage}) exceeds the limit of ${limit}`);
    }

    /** Evaluates the element count of an override-sized array. */
    private arrayCount(type: Type): number {
        const node = type.node;
        const value =
            this.tree.kinds[node] === Node.Override ? this.override(node) : this.eval(node);
        if (value === undefined) return 0;
        const count = Number(value);
        if (count < 1) fail(`array count (${count}) must be greater than 0`);
        return count;
    }

    /** Returns the size of the buffer type, evaluating its override-expression size. */
    private bufferSize(buffer: Type): number | undefined {
        if (buffer.count >= 0) return buffer.count || undefined;
        const node = buffer.node;
        const value =
            this.tree.kinds[node] === Node.Override ? this.override(node) : this.eval(node);
        return value === undefined ? undefined : Number(value);
    }

    private name(decl: number): string {
        const { tree } = this;
        for (let child = tree.firsts[decl]!; child; child = tree.nexts[child]!)
            if (tree.kinds[child] === Node.Name) return tokenText(tree, child);
        return "";
    }

    private attribute(decl: number, name: string): number {
        const { tree } = this;
        for (
            let attr = tree.firsts[decl]!;
            attr && tree.kinds[attr] === Node.Attribute;
            attr = tree.nexts[attr]!
        )
            if (tokenText(tree, attr) === name) return attr;
        return 0;
    }
}

/** Converts a pipeline constant to the override's type, as WebGPU does. */
function convertConstant(value: number, type: Type, name: string): Value {
    const invalid = (): never =>
        fail(`pipeline constant '${name}' value ${value} cannot be represented as '${type.name}'`);
    switch (type.kind) {
        case Kind.Bool:
            return value !== 0;
        case Kind.I32:
        case Kind.U32: {
            if (!Number.isFinite(value)) return invalid();
            const truncated = Math.trunc(value);
            const [min, max] = type.kind === Kind.I32 ? [-2147483648, 2147483647] : [0, 4294967295];
            return truncated < min || truncated > max ? invalid() : truncated;
        }
        case Kind.F32: {
            const rounded = Math.fround(value);
            return !Number.isFinite(value) || Math.abs(value) > f32Max ? invalid() : rounded;
        }
        default: {
            const rounded = Math.f16round(value);
            return !Number.isFinite(value) || Math.abs(value) > f16Max ? invalid() : rounded;
        }
    }
}
