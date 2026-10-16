import type { Diagnostic, Severity } from "../syntax/diagnostic.ts";
import { floatValue, intValue } from "../syntax/literal.ts";
import { Tok } from "../syntax/token.ts";
import {
    childOf,
    initializerOf,
    lastChild,
    Node,
    skipAttributes,
    tokenText,
    type Tree,
} from "../syntax/tree.ts";
import { enums } from "./builtins.ts";
import { convertValue, EvalError, map1, type Value, zeroValue } from "./eval.ts";
import { type Evaluation, swizzleIndices, valueOf } from "./evaluate.ts";
import { evaluateBuiltin } from "./intrinsics.ts";
import {
    builtinTypeMessage,
    builtinValues,
    interpolationSamplings,
    interpolationTypes,
    type Io,
    type IoGroup,
    isIntegral,
    Stages,
    stageName,
    validateIo,
} from "./interface.ts";
import { alignOf, type MemberLayout, roundUp, setLayout, sizeOf } from "./layout.ts";
import {
    constructorOverloads,
    functionOverloads,
    operatorOverloads,
    type Overload,
    type Resolution as OverloadResolution,
    resolveOverload,
    type TemplateArg,
} from "./overloads.ts";
import { enumOf, isF16Alias, predeclaredTypes, typeGenerators } from "./predeclared.ts";
import { memoryRoot, type Resolution } from "./resolve.ts";
import {
    abstractFloat,
    abstractInt,
    type Access,
    type AddressSpace,
    array,
    atomic,
    boolType,
    buffer,
    commonType,
    comparisonSamplerType,
    concretize,
    containsAtomic,
    conversionRank,
    errorType,
    f16,
    f32,
    hasCreationFixedFootprint,
    hasFixedFootprint,
    i32,
    isAbstract,
    isConstructible,
    isHandle,
    isHostShareable,
    isRuntimeSized,
    isScalar,
    isStorable,
    Kind,
    loaded,
    mat,
    type Member,
    noConversion,
    overrideArray,
    overrideBuffer,
    pointer,
    reference,
    sampledTexture,
    samplerType,
    scalarOf,
    storageTexture,
    struct,
    swizzleView,
    texture,
    type Type,
    typeName,
    u32,
    unsizedBuffer,
    vec,
    voidType,
} from "./types.ts";
import { analyzeUniformity, Behavior, Requirement, requirementOf } from "./uniformity.ts";
import { BufferViews } from "./views.ts";

/** Analyzer options describing the target WebGPU implementation. */
export interface Options {
    /** Enable-extensions the implementation supports; all the standard ones when omitted. */
    readonly extensions?: ReadonlySet<string>;
    /** Language extensions the implementation supports; the ones shipped in Chrome when omitted. */
    readonly features?: ReadonlySet<string>;
}

/** Enable-extensions defined by the WGSL spec and supported by Chrome. */
export const standardExtensions: ReadonlySet<string> = new Set([
    "f16",
    "clip_distances",
    "dual_source_blending",
    "subgroups",
    "primitive_index",
    "subgroup_size_control",
    "atomic_vec2u_min_max",
]);

/** Language extensions shipped in Chrome. */
export const shippedFeatures: ReadonlySet<string> = new Set([
    "readonly_and_readwrite_storage_textures",
    "packed_4x8_integer_dot_product",
    "unrestricted_pointer_parameters",
    "pointer_composite_access",
    "uniform_buffer_standard_layout",
    "subgroup_id",
    "subgroup_uniformity",
    "texture_and_sampler_let",
    "texture_formats_tier1",
    "linear_indexing",
    "immediate_address_space",
    "buffer_view",
    "swizzle_assignment",
]);

export { Stages } from "./interface.ts";

/** Semantic category of an expression node. */
export enum Sem {
    None,
    Value,
    Type,
    Enum,
    Function,
    Error,
}

/** Stage at which an expression can be evaluated. */
export enum Stage {
    Const,
    Override,
    Runtime,
}

/** Semantic information on a user-declared function. */
export interface FunctionInfo {
    readonly node: number;
    readonly name: string;
    readonly params: readonly Type[];
    readonly result: Type;
    /** The shader stage when the function is an entry point. */
    readonly stage: Stages;
    readonly mustUse: boolean;
    /** User-declared functions called by the function. */
    readonly callees: Set<number>;
    /** Module-scope variables referenced by the function directly. */
    readonly globals: Set<number>;
    /** Shader stages the function can execute in, considering the functions it calls. */
    stages: Stages;
    /** A node responsible for restricting the stages, for the diagnostic messages. */
    restriction: number;
    /** Workgroup size of a compute entry point, when its values are known. */
    workgroupSize: readonly number[] | undefined;
}

/** Semantic analysis results of a syntax tree. */
export interface Semantics {
    readonly tree: Tree;
    readonly resolution: Resolution;
    /** Semantic category of each node. */
    readonly sems: Uint8Array;
    /**
     * Type of each node: the value type of the expressions, the denoted type of the type
     * expressions and the declared type of the declarations (memory view for variables).
     */
    readonly types: readonly (Type | undefined)[];
    /** Value of the const-expressions and declarations, or the name of the enumerants. */
    readonly values: readonly (Value | string | undefined)[];
    /** Evaluation stage of each expression node. */
    readonly stages: Uint8Array;
    /** Overloads selected for the builtin calls and operators. */
    readonly overloads: readonly (OverloadResolution | undefined)[];
    readonly functions: ReadonlyMap<number, FunctionInfo>;
    /** Enable-extensions enabled with the enable directives. */
    readonly extensions: ReadonlySet<string>;
    readonly diagnostics: readonly Diagnostic[];
}

/** Checks the types and validates the resolved tree. */
export function check(resolution: Resolution, options: Options = {}): Semantics {
    return new Checker(resolution, options).run();
}

const stageNames: Record<string, Stages> = {
    vertex: Stages.Vertex,
    fragment: Stages.Fragment,
    compute: Stages.Compute,
};
const stageAttributes = Object.entries(stageNames);

/** Kinds of the objects attributes are applied to. */
enum Target {
    None,
    Function,
    Param,
    Result,
    Member,
    Var,
    Override,
    Statement,
}

const targetNames = [
    "this declaration",
    "functions",
    "function parameters",
    "function return types",
    "structure members",
    "module-scope 'var' declarations",
    "'override' declarations",
    "statements",
];

const io = [Target.Param, Target.Result, Target.Member];

/** The targets each attribute is valid for. */
const placements: Record<string, readonly Target[]> = {
    align: [Target.Member],
    binding: [Target.Var],
    blend_src: [Target.Member],
    builtin: io,
    compute: [Target.Function],
    const: [],
    diagnostic: [Target.Function, Target.Statement],
    fragment: [Target.Function],
    group: [Target.Var],
    id: [Target.Override],
    interpolate: io,
    invariant: io,
    location: io,
    must_use: [Target.Function],
    size: [Target.Member],
    subgroup_size: [Target.Function],
    vertex: [Target.Function],
    workgroup_size: [Target.Function],
};

/** Tint's limit on the element count of arrays outside the storage address space. */
const maxArrayElementCount = 65536;

const noArgumentAttributes = new Set([
    "compute",
    "fragment",
    "vertex",
    "must_use",
    "invariant",
    "const",
]);

/** Memory accesses of a function, for the alias analysis of the calls to it. */
interface Accesses {
    /** Module-scope variables read by the function, with the first expression reading them. */
    readonly globalReads: Map<number, number>;
    /** Module-scope variables written by the function, with the first expression writing them. */
    readonly globalWrites: Map<number, number>;
    readonly paramReads: Set<number>;
    readonly paramWrites: Set<number>;
}

const atomicReadWrites = new Set([
    "atomicAdd",
    "atomicSub",
    "atomicMax",
    "atomicMin",
    "atomicStoreMax",
    "atomicStoreMin",
    "atomicAnd",
    "atomicOr",
    "atomicXor",
    "atomicExchange",
    "atomicCompareExchangeWeak",
]);

/** Enclosing constructs of a statement, for validating break and continue. */
enum Scope {
    Loop,
    Switch,
    Continuing,
}

class Checker {
    private readonly tree: Tree;
    private readonly refs: Uint32Array;
    private readonly kinds: Uint8Array;
    private readonly sems: Uint8Array;
    private readonly types: (Type | undefined)[];
    private readonly values: (Value | string | undefined)[];
    private readonly stages: Uint8Array;
    /** Whether the load rule is applied to each expression node. */
    private readonly loads: Uint8Array;
    /** Behaviors of each statement node. */
    private readonly behaviors: Uint8Array;
    private readonly overloads: (OverloadResolution | undefined)[];
    private readonly evaluation: Evaluation;
    private readonly views: BufferViews;
    private readonly functions = new Map<number, FunctionInfo>();
    private readonly diagnostics: Diagnostic[] = [];
    private readonly extensions = new Set<string>();
    private readonly supportedExtensions: ReadonlySet<string>;
    private readonly supportedFeatures: ReadonlySet<string>;
    private readonly interned = new Map<string, Type>();
    /** Uniformity the builtins called in the module require. */
    private requirements = Requirement.None;
    /** Overload resolutions by the overloads and the types of the call. */
    private readonly resolutions = new Map<
        readonly Overload[],
        Map<string, OverloadResolution | undefined | null>
    >();
    private readonly overrideIds = new Map<number, number>();
    private fn: FunctionInfo | undefined;
    /** Memory accesses of the user-declared functions, by declaration. */
    private readonly accesses = new Map<number, Accesses>();
    /** Memory accesses of the function being checked. */
    private access: Accesses | undefined;
    /** Shader stage of the function whose header is being checked. */
    private fnStage = Stages.None;
    /** IO attributes of the structure members, by structure type. */
    private readonly memberIos = new Map<Type, Io[]>();
    /** Binding points of the resource variables as "group:binding". */
    private readonly bindings = new Map<number, string>();
    private readonly scopes: Scope[] = [];
    /** Nesting of the expressions whose const-evaluation is skipped by short-circuiting. */
    private skipEval = 0;
    /** Continue statements of the enclosing loops, for validating the continuing blocks. */
    private continues: number[][] = [];

    constructor(
        private readonly resolution: Resolution,
        options: Options,
    ) {
        this.tree = resolution.tree;
        this.refs = resolution.refs;
        this.kinds = this.tree.kinds;
        const count = this.tree.count;
        this.sems = new Uint8Array(count);
        this.types = new Array<Type | undefined>(count).fill(undefined);
        this.values = new Array<Value | string | undefined>(count).fill(undefined);
        this.stages = new Uint8Array(count);
        this.loads = new Uint8Array(count);
        this.behaviors = new Uint8Array(count);
        this.overloads = new Array<OverloadResolution | undefined>(count).fill(undefined);
        this.evaluation = { tree: this.tree, types: this.types, overloads: this.overloads };
        this.views = new BufferViews({
            tree: this.tree,
            refs: this.refs,
            types: this.types,
            overloads: this.overloads,
            value: node =>
                this.stages[node] === Stage.Const ? Number(this.values[node]) : undefined,
            size: buffer => (buffer.count > 0 ? buffer.count : undefined),
            report: (node, message, note) =>
                this.diagnostics.push({
                    start: this.tree.starts[node]!,
                    end: this.tree.ends[node]!,
                    severity: "error",
                    message,
                    notes: note && [note],
                }),
        });
        this.supportedExtensions = options.extensions ?? standardExtensions;
        this.supportedFeatures = options.features ?? shippedFeatures;
    }

    run(): Semantics {
        const { tree } = this;
        for (let node = tree.firsts[0]!; node; node = tree.nexts[node]!) {
            const kind = this.kinds[node];
            if (kind === Node.Enable) this.enable(node);
            else if (kind === Node.Requires) this.requires(node);
            else if (kind === Node.Directive) this.directive(node);
        }
        for (const decl of this.resolution.order) {
            if (this.resolution.cyclic.has(decl)) continue;
            this.declaration(decl);
        }
        for (let node = tree.firsts[0]!; node; node = tree.nexts[node]!)
            if (this.kinds[node] === Node.ConstAssert) this.constAssert(node);
        if (!this.hasErrors())
            analyzeUniformity(
                {
                    tree,
                    refs: this.refs,
                    order: this.resolution.order,
                    types: this.types,
                    overloads: this.overloads,
                    functions: this.functions,
                    loads: this.loads,
                    behaviors: this.behaviors,
                    directives: this.directives,
                    requirements: this.requirements,
                },
                this.supportedFeatures.has("subgroup_uniformity"),
                this.diagnostics,
            );
        return {
            tree,
            resolution: this.resolution,
            sems: this.sems,
            types: this.types,
            values: this.values,
            stages: this.stages,
            overloads: this.overloads,
            functions: this.functions,
            extensions: this.extensions,
            diagnostics: this.diagnostics,
        };
    }

    // ---- diagnostics ----

    private hasErrors(): boolean {
        const isError = (d: Diagnostic): boolean => d.severity === "error";
        return (
            this.tree.diagnostics.some(isError) ||
            this.resolution.diagnostics.some(isError) ||
            this.diagnostics.some(isError)
        );
    }

    private error(node: number, message: string): void {
        this.report(node, message, "error");
    }

    private report(
        node: number,
        message: string,
        severity: Severity,
        note?: [number, string],
    ): void {
        const { starts, ends } = this.tree;
        this.diagnostics.push({
            start: starts[node]!,
            end: ends[node]!,
            severity,
            message,
            ...(note && {
                notes: [{ start: starts[note[0]]!, end: ends[note[0]]!, message: note[1] }],
            }),
        });
    }

    private text(node: number): string {
        return tokenText(this.tree, node);
    }

    private name(decl: number): string {
        const name = childOf(this.tree, decl, Node.Name);
        return name ? this.text(name) : "";
    }

    private nameNode(decl: number): number {
        return childOf(this.tree, decl, Node.Name) || decl;
    }

    // ---- directives ----

    private enable(node: number): void {
        const { tree } = this;
        for (let name = tree.firsts[node]!; name; name = tree.nexts[name]!) {
            const text = this.text(name);
            if (!enums.extension!.includes(text)) this.error(name, `unknown extension '${text}'`);
            else if (!this.supportedExtensions.has(text) || !standardExtensions.has(text))
                this.error(name, `extension '${text}' is not supported`);
            else {
                this.extensions.add(text);
                if (text === "subgroup_size_control") this.extensions.add("subgroups");
            }
        }
    }

    private requires(node: number): void {
        const { tree } = this;
        for (let name = tree.firsts[node]!; name; name = tree.nexts[name]!) {
            const text = this.text(name);
            if (!this.supportedFeatures.has(text))
                this.error(name, `feature '${text}' is not supported`);
        }
    }

    private readonly directives = new Map<string, string>();

    private directive(node: number): void {
        const severity = this.diagnosticControl(node);
        if (!severity) return;
        const rule = childOf(this.tree, node, Node.Rule);
        const ruleText = this.ruleName(rule);
        const previous = this.directives.get(ruleText);
        if (previous !== undefined && previous !== severity)
            this.error(node, `conflicting diagnostic directive for rule '${ruleText}'`);
        this.directives.set(ruleText, severity);
    }

    private ruleName(rule: number): string {
        const { tree } = this;
        const parts: string[] = [];
        for (let name = tree.firsts[rule]!; name; name = tree.nexts[name]!)
            parts.push(this.text(name));
        return parts.join(".");
    }

    /** Validates the diagnostic control of a directive or attribute; returns its severity. */
    private diagnosticControl(node: number): string | undefined {
        const severity = childOf(this.tree, node, Node.Name);
        const rule = childOf(this.tree, node, Node.Rule);
        if (!severity || !rule) return undefined;
        const severityText = this.text(severity);
        if (!enums.diagnostic_severity!.includes(severityText)) {
            this.error(severity, `invalid diagnostic severity '${severityText}'`);
            return undefined;
        }
        const ruleText = this.ruleName(rule);
        const parts = ruleText.split(".");
        if (parts.length === 1) {
            if (!enums.core_diagnostic_rule!.includes(ruleText))
                this.report(rule, `unrecognized diagnostic rule '${ruleText}'`, "warning");
        } else if (parts[0] === "chromium" && !enums.chromium_diagnostic_rule!.includes(parts[1]!))
            this.report(rule, `unrecognized diagnostic rule '${ruleText}'`, "warning");
        return severityText;
    }

    // ---- declarations ----

    private declaration(decl: number): void {
        switch (this.kinds[decl]) {
            case Node.Alias:
                this.alias(decl);
                break;
            case Node.Struct:
                this.struct(decl);
                break;
            case Node.Const:
                this.constDecl(decl);
                break;
            case Node.Override:
                this.override(decl);
                break;
            case Node.Var:
                this.globalVar(decl);
                break;
            case Node.Function:
                this.function(decl);
                break;
        }
    }

    private alias(decl: number): void {
        const type = this.typeAnnotation(decl);
        if (type) this.types[decl] = type;
    }

    /** Returns the type of the declaration's explicit type annotation, or undefined. */
    private typeAnnotation(decl: number): Type | undefined {
        const annotation = childOf(this.tree, decl, Node.Type);
        if (!annotation) return undefined;
        return this.type(lastChild(this.tree, annotation));
    }

    private struct(decl: number): void {
        const { tree } = this;
        const members: Member[] = [];
        const layout: MemberLayout[] = [];
        const ios: Io[] = [];
        const aligns: [number, number, Type][] = [];
        const names = new Set<string>();
        let offset = 0;
        let valid = true;
        const nodes: number[] = [];
        for (let node = tree.firsts[decl]!; node; node = tree.nexts[node]!)
            if (this.kinds[node] === Node.StructMember) nodes.push(node);
        if (nodes.length === 0)
            this.error(this.nameNode(decl), "structures must have at least one member");
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i]!;
            const name = this.name(node);
            if (names.has(name)) this.error(this.nameNode(node), `redefinition of '${name}'`);
            names.add(name);
            const attrs = this.attributes(node, Target.Member);
            const type = this.typeAnnotation(node);
            if (!type) {
                valid = false;
                continue;
            }
            if (!this.validMemberType(node, type, i === nodes.length - 1)) valid = false;
            members.push({ name, type, node });
            const layable = this.hasLayout(type);
            let align = layable ? alignOf(type) : 1;
            let size = layable ? sizeOf(type) : 0;
            const alignAttr = attrs.get("align");
            if (alignAttr) {
                const value = this.attributeInt(alignAttr, true);
                if (value !== undefined) {
                    if (value < 1 || (value & (value - 1)) !== 0)
                        this.error(
                            alignAttr,
                            "'align' value must be a positive, power-of-two integer",
                        );
                    else {
                        aligns.push([alignAttr, value, type]);
                        align = value;
                    }
                }
            }
            const sizeAttr = attrs.get("size");
            if (sizeAttr) {
                const value = this.attributeInt(sizeAttr, true);
                if (value !== undefined) {
                    if (!hasCreationFixedFootprint(type))
                        this.error(
                            sizeAttr,
                            "@size can only be applied to members where the member's type size can be fully determined at shader creation time",
                        );
                    else if (value < 1) this.error(sizeAttr, "'size' attribute must be positive");
                    else if (value < size)
                        this.error(
                            sizeAttr,
                            `'size' attribute must be at least as big as the type's size (${size})`,
                        );
                    else size = value;
                }
            }
            ios.push(this.ioGroup(node, type, this.io(node, type, attrs)).io);
            offset = roundUp(align, offset);
            layout.push({ offset, align, size });
            offset += size;
        }
        const type = struct(this.name(decl), members, decl);
        if (valid) setLayout(type, layout);
        if (valid && (isHostShareable(type) || isConstructible(type)))
            for (const [attr, value, memberType] of aligns) {
                const natural = alignOf(memberType);
                if (value % natural !== 0)
                    this.error(attr, `alignment must be a multiple of ${natural} bytes`);
            }
        this.structIo(ios);
        this.memberIos.set(type, ios);
        this.types[decl] = type;
        this.sems[decl] = Sem.Type;
    }

    /** Validates the IO attributes of a structure's members that don't depend on the shader stage. */
    private structIo(ios: readonly Io[]): void {
        const locations = new Set<string>();
        let blend: Io | undefined;
        let plain: Io | undefined;
        const blendSrcs = new Set<number>();
        for (const io of ios) {
            if (io.invariantAttr && io.builtin !== "position") {
                this.error(io.invariantAttr, "@invariant must be applied to a position builtin");
                return;
            }
            if (io.interpolateAttr && !io.locationAttr) {
                this.error(io.interpolateAttr, "@interpolate can only be used with @location");
                return;
            }
            if (io.blendSrcAttr) {
                if (io.location !== 0) {
                    this.error(io.blendSrcAttr, "@blend_src can only be used with @location(0)");
                    return;
                }
                if (!blend) blend = io;
                else if (blend.type !== io.type) {
                    this.error(
                        io.blendSrcAttr,
                        "all the outputs with @blend_src must have the same type",
                    );
                    return;
                }
                if (io.blendSrc >= 0) blendSrcs.add(io.blendSrc);
            } else if (io.locationAttr) plain = io;
            if (blend && plain) {
                this.error(
                    io.node,
                    "@blend_src and @location are used on one member while another member with @location doesn't use @blend_src",
                );
                return;
            }
            if (io.locationAttr && io.location >= 0) {
                const key = `${io.location}:${io.blendSrcAttr ? io.blendSrc : "-"}`;
                if (locations.has(key)) {
                    this.error(io.locationAttr, `@location(${io.location}) appears multiple times`);
                    return;
                }
                locations.add(key);
            }
        }
        if (blend && blendSrcs.size < 2 && (blendSrcs.size > 0 || blend.blendSrc < 0))
            for (const i of [0, 1])
                if (!blendSrcs.has(i))
                    this.error(
                        blend.blendSrcAttr,
                        `@blend_src(${i}) is missing when @blend_src is used`,
                    );
    }

    /** Validates the IO attributes of a parameter, return type or structure member. */
    private io(node: number, type: Type, attrs: ReadonlyMap<string, number>): Io | undefined {
        const builtin = attrs.get("builtin");
        const location = attrs.get("location");
        const blendSrc = attrs.get("blend_src");
        const interpolate = attrs.get("interpolate");
        const invariant = attrs.get("invariant");
        if (!builtin && !location && !blendSrc && !interpolate && !invariant) return undefined;
        const io: Io = {
            node,
            type,
            builtin: "",
            builtinAttr: builtin ?? 0,
            location: -1,
            locationAttr: location ?? 0,
            blendSrc: -1,
            blendSrcAttr: blendSrc ?? 0,
            interpolation: "",
            interpolateAttr: interpolate ?? 0,
            invariantAttr: invariant ?? 0,
        };
        if (builtin) io.builtin = this.builtinValue(builtin, type);
        if (location) {
            if (builtin) this.error(location, "multiple entry point IO attributes");
            const value = this.attributeInt(location, true);
            if (value !== undefined) {
                if (value < 0) this.error(location, "@location value must be non-negative");
                else io.location = value;
            }
            if (!isNumericScalarOrVector(type))
                this.error(
                    node,
                    `cannot apply @location to declaration of type '${typeName(type)}'`,
                );
        }
        if (blendSrc) {
            if (!this.extensions.has("dual_source_blending"))
                this.error(
                    blendSrc,
                    "use of @blend_src requires enabling extension 'dual_source_blending'",
                );
            const value = this.attributeInt(blendSrc, true);
            if (value !== undefined) {
                if (value !== 0 && value !== 1)
                    this.error(blendSrc, "@blend_src value must be zero or one");
                else io.blendSrc = value;
            }
        }
        if (interpolate) io.interpolation = this.interpolation(interpolate, type);
        if (invariant) this.noArguments(invariant);
        return io;
    }

    /** Validates the builtin attribute; returns the builtin value name or empty when invalid. */
    private builtinValue(attr: number, type: Type): string {
        const name = this.nameArgument(attr, 0);
        if (this.attributeArgs(attr).length !== 1 || !name) {
            this.error(attr, "@builtin expects a builtin value name");
            return "";
        }
        const value = builtinValues.get(name);
        if (!value) {
            this.error(this.attributeArgs(attr)[0]!, `unknown builtin value '${name}'`);
            return "";
        }
        if (value.extension && !this.extensions.has(value.extension)) {
            this.error(
                attr,
                `use of @builtin(${name}) requires enabling extension '${value.extension}'`,
            );
            return "";
        }
        if (value.feature && !this.supportedFeatures.has(value.feature)) {
            this.error(
                attr,
                `use of @builtin(${name}) requires the '${value.feature}' language feature`,
            );
            return "";
        }
        if (!value.accepts(type)) {
            this.error(attr, builtinTypeMessage(name, type));
            return "";
        }
        return name;
    }

    /** Returns the identifier naming a context-dependent value in the attribute's argument, or empty. */
    private nameArgument(attr: number, index: number): string {
        const arg = this.attributeArgs(attr)[index];
        if (!arg || this.kinds[arg] !== Node.Ident || this.tree.firsts[arg]) return "";
        return this.text(arg);
    }

    /** Validates the interpolate attribute; returns the interpolation type or empty when invalid. */
    private interpolation(attr: number, type: Type): string {
        const args = this.attributeArgs(attr);
        const kind = this.nameArgument(attr, 0);
        if (args.length < 1 || args.length > 2 || !kind) {
            this.error(attr, "@interpolate expects an interpolation type and an optional sampling");
            return "";
        }
        if (!interpolationTypes.includes(kind)) {
            this.error(args[0]!, `invalid interpolation type '${kind}'`);
            return "";
        }
        let sampling = "";
        if (args.length === 2) {
            sampling = this.nameArgument(attr, 1);
            if (!interpolationSamplings.includes(sampling)) {
                this.error(
                    args[1]!,
                    `invalid interpolation sampling '${sampling || this.text(args[1]!)}'`,
                );
                return "";
            }
        }
        if (isIntegral(type) && kind !== "flat") {
            this.error(
                attr,
                "interpolation type must be 'flat' for integral user-defined IO types",
            );
            return "";
        }
        const firstOrEither = sampling === "first" || sampling === "either";
        if (sampling && kind === "flat" && !firstOrEither) {
            this.error(
                attr,
                "flat interpolation can only use 'first' and 'either' sampling parameters",
            );
            return "";
        }
        if (sampling && kind !== "flat" && firstOrEither) {
            this.error(
                attr,
                "'first' and 'either' sampling parameters can only be used with flat interpolation",
            );
            return "";
        }
        return kind;
    }

    private noArguments(attr: number): void {
        const { tree } = this;
        if (tree.ends[attr]! > tree.tokens.ends[tree.tokenOf[attr]!]!)
            this.error(attr, `@${this.text(attr)} does not take arguments`);
    }

    private hasLayout(type: Type): boolean {
        return (
            type.kind !== Kind.Texture && type.kind !== Kind.Sampler && type.kind !== Kind.Pointer
        );
    }

    private validMemberType(member: number, type: Type, last: boolean): boolean {
        const node = this.typeNode(member);
        if (type.kind === Kind.Array && type.count === 0) {
            if (!last) {
                this.error(node, "runtime arrays may only appear as the last member of a struct");
                return false;
            }
            return true;
        }
        if (isRuntimeSized(type) && type.kind === Kind.Struct) {
            this.error(
                node,
                "a struct that contains a runtime array cannot be nested inside another struct",
            );
            return false;
        }
        if (
            !isStorable(type) ||
            type.kind === Kind.Texture ||
            type.kind === Kind.Sampler ||
            type.kind === Kind.Buffer
        ) {
            this.error(node, `${typeName(type)} cannot be used as the type of a structure member`);
            return false;
        }
        if (!hasCreationFixedFootprint(type) && type.kind === Kind.Array) {
            this.error(
                node,
                "an array with an override element count cannot be used as the type of a structure member",
            );
            return false;
        }
        return true;
    }

    private typeNode(decl: number): number {
        const annotation = childOf(this.tree, decl, Node.Type);
        return annotation ? lastChild(this.tree, annotation) : decl;
    }

    /**
     * Validates the attributes of the node: their names, placement and duplicates;
     * returns the valid ones by name, except for the diagnostic attributes.
     */
    private attributes(
        node: number,
        target: Target,
        first = this.tree.firsts[node]!,
    ): Map<string, number> {
        const { tree } = this;
        const attrs = new Map<string, number>();
        const rules = new Map<string, string>();
        for (
            let attr = first;
            attr && this.kinds[attr] === Node.Attribute;
            attr = tree.nexts[attr]!
        ) {
            const name = this.text(attr);
            const allowed = placements[name];
            if (!allowed) {
                this.error(attr, `unknown attribute '@${name}'`);
                continue;
            }
            if (!allowed.includes(target)) {
                this.error(attr, `@${name} is not valid for ${targetNames[target]}`);
                continue;
            }
            if (
                (target === Target.Param || target === Target.Result) &&
                this.fnStage === Stages.None
            ) {
                const what = target === Target.Param ? "parameters" : "return types";
                this.error(attr, `@${name} is not valid for non-entry point function ${what}`);
                continue;
            }
            if (name === "diagnostic") {
                const severity = this.diagnosticControl(attr);
                const rule = childOf(tree, attr, Node.Rule);
                if (!severity || !rule) continue;
                const ruleText = this.ruleName(rule);
                const previous = rules.get(ruleText);
                if (previous !== undefined)
                    this.error(
                        rule,
                        previous === severity
                            ? "duplicate diagnostic attribute"
                            : "conflicting diagnostic attribute",
                    );
                else rules.set(ruleText, severity);
                continue;
            }
            if (attrs.has(name)) {
                this.error(attr, `duplicate ${name} attribute`);
                continue;
            }
            if (noArgumentAttributes.has(name)) this.noArguments(attr);
            attrs.set(name, attr);
        }
        return attrs;
    }

    /** Validates the attribute with a single integer argument; returns its value when known. */
    private attributeInt(attr: number, constant: boolean): number | undefined {
        const args = this.attributeArgs(attr);
        if (args.length !== 1) {
            this.error(attr, `@${this.text(attr)} expects a single argument`);
            for (const arg of args) this.value(arg);
            return undefined;
        }
        const arg = args[0]!;
        const type = this.value(arg);
        if (!type) return undefined;
        if (type.kind !== Kind.I32 && type.kind !== Kind.U32 && type.kind !== Kind.AbstractInt) {
            this.error(arg, `@${this.text(attr)} must be an i32 or u32 value`);
            return undefined;
        }
        const stage = this.stages[arg]!;
        if (constant ? stage !== Stage.Const : stage === Stage.Runtime) {
            this.error(
                arg,
                `@${this.text(attr)} requires a ${constant ? "const" : "override"}-expression`,
            );
            return undefined;
        }
        const value = this.convert(
            arg,
            type,
            type.kind === Kind.AbstractInt ? i32 : type,
            "convert",
        );
        return value === undefined ? undefined : Number(value);
    }

    private attributeArgs(attr: number): number[] {
        const { tree } = this;
        const args: number[] = [];
        for (let arg = tree.firsts[attr]!; arg; arg = tree.nexts[arg]!) args.push(arg);
        return args;
    }

    private constDecl(decl: number): void {
        this.attributes(decl, Target.None);
        const init = initializerOf(this.tree, decl);
        const annotated = this.typeAnnotation(decl);
        if (childOf(this.tree, decl, Node.Type) && !annotated) return;
        if (!init) return;
        let type = this.value(init);
        if (!type) return;
        if (this.stages[init] !== Stage.Const) {
            this.error(init, "'const' initializer must be a const-expression");
            return;
        }
        let value = this.values[init] as Value | undefined;
        if (annotated) {
            value = this.convert(init, type, annotated, "initialize");
            if (value === undefined && this.values[init] !== undefined) return;
            type = annotated;
        }
        if (!isConstructible(type)) {
            this.error(init, `type '${typeName(type)}' cannot be used in a 'const' declaration`);
            return;
        }
        this.types[decl] = type;
        this.values[decl] = value;
        this.stages[decl] = Stage.Const;
    }

    private override(decl: number): void {
        const { tree } = this;
        const attrs = this.attributes(decl, Target.Override);
        const init = initializerOf(tree, decl);
        let type = this.typeAnnotation(decl);
        if (childOf(tree, decl, Node.Type) && !type) return;
        if (!type && !init) {
            this.error(
                this.nameNode(decl),
                "override declarations require a type or an initializer",
            );
            return;
        }
        let value: Value | undefined;
        if (init) {
            const initType = this.value(init);
            if (!initType) return;
            if (this.stages[init] === Stage.Runtime) {
                this.error(init, "'override' initializer must be an override-expression");
                return;
            }
            if (type) value = this.convert(init, initType, type, "initialize");
            else {
                type = concretize(initType);
                value = this.convert(init, initType, type, "initialize");
            }
        }
        if (!type) return;
        if (!isScalar(type) || isAbstract(type)) {
            this.error(
                this.typeNode(decl),
                `override type must be a scalar, got '${typeName(type)}'`,
            );
            return;
        }
        const idAttr = attrs.get("id");
        if (idAttr) {
            const id = this.attributeInt(idAttr, true);
            if (id !== undefined) {
                if (id < 0 || id > 65535)
                    this.error(idAttr, "@id value must be between 0 and 65535");
                else if (this.overrideIds.has(id)) this.error(idAttr, `@id values must be unique`);
                else this.overrideIds.set(id, decl);
            }
        }
        this.types[decl] = type;
        this.values[decl] = value;
        this.stages[decl] = Stage.Override;
    }

    private globalVar(decl: number): void {
        const attrs = this.attributes(decl, Target.Var);
        const type = this.varDecl(decl, true);
        const groupAttr = attrs.get("group");
        const bindingAttr = attrs.get("binding");
        const group = groupAttr ? this.attributeInt(groupAttr, true) : undefined;
        const binding = bindingAttr ? this.attributeInt(bindingAttr, true) : undefined;
        if (group !== undefined && group < 0)
            this.error(groupAttr!, "@group value must be non-negative");
        if (binding !== undefined && binding < 0)
            this.error(bindingAttr!, "@binding value must be non-negative");
        if (!type) return;
        const space = type.space!;
        const resource = space === "uniform" || space === "storage" || space === "handle";
        if (resource && (!groupAttr || !bindingAttr))
            this.error(
                this.nameNode(decl),
                "resource variables require @group and @binding attributes",
            );
        else if (!resource && (groupAttr || bindingAttr))
            this.error(
                this.nameNode(decl),
                "non-resource variables must not have @group or @binding attributes",
            );
        else if (group !== undefined && binding !== undefined && group >= 0 && binding >= 0)
            this.bindings.set(decl, `${group}:${binding}`);
    }

    /** Checks a variable declaration; returns the reference type of the variable. */
    private varDecl(decl: number, global: boolean): Type | undefined {
        const { tree } = this;
        const template = childOf(tree, decl, Node.Template);
        let space: AddressSpace | undefined;
        let access: Access | undefined;
        if (template) {
            const args = this.attributeArgs(template);
            const spaceArg = args[0];
            if (spaceArg) {
                const name = this.enumerant(spaceArg, "address space");
                if (name) {
                    if (
                        name === "immediate" &&
                        !this.supportedFeatures.has("immediate_address_space")
                    )
                        this.error(spaceArg, "the immediate address space is not supported");
                    space = name as AddressSpace;
                }
            }
            const accessArg = args[1];
            if (accessArg) {
                const name = this.enumerant(accessArg, "access");
                if (name) access = name as Access;
                if (space && space !== "storage") {
                    this.error(
                        accessArg,
                        "only variables in <storage> address space may specify an access mode",
                    );
                    access = undefined;
                }
            }
            if (args.length > 2) this.error(args[2]!, "'var' template list has too many arguments");
            if (args.length === 0 || (spaceArg && !space)) return undefined;
        }
        const annotated = this.typeAnnotation(decl);
        if (childOf(tree, decl, Node.Type) && !annotated) return undefined;
        const init = initializerOf(tree, decl);
        let initType: Type | undefined;
        if (init) {
            initType = this.value(init);
            if (!initType) return undefined;
        }
        let store = annotated;
        if (!store) {
            if (!initType) {
                this.error(this.nameNode(decl), "'var' declaration requires a type or initializer");
                return undefined;
            }
            store = concretize(initType);
        }
        if (!space) space = global ? (isHandle(store) ? "handle" : undefined) : "function";
        if (!space) {
            this.error(
                this.nameNode(decl),
                "module-scope 'var' declarations that are not of texture or sampler types must provide an address space",
            );
            return undefined;
        }
        if (global && space === "function") {
            this.error(template!, "module-scope 'var' must not use address space 'function'");
            return undefined;
        }
        if (!global && space !== "function") {
            this.error(
                template!,
                `function-scope 'var' declaration must use 'function' address space`,
            );
            return undefined;
        }
        if (isHandle(store) && space !== "handle") {
            this.error(
                template ?? decl,
                `variables of type '${typeName(store)}' must not specify an address space`,
            );
            return undefined;
        }
        access ??=
            space === "storage" ||
            space === "uniform" ||
            space === "handle" ||
            space === "immediate"
                ? "read"
                : "read_write";
        const storeNode = childOf(tree, decl, Node.Type)
            ? this.typeNode(decl)
            : this.nameNode(decl);
        if (!this.validStoreType(storeNode, store, space, access, true)) return undefined;
        if (init && initType) {
            if (space !== "function" && space !== "private") {
                this.error(init, `var of address space '${space}' cannot have an initializer`);
                return undefined;
            }
            if (global && this.stages[init] === Stage.Runtime) {
                this.error(
                    init,
                    "module-scope 'var' initializer must be a const-expression or override-expression",
                );
                return undefined;
            }
            this.convert(init, initType, store, "initialize");
        }
        const type = reference(space, store, access);
        this.types[decl] = type;
        this.stages[decl] = Stage.Runtime;
        return type;
    }

    /** Validates the store type of a variable or pointer in the address space with the access mode. */
    private validStoreType(
        node: number,
        store: Type,
        space: AddressSpace,
        access: Access,
        variable: boolean,
    ): boolean {
        if (!isStorable(store)) {
            this.error(
                node,
                `'${typeName(store)}' cannot be used as the store type of a ${variable ? "var" : "pointer"}`,
            );
            return false;
        }
        if (variable && space === "function" && !isConstructible(store)) {
            this.error(node, "function-scope 'var' must have a constructible type");
            return false;
        }
        if (variable && space !== "storage" && space !== "handle" && !hasFixedFootprint(store)) {
            this.error(
                node,
                `variables in the '${space}' address space must have a fixed footprint`,
            );
            return false;
        }
        return (
            this.addressSpaceUsage(node, store, space) &&
            this.accessInSpace(node, store, access, space)
        );
    }

    /**
     * Validates the use of the type in the address space, or in a value declaration when
     * undefined; reports the problems of the struct members at their types, noting the use.
     */
    private addressSpaceUsage(
        node: number,
        type: Type,
        space: AddressSpace | undefined,
        use = node,
    ): boolean {
        const fail = (message: string): boolean => {
            const where = space ? `in the '${space}' address space` : "in a value declaration";
            this.report(
                node,
                message,
                "error",
                use === node ? undefined : [use, `used ${where} here`],
            );
            return false;
        };
        switch (type.kind) {
            case Kind.Struct:
                return type.members.every(m =>
                    this.addressSpaceUsage(
                        m.node ? this.typeNode(m.node) : node,
                        m.type,
                        space,
                        use,
                    ),
                );
            case Kind.Array:
                if (type.count === 0) {
                    if (this.supportedFeatures.has("buffer_view")) {
                        if (space !== "storage" && space !== "uniform" && space !== "workgroup")
                            return fail(
                                space
                                    ? `runtime-sized arrays cannot be used in the <${space}> address space`
                                    : "runtime-sized arrays must be used with an address space",
                            );
                    } else if (space !== "storage")
                        return fail(
                            "runtime-sized arrays can only be used in the <storage> address space",
                        );
                }
                if (space !== "storage" && type.count >= maxArrayElementCount)
                    return fail(
                        `array count (${type.count}) must be less than ${maxArrayElementCount}`,
                    );
                if (space !== "workgroup" && type.count < 0)
                    return fail(
                        "override-sized arrays can only be used in the <workgroup> address space",
                    );
                if (space === "immediate")
                    return fail("arrays cannot be used in the <immediate> address space");
                return this.addressSpaceUsage(node, type.elem!, space, use);
            case Kind.Buffer:
                if (space !== "storage" && space !== "uniform" && space !== "workgroup")
                    return fail(
                        `buffer types cannot be declared in the '${space ?? "function"}' address space`,
                    );
                if (space !== "workgroup" && type.count < 0)
                    return fail(
                        "override-sized buffers can only be used in the 'workgroup' address space",
                    );
                return true;
            case Kind.Atomic:
                if (space !== "storage" && type.elem!.kind === Kind.Vector)
                    return fail(
                        `atomic variables of type '${typeName(type.elem!)}' can only be in 'storage' address space`,
                    );
                break;
        }
        if (
            (space === "uniform" || space === "storage" || space === "immediate") &&
            !isHostShareable(type)
        )
            return fail(
                `type '${typeName(type)}' cannot be used in address space '${space}' as it is non-host-shareable`,
            );
        return true;
    }

    /** Validates the access mode and the atomics of the store type in the address space. */
    private accessInSpace(node: number, store: Type, access: Access, space: AddressSpace): boolean {
        if (space === "immediate" && !this.supportedFeatures.has("immediate_address_space")) {
            this.error(
                node,
                "the 'immediate' address space requires the immediate_address_space language feature",
            );
            return false;
        }
        if (space === "storage" && access === "write") {
            this.error(node, "access mode 'write' is not valid for the 'storage' address space");
            return false;
        }
        if (containsAtomic(store)) {
            if (space !== "storage" && space !== "workgroup") {
                this.error(
                    node,
                    "atomic variables must have 'storage' or 'workgroup' address space",
                );
                return false;
            }
            if (space === "storage" && access !== "read_write") {
                this.error(
                    node,
                    "atomic variables in 'storage' address space must have 'read_write' access mode",
                );
                return false;
            }
        }
        return true;
    }

    private function(decl: number): void {
        const { tree } = this;
        this.fnStage = Stages.None;
        const attrs = this.attributes(decl, Target.Function);
        let stage = Stages.None;
        for (const [name, bit] of stageAttributes) {
            const attr = attrs.get(name);
            if (!attr) continue;
            if (stage) this.error(attr, "functions must have at most one shader stage attribute");
            else stage = bit;
        }
        this.fnStage = stage;
        const params: Type[] = [];
        const inputs: IoGroup[] = [];
        for (let node = tree.firsts[decl]!; node; node = tree.nexts[node]!) {
            if (this.kinds[node] !== Node.Param) continue;
            const paramAttrs = this.attributes(node, Target.Param);
            const type = this.typeAnnotation(node) ?? errorType;
            this.types[node] = type;
            this.stages[node] = Stage.Runtime;
            params.push(type);
            if (type === errorType) continue;
            this.validParamType(node, type);
            const io = this.io(node, type, paramAttrs);
            if (stage) inputs.push(this.ioGroup(node, type, io));
        }
        const resultNode = childOf(tree, decl, Node.Result);
        let result = voidType;
        let output: IoGroup | undefined;
        if (resultNode) {
            const resultAttrs = this.attributes(resultNode, Target.Result);
            const typeNode = lastChild(tree, resultNode);
            result = this.type(typeNode) ?? errorType;
            if (result !== errorType) {
                if (!isConstructible(result))
                    this.error(typeNode, `function return type must be a constructible type`);
                const io = this.io(typeNode, result, resultAttrs);
                if (stage) output = this.ioGroup(typeNode, result, io);
            }
        }
        const mustUse = attrs.get("must_use");
        if (mustUse && result === voidType)
            this.error(mustUse, "@must_use can only be applied to functions that return a value");
        const workgroup = attrs.get("workgroup_size");
        if (workgroup && stage !== Stages.Compute)
            this.error(workgroup, "@workgroup_size is only valid for compute stages");
        const subgroup = attrs.get("subgroup_size");
        if (subgroup) {
            if (!this.extensions.has("subgroup_size_control"))
                this.error(
                    subgroup,
                    "use of @subgroup_size requires enabling extension 'subgroup_size_control'",
                );
            else if (stage !== Stages.Compute)
                this.error(subgroup, "@subgroup_size is only valid for compute stages");
            else this.subgroupSize(subgroup);
        }
        const info: FunctionInfo = {
            node: decl,
            name: this.name(decl),
            params,
            result,
            stage,
            mustUse: !!mustUse,
            callees: new Set(),
            globals: new Set(),
            stages: Stages.All,
            restriction: 0,
            workgroupSize: undefined,
        };
        this.functions.set(decl, info);
        this.types[decl] = result;
        this.fn = info;
        this.access = {
            globalReads: new Map(),
            globalWrites: new Map(),
            paramReads: new Set(),
            paramWrites: new Set(),
        };
        this.accesses.set(decl, this.access);
        const body = childOf(tree, decl, Node.Block);
        if (body) {
            const behavior = this.block(body);
            if (result !== voidType && behavior & Behavior.Next)
                this.error(this.closingBrace(body), "missing return at end of function");
        }
        this.fn = undefined;
        this.access = undefined;
        if (stage) this.entryPoint(info, inputs, output, workgroup);
        this.fnStage = Stages.None;
    }

    private ioGroup(
        node: number,
        type: Type,
        io: Io | undefined,
    ): { io: Io; members: Io[] | undefined } {
        return {
            io: io ?? {
                node,
                type,
                builtin: "",
                builtinAttr: 0,
                location: -1,
                locationAttr: 0,
                blendSrc: -1,
                blendSrcAttr: 0,
                interpolation: "",
                interpolateAttr: 0,
                invariantAttr: 0,
            },
            members: type.kind === Kind.Struct ? this.memberIos.get(type) : undefined,
        };
    }

    private closingBrace(block: number): number {
        return block;
    }

    private validParamType(param: number, type: Type): void {
        const node = this.typeNode(param);
        if (type.kind === Kind.Pointer) {
            const space = type.space!;
            if (
                space === "handle" ||
                (!this.supportedFeatures.has("unrestricted_pointer_parameters") &&
                    space !== "function" &&
                    space !== "private")
            )
                this.error(
                    node,
                    `function parameter of pointer type cannot be in '${space}' address space`,
                );
            return;
        }
        if (isHandle(type)) return;
        if (!isConstructible(type)) {
            if (
                type.kind === Kind.Atomic ||
                type.kind === Kind.Buffer ||
                containsAtomic(type) ||
                isRuntimeSized(type)
            )
                this.error(node, `type of function parameter cannot be '${typeName(type)}'`);
            else this.error(node, `type of function parameter must be constructible`);
        }
    }

    private entryPoint(
        info: FunctionInfo,
        inputs: readonly IoGroup[],
        output: IoGroup | undefined,
        workgroup: number | undefined,
    ): void {
        const decl = info.node;
        const error = (node: number, message: string): void => this.error(node, message);
        if (info.stage === Stages.Compute) {
            if (!workgroup)
                this.error(
                    this.nameNode(decl),
                    "a compute shader must include '@workgroup_size' in its attributes",
                );
            else this.workgroupSize(workgroup, info);
            if (info.result !== voidType)
                this.error(this.nameNode(decl), "compute entry point must not have a return type");
        }
        validateIo(info.stage, inputs, true, error);
        const outputs = validateIo(info.stage, output ? [output] : [], false, error);
        if (info.stage === Stages.Vertex && !outputs.has("position") && info.result !== errorType)
            this.error(
                this.nameNode(decl),
                "a vertex shader must include the 'position' builtin in its return type",
            );
        if (!(info.stages & info.stage) && info.restriction) {
            const stage = stageName(info.stage);
            let n = info.restriction;
            while (n && n !== info.node) n = this.tree.parents[n]!;
            const note: [number, string] = [
                this.nameNode(info.node),
                `called from the ${stage} entry point '${info.name}'`,
            ];
            this.report(
                info.restriction,
                `cannot be used in a ${stage} entry point`,
                "error",
                n ? undefined : note,
            );
        }
        const globals = this.transitiveGlobals(info);
        const bindings = new Map<string, number>();
        let immediate = 0;
        for (const global of globals) {
            if (this.kinds[global] !== Node.Var) continue;
            const binding = this.bindings.get(global);
            if (binding !== undefined) {
                if (bindings.has(binding)) {
                    const [group, index] = binding.split(":");
                    this.error(
                        this.nameNode(global),
                        `entry point '${info.name}' references multiple variables that use the same resource binding @group(${group}), @binding(${index})`,
                    );
                } else bindings.set(binding, global);
            }
            if (this.types[global]?.space === "immediate") {
                if (immediate)
                    this.error(
                        this.nameNode(global),
                        `entry point '${info.name}' uses two different 'immediate' variables`,
                    );
                immediate = global;
            }
        }
    }

    /** Returns the module-scope declarations referenced by the function and the functions it calls. */
    private transitiveGlobals(info: FunctionInfo): Set<number> {
        const globals = new Set<number>();
        const visited = new Set<number>();
        const visit = (fn: FunctionInfo): void => {
            if (visited.has(fn.node)) return;
            visited.add(fn.node);
            for (const global of fn.globals) globals.add(global);
            for (const callee of fn.callees) {
                const calleeInfo = this.functions.get(callee);
                if (calleeInfo) visit(calleeInfo);
            }
        };
        visit(info);
        return globals;
    }

    private subgroupSize(attr: number): void {
        const args = this.attributeArgs(attr);
        if (args.length !== 1) {
            this.error(attr, "@subgroup_size expects a single argument");
            return;
        }
        const arg = args[0]!;
        const type = this.value(arg);
        if (!type) return;
        if (type.kind !== Kind.I32 && type.kind !== Kind.U32 && type.kind !== Kind.AbstractInt) {
            this.error(arg, "@subgroup_size must be an i32 or u32 value");
            return;
        }
        if (this.stages[arg] === Stage.Runtime) {
            this.error(arg, "@subgroup_size requires a const-expression or an override-expression");
            return;
        }
        const value = this.values[arg];
        if (this.stages[arg] !== Stage.Const || value === undefined) return;
        const size = Number(value);
        if (size < 1 || (size & (size - 1)) !== 0)
            this.error(arg, "@subgroup_size must be a positive power of two");
    }

    private workgroupSize(attr: number, info: FunctionInfo): void {
        const args = this.attributeArgs(attr);
        if (args.length < 1 || args.length > 3) {
            this.error(attr, "@workgroup_size requires 1 to 3 arguments");
            for (const arg of args) this.value(arg);
            return;
        }
        const sizes: number[] = [];
        let common: Type | undefined;
        let known = true;
        const message =
            "workgroup_size argument must be either a literal, constant, or overridable of type abstract-int, i32 or u32";
        for (const arg of args) {
            const type = this.value(arg);
            if (!type) return;
            if (
                type.kind !== Kind.I32 &&
                type.kind !== Kind.U32 &&
                type.kind !== Kind.AbstractInt
            ) {
                this.error(arg, message);
                return;
            }
            if (
                common &&
                type.kind !== Kind.AbstractInt &&
                common.kind !== Kind.AbstractInt &&
                common !== type
            ) {
                this.error(
                    arg,
                    "workgroup_size arguments must be of the same type, either i32 or u32",
                );
                return;
            }
            if (type.kind !== Kind.AbstractInt) common = type;
            if (this.stages[arg] === Stage.Runtime) {
                this.error(arg, message);
                return;
            }
            const value = this.values[arg];
            if (value === undefined || this.stages[arg] !== Stage.Const) {
                known = false;
                continue;
            }
            const size = Number(value);
            if (size < 1) {
                this.error(arg, "workgroup_size argument must be at least 1");
                return;
            }
            sizes.push(size);
        }
        if (known) info.workgroupSize = sizes;
    }

    private constAssert(node: number): void {
        const expr = this.tree.firsts[node]!;
        const type = this.value(expr);
        if (!type) return;
        if (type.kind !== Kind.Bool) {
            this.error(expr, `const assertion condition must be a bool, got '${typeName(type)}'`);
            return;
        }
        if (this.stages[expr] !== Stage.Const) {
            this.error(expr, "const assertion requires a const-expression");
            return;
        }
        if (this.values[expr] === false) this.error(node, "const assertion failed");
    }

    // ---- types ----

    /** Evaluates the expression as a type; reports and returns undefined when it isn't one. */
    private type(node: number): Type | undefined {
        if (this.sems[node] !== Sem.None)
            return this.sems[node] === Sem.Type ? this.types[node] : undefined;
        const kind = this.kinds[node];
        if (kind === Node.Error) {
            this.sems[node] = Sem.Error;
            return undefined;
        }
        if (kind !== Node.Ident) {
            this.error(node, "expected a type");
            this.sems[node] = Sem.Error;
            return undefined;
        }
        const sem = this.ident(node);
        if (sem === Sem.Type) {
            const type = this.types[node];
            if (!type) {
                this.error(node, `expected template arguments for '${this.text(node)}'`);
                this.sems[node] = Sem.Error;
            }
            return type;
        }
        if (sem !== Sem.Error) this.error(node, `'${this.text(node)}' is not a type`);
        return undefined;
    }

    /** Builds the type named by the predeclared identifier with its template arguments. */
    private predeclaredType(node: number, name: string): Type | undefined {
        const { tree } = this;
        const args: number[] = [];
        for (let arg = tree.firsts[node]!; arg; arg = tree.nexts[arg]!) args.push(arg);
        const simple = predeclaredTypes.get(name);
        if (simple) {
            if (args.length > 0) {
                this.error(node, `type '${name}' does not take template arguments`);
                return undefined;
            }
            if ((name === "f16" || isF16Alias(name)) && !this.extensions.has("f16")) {
                this.error(node, "f16 type used without 'f16' extension enabled");
                return undefined;
            }
            return simple;
        }
        if (args.length === 0)
            return name === "buffer" && this.supportedFeatures.has("buffer_view")
                ? unsizedBuffer
                : undefined;
        const typeArg = (i: number): Type | undefined => {
            const arg = args[i];
            return arg === undefined ? undefined : this.type(arg);
        };
        const count = (n: number): boolean => {
            if (args.length === n) return true;
            this.error(node, `'${name}' requires ${n} template argument${n > 1 ? "s" : ""}`);
            return false;
        };
        if (name.startsWith("vec")) {
            if (!count(1)) return undefined;
            const elem = typeArg(0);
            if (!elem) return undefined;
            if (!isScalar(elem)) {
                this.error(args[0]!, "vector element type must be a scalar type");
                return undefined;
            }
            return vec(+name[3]!, elem);
        }
        if (name.startsWith("mat")) {
            if (!count(1)) return undefined;
            const elem = typeArg(0);
            if (!elem) return undefined;
            if (elem.kind !== Kind.F32 && elem.kind !== Kind.F16) {
                this.error(args[0]!, "matrix element type must be 'f32' or 'f16'");
                return undefined;
            }
            return mat(+name[3]!, +name[5]!, elem);
        }
        switch (name) {
            case "atomic": {
                if (!count(1)) return undefined;
                const elem = typeArg(0);
                if (!elem) return undefined;
                const vec2u = elem === vec(2, u32) && this.extensions.has("atomic_vec2u_min_max");
                if (elem.kind !== Kind.I32 && elem.kind !== Kind.U32 && !vec2u) {
                    this.error(args[0]!, "atomic only supports i32 or u32 types");
                    return undefined;
                }
                return atomic(elem);
            }
            case "array":
                return this.arrayType(node, args);
            case "ptr": {
                if (args.length < 2 || args.length > 3) {
                    this.error(node, "'ptr' requires 2 or 3 template arguments");
                    return undefined;
                }
                const space = this.enumerant(args[0]!, "address space") as AddressSpace | undefined;
                const store = typeArg(1);
                let access: Access | undefined;
                if (args.length === 3) {
                    access = this.enumerant(args[2]!, "access") as Access | undefined;
                    if (!access) return undefined;
                    if (space && space !== "storage") {
                        this.error(
                            args[2]!,
                            "only pointers in <storage> address space may specify an access mode",
                        );
                        return undefined;
                    }
                }
                if (!space || !store) return undefined;
                if (
                    space === "immediate" &&
                    !this.supportedFeatures.has("immediate_address_space")
                ) {
                    this.error(args[0]!, "the immediate address space is not supported");
                    return undefined;
                }
                if (isHandle(store)) {
                    this.error(
                        args[1]!,
                        `pointer can not be formed to handle type '${typeName(store)}'`,
                    );
                    return undefined;
                }
                access ??=
                    space === "storage" || space === "uniform" || space === "immediate"
                        ? "read"
                        : "read_write";
                if (!this.validStoreType(args[1]!, store, space, access, false)) return undefined;
                return pointer(space, store, access);
            }
            case "buffer": {
                if (!this.supportedFeatures.has("buffer_view")) return undefined;
                if (!count(1)) return undefined;
                const size = this.arrayCount(args[0]!);
                if (size === undefined) return undefined;
                if (size === -1) return overrideBuffer(this.overrideKey(args[0]!), this.interned);
                const align = this.extensions.has("f16") ? 2 : 4;
                if (size % align !== 0) {
                    this.error(args[0]!, `buffer size must be a multiple of ${align}`);
                    return undefined;
                }
                return buffer(size);
            }
        }
        if (name.startsWith("texture_storage")) {
            if (!count(2)) return undefined;
            const format = this.enumerant(args[0]!, "texel format");
            const access = this.enumerant(args[1]!, "access") as Access | undefined;
            if (!format || !access) return undefined;
            if (
                access !== "write" &&
                !this.supportedFeatures.has("readonly_and_readwrite_storage_textures")
            ) {
                this.error(args[1]!, `storage texture access mode '${access}' is not supported`);
                return undefined;
            }
            if (
                !storageFormats.has(format) &&
                !(tier1Formats.has(format) && this.supportedFeatures.has("texture_formats_tier1"))
            ) {
                this.error(args[0]!, `'${format}' is not a valid storage texture format`);
                return undefined;
            }
            return storageTexture(name, format, access);
        }
        if (name.startsWith("texture")) {
            if (!count(1)) return undefined;
            const sampled = typeArg(0);
            if (!sampled) return undefined;
            if (
                sampled.kind !== Kind.F32 &&
                sampled.kind !== Kind.I32 &&
                sampled.kind !== Kind.U32
            ) {
                this.error(args[0]!, "texture sampled type must be f32, i32 or u32");
                return undefined;
            }
            return sampledTexture(name, sampled);
        }
        return undefined;
    }

    private arrayType(node: number, args: readonly number[]): Type | undefined {
        if (args.length < 1 || args.length > 2) {
            this.error(node, "'array' requires 1 or 2 template arguments");
            return undefined;
        }
        const elem = this.type(args[0]!);
        if (!elem) return undefined;
        if (
            !isStorable(elem) ||
            isHandle(elem) ||
            elem.kind === Kind.Buffer ||
            !hasFixedFootprint(elem)
        ) {
            this.error(
                args[0]!,
                `'${typeName(elem)}' cannot be used as an element type of an array`,
            );
            return undefined;
        }
        if (elem.kind === Kind.Array && elem.count < 0) {
            this.error(
                args[0]!,
                "array with an override element count cannot be an element type of an array",
            );
            return undefined;
        }
        if (args.length === 1) return array(elem);
        const count = this.arrayCount(args[1]!);
        if (count === undefined) return undefined;
        if (count === -1) return overrideArray(elem, this.overrideKey(args[1]!), this.interned);
        return array(elem, count);
    }

    /** Evaluates an array element count or buffer size; returns -1 for override-expressions. */
    private arrayCount(node: number): number | undefined {
        const skipEval = this.skipEval;
        this.skipEval = 0;
        const type = this.value(node);
        this.skipEval = skipEval;
        if (!type) return undefined;
        if (type.kind !== Kind.I32 && type.kind !== Kind.U32 && type.kind !== Kind.AbstractInt) {
            this.error(
                node,
                "array count must evaluate to a constant integer expression or override variable",
            );
            return undefined;
        }
        const stage = this.stages[node];
        if (stage === Stage.Runtime) {
            this.error(
                node,
                "array count must evaluate to a constant integer expression or override variable",
            );
            return undefined;
        }
        if (stage === Stage.Override) return -1;
        const value = this.values[node];
        if (value === undefined) return undefined;
        const count = Number(value);
        if (count < 1) {
            this.error(node, `array count (${count}) must be greater than 0`);
            return undefined;
        }
        return count;
    }

    /** Returns the key identifying an override-sized array count: the override or the expression. */
    private overrideKey(node: number): number {
        const inner = this.unparen(node);
        if (this.kinds[inner] === Node.Ident) {
            const decl = this.refs[inner]!;
            if (decl && this.kinds[decl] === Node.Override) return decl;
        }
        return node;
    }

    private unparen(node: number): number {
        while (this.kinds[node] === Node.Paren) node = this.tree.firsts[node]!;
        return node;
    }

    /** Evaluates the expression as an enumerant of the enum; reports and returns undefined otherwise. */
    private enumerant(
        node: number,
        kind: "access" | "address space" | "texel format",
    ): string | undefined {
        const sem = this.expr(node);
        if (sem === Sem.Error) return undefined;
        const name = sem === Sem.Enum ? (this.values[node] as string) : undefined;
        if (name === undefined || enumOf(name) !== kind) {
            this.error(node, `expected ${kind === "access" ? "access mode" : kind}`);
            return undefined;
        }
        return name;
    }

    // ---- statements ----

    private block(node: number): number {
        const { tree } = this;
        this.statementAttributes(node);
        let behavior = Behavior.Next;
        for (let stmt = tree.firsts[node]!; stmt; stmt = tree.nexts[stmt]!) {
            if (this.kinds[stmt] === Node.Attribute) continue;
            const b = this.statement(stmt);
            if (behavior & Behavior.Next) behavior = (behavior & ~Behavior.Next) | b;
        }
        this.behaviors[node] = behavior;
        return behavior;
    }

    private statementAttributes(node: number): void {
        this.attributes(node, Target.Statement);
    }

    private statement(node: number): number {
        const behavior = this.statementBehavior(node);
        this.behaviors[node] = behavior;
        return behavior;
    }

    private statementBehavior(node: number): number {
        const { tree } = this;
        switch (this.kinds[node]) {
            case Node.Block:
                return this.block(node);
            case Node.Var:
                this.localVar(node);
                return Behavior.Next;
            case Node.Let:
                this.letDecl(node);
                return Behavior.Next;
            case Node.Const:
                this.constDecl(node);
                return Behavior.Next;
            case Node.ConstAssert:
                this.constAssert(node);
                return Behavior.Next;
            case Node.Assign:
                this.assign(node);
                return Behavior.Next;
            case Node.IncDec:
                this.incDec(node);
                return Behavior.Next;
            case Node.Call:
                this.callStatement(node);
                return Behavior.Next;
            case Node.Return:
                this.returnStatement(node);
                return Behavior.Return;
            case Node.Discard:
                this.restrict(Stages.Fragment, node);
                return Behavior.Next;
            case Node.Break:
                this.breakStatement(node);
                return Behavior.Break;
            case Node.Continue:
                this.continueStatement(node);
                return Behavior.Continue;
            case Node.BreakIf:
                this.condition(tree.firsts[node]!, "break-if");
                return Behavior.Break | Behavior.Next;
            case Node.If:
                return this.ifStatement(node);
            case Node.Switch:
                return this.switchStatement(node);
            case Node.Loop:
                return this.loop(node);
            case Node.For:
                return this.forLoop(node);
            case Node.While:
                return this.whileLoop(node);
            default:
                return Behavior.Next;
        }
    }

    private localVar(decl: number): void {
        this.attributes(decl, Target.None);
        this.varDecl(decl, false);
    }

    private letDecl(decl: number): void {
        this.attributes(decl, Target.None);
        const init = initializerOf(this.tree, decl);
        const annotated = this.typeAnnotation(decl);
        if (childOf(this.tree, decl, Node.Type) && !annotated) return;
        if (!init) return;
        const initType = this.value(init);
        if (!initType) return;
        let type = annotated ?? concretize(initType);
        let value = this.values[init] as Value | undefined;
        if (initType !== type) value = this.convert(init, initType, type, "initialize");
        if (type.kind === Kind.Void) {
            this.error(init, "cannot use a function without a return value as an initializer");
            return;
        }
        const handle = isHandle(type) && this.supportedFeatures.has("texture_and_sampler_let");
        if (!isConstructible(type) && type.kind !== Kind.Pointer && !handle) {
            this.error(init, `type '${typeName(type)}' cannot be used in a 'let' declaration`);
            type = errorType;
        }
        this.types[decl] = type;
        this.values[decl] = this.stages[init] === Stage.Const ? value : undefined;
        this.stages[decl] = Stage.Runtime;
    }

    private assign(node: number): void {
        const { tree } = this;
        const lhs = tree.firsts[node]!;
        const rhs = tree.nexts[lhs]!;
        const op = tree.tokens.kinds[tree.tokenOf[node]!] as Tok;
        if (this.kinds[lhs] === Node.Phony) {
            const type = this.value(rhs);
            if (!type) return;
            if (type.kind === Kind.Void) {
                this.error(rhs, "cannot assign a function without a return value");
                return;
            }
            if (!isConstructible(type) && type.kind !== Kind.Pointer && !isHandle(type))
                this.error(rhs, `cannot assign '${typeName(type)}' to '_'`);
            return;
        }
        const target = this.reference(lhs, true);
        const rhsType = this.value(rhs);
        if (!target || !rhsType) return;
        const store = target.elem!;
        if (op === Tok.Equal) {
            if (!isConstructible(store)) {
                this.error(lhs, `cannot assign to a value of type '${typeName(store)}'`);
                return;
            }
            this.convert(rhs, rhsType, store, "assign");
            return;
        }
        const operator = compoundOperators.get(op)!;
        const res = this.resolve(operatorOverloads(operator, 2), [], [store, rhsType], false);
        if (!res) {
            this.error(
                node,
                `no matching overload for operator ${operator}= (${typeName(store)}, ${typeName(rhsType)})`,
            );
            return;
        }
        if (res.result !== store)
            this.error(node, `cannot assign '${typeName(res.result)}' to '${typeName(store)}'`);
        this.shiftCheck(operator, store, rhs);
        this.divisionCheck(operator, store, rhs);
    }

    /**
     * Checks the expression as a writable memory view, or a swizzle view when assigning;
     * returns its type.
     */
    private reference(node: number, assignment = false): Type | undefined {
        const sem = this.expr(node);
        if (sem === Sem.Error) return undefined;
        const type = this.types[node];
        const swizzle =
            type?.kind === Kind.Swizzle &&
            assignment &&
            this.supportedFeatures.has("swizzle_assignment");
        if (sem !== Sem.Value || !type || (type.kind !== Kind.Reference && !swizzle)) {
            this.error(node, "cannot assign to value expression");
            return undefined;
        }
        if (swizzle && this.kinds[this.unparen(node)] === Node.Member) {
            const indices = this.swizzleTargets(this.unparen(node));
            if (new Set(indices).size !== indices.length) {
                this.error(
                    node,
                    "cannot assign to vector swizzle with duplicate target components",
                );
                return undefined;
            }
        }
        if (type.access === "read") {
            this.error(
                node,
                `cannot store into a read-only ${type.space === "handle" ? "handle" : "memory view"}`,
            );
            return undefined;
        }
        const root = this.rootIdentifier(node);
        if (
            root &&
            (this.kinds[root] === Node.Let ||
                this.kinds[root] === Node.Const ||
                this.kinds[root] === Node.Param) &&
            this.types[root]?.kind !== Kind.Pointer
        ) {
            this.error(node, "cannot assign to value expression");
            return undefined;
        }
        this.registerAccess(node, true);
        return type;
    }

    /** Returns the declaration of the variable or pointer the memory view expression originates from. */
    /** Returns the indices of the vector components a chain of swizzles selects. */
    private swizzleTargets(member: number): number[] {
        const indices = swizzleIndices(this.text(member));
        const base = this.unparen(this.tree.firsts[member]!);
        if (this.kinds[base] !== Node.Member || this.types[base]?.kind !== Kind.Swizzle)
            return indices;
        const inner = this.swizzleTargets(base);
        return indices.map(i => inner[i]!);
    }

    private rootIdentifier(node: number): number {
        const { tree } = this;
        while (true) {
            const kind = this.kinds[node];
            if (kind === Node.Ident) return this.refs[node]!;
            if (
                kind === Node.Paren ||
                kind === Node.Index ||
                kind === Node.Member ||
                kind === Node.Unary
            )
                node = tree.firsts[node]!;
            else return 0;
        }
    }

    private incDec(node: number): void {
        const lhs = this.tree.firsts[node]!;
        const target = this.reference(lhs);
        if (!target) return;
        const store = target.elem!;
        if (store.kind !== Kind.I32 && store.kind !== Kind.U32)
            this.error(
                node,
                `increment and decrement statements can only be applied to integers, got '${typeName(store)}'`,
            );
    }

    private callStatement(node: number): void {
        const sem = this.expr(node);
        if (sem !== Sem.Value) return;
        const resolution = this.overloads[node];
        const callee = this.tree.firsts[node]!;
        const decl = this.refs[callee]!;
        if (decl && this.kinds[decl] === Node.Function) {
            if (this.functions.get(decl)?.mustUse)
                this.error(
                    node,
                    `ignoring return value of function '${this.text(callee)}' annotated with @must_use`,
                );
        } else if (resolution) {
            if (resolution.overload.mustUse) {
                const what =
                    this.kinds[decl] === Node.Struct || !functionOverloads(this.text(callee))
                        ? "value constructor evaluated but not used"
                        : `ignoring return value of builtin '${this.text(callee)}'`;
                this.error(node, what);
            }
        } else if (this.types[node] !== voidType)
            this.error(node, "value constructor evaluated but not used");
    }

    private returnStatement(node: number): void {
        const fn = this.fn!;
        const expr = this.tree.firsts[node];
        if (this.scopes.includes(Scope.Continuing))
            this.error(node, "continuing blocks must not contain a return statement");
        if (!expr) {
            if (fn.result !== voidType && fn.result !== errorType)
                this.error(
                    node,
                    `missing return value, function '${fn.name}' returns '${typeName(fn.result)}'`,
                );
            return;
        }
        const type = this.value(expr);
        if (!type) return;
        if (fn.result === voidType) {
            this.error(
                expr,
                `unexpected return value, function '${fn.name}' does not return a value`,
            );
            return;
        }
        if (fn.result !== errorType) this.convert(expr, type, fn.result, "return");
    }

    private breakStatement(node: number): void {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            const scope = this.scopes[i];
            if (scope === Scope.Loop || scope === Scope.Switch) return;
            if (scope === Scope.Continuing) {
                this.error(
                    node,
                    "break statement in a continuing block must be in the form of 'break if'",
                );
                return;
            }
        }
        this.error(node, "break statement must be in a loop or switch case");
    }

    private continueStatement(node: number): void {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            const scope = this.scopes[i];
            if (scope === Scope.Loop) {
                this.continues[this.continues.length - 1]?.push(node);
                return;
            }
            if (scope === Scope.Continuing) {
                this.error(node, "continuing blocks must not contain a continue statement");
                return;
            }
        }
        this.error(node, "continue statement must be in a loop");
    }

    private condition(node: number, what: string): void {
        const type = this.value(node);
        if (type && type.kind !== Kind.Bool)
            this.error(node, `${what} condition must be bool, got '${typeName(type)}'`);
    }

    private ifStatement(node: number): number {
        const { tree } = this;
        this.statementAttributes(node);
        const cond = skipAttributes(tree, node);
        this.condition(cond, "if statement");
        const body = tree.nexts[cond]!;
        let behavior = body ? this.block(body) : Behavior.Next;
        const otherwise = body ? tree.nexts[body]! : 0;
        behavior |= otherwise ? this.statement(otherwise) : Behavior.Next;
        return behavior;
    }

    private switchStatement(node: number): number {
        const { tree } = this;
        let selector = 0;
        const clauses: number[] = [];
        this.statementAttributes(node);
        for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!) {
            const kind = this.kinds[child];
            if (kind === Node.Attribute) continue;
            if (kind === Node.Case) clauses.push(child);
            else if (!selector) {
                selector = child;
                this.attributes(node, Target.Statement, tree.nexts[child]!);
            }
        }
        let selectorType = this.value(selector);
        if (selectorType && !isIntegerScalarType(selectorType)) {
            this.error(
                selector,
                "switch statement selector expression must be of a scalar integer type",
            );
            selectorType = undefined;
        }
        const selectors: number[] = [];
        let defaults = 0;
        for (const clause of clauses)
            for (
                let s = tree.firsts[clause]!;
                s && this.kinds[s] !== Node.Block;
                s = tree.nexts[s]!
            ) {
                if (this.kinds[s] === Node.Default) {
                    if (++defaults > 1)
                        this.error(s, "switch statement must have exactly one default clause");
                } else selectors.push(s);
            }
        if (defaults === 0) this.error(node, "switch statement must have a default clause");
        let common = selectorType;
        const types: (Type | undefined)[] = [];
        for (const s of selectors) {
            const type = this.value(s);
            types.push(type);
            if (!type) continue;
            if (!isIntegerScalarType(type)) {
                this.error(s, "case selector must be an i32 or u32 value");
                continue;
            }
            if (this.stages[s] !== Stage.Const) {
                this.error(s, "case selector must be a const-expression");
                continue;
            }
            if (common) {
                const merged = commonType(common, type);
                if (!merged)
                    this.error(
                        s,
                        `the case selector values must have the same type as the selector expression`,
                    );
                else common = merged;
            } else common = type;
        }
        if (common && common.kind === Kind.AbstractInt) common = i32;
        const seen = new Map<string, number>();
        for (let i = 0; i < selectors.length; i++) {
            const s = selectors[i]!;
            const type = types[i];
            if (!type || !common || !isIntegerScalarType(type) || this.stages[s] !== Stage.Const)
                continue;
            const value = this.convert(s, type, common, "convert");
            if (value === undefined) continue;
            const key = String(value);
            if (seen.has(key)) this.error(s, `duplicate switch case '${key}'`);
            else seen.set(key, s);
        }
        let behavior = 0;
        this.scopes.push(Scope.Switch);
        for (const clause of clauses) {
            const body = lastChild(tree, clause);
            if (this.kinds[body] === Node.Block) behavior |= this.block(body);
        }
        this.scopes.pop();
        if (behavior & Behavior.Break) behavior = (behavior | Behavior.Next) & ~Behavior.Break;
        return behavior;
    }

    private loop(node: number): number {
        const { tree } = this;
        this.statementAttributes(node);
        const body = lastChild(tree, node);
        if (this.kinds[body] !== Node.Block) return Behavior.Next;
        this.scopes.push(Scope.Loop);
        this.continues.push([]);
        let behavior = Behavior.Next;
        let continuing = 0;
        this.statementAttributes(body);
        for (let stmt = tree.firsts[body]!; stmt; stmt = tree.nexts[stmt]!) {
            const kind = this.kinds[stmt];
            if (kind === Node.Attribute) continue;
            if (kind === Node.Continuing) {
                continuing = stmt;
                continue;
            }
            const b = this.statement(stmt);
            if (behavior & Behavior.Next) behavior = (behavior & ~Behavior.Next) | b;
        }
        this.behaviors[body] = behavior;
        const continues = this.continues.pop()!;
        this.scopes.pop();
        const onlyReturn = behavior === Behavior.Return;
        if (continuing) {
            const block = tree.firsts[continuing]!;
            this.scopes.push(Scope.Loop, Scope.Continuing);
            const b = this.continuingBlock(block);
            this.scopes.length -= 2;
            if (b & (Behavior.Return | Behavior.Continue)) {
                if (b & Behavior.Continue)
                    this.error(
                        continuing,
                        "continuing blocks must not contain a continue statement",
                    );
            }
            if (!onlyReturn) behavior |= b;
            this.bypassedDeclarations(body, block, continues);
        }
        if (behavior & Behavior.Break) behavior |= Behavior.Next;
        else behavior &= ~Behavior.Next;
        behavior &= ~(Behavior.Break | Behavior.Continue);
        if (!behavior) this.error(node, "loop does not exit");
        return behavior;
    }

    private continuingBlock(block: number): number {
        const { tree } = this;
        let behavior = Behavior.Next;
        this.statementAttributes(block);
        for (let stmt = tree.firsts[block]!; stmt; stmt = tree.nexts[stmt]!) {
            if (this.kinds[stmt] === Node.Attribute) continue;
            if (this.kinds[stmt] === Node.BreakIf && tree.nexts[stmt])
                this.error(stmt, "break-if must be the last statement in a continuing block");
            const b = this.statement(stmt);
            if (behavior & Behavior.Next) behavior = (behavior & ~Behavior.Next) | b;
        }
        this.behaviors[block] = behavior;
        return behavior;
    }

    /** Reports the continue statements jumping over the declarations used in the continuing block. */
    private bypassedDeclarations(
        body: number,
        continuing: number,
        continues: readonly number[],
    ): void {
        if (continues.length === 0) return;
        const { tree } = this;
        const used = new Set<number>();
        const collect = (node: number): void => {
            if (this.kinds[node] === Node.Ident && this.refs[node]) used.add(this.refs[node]!);
            for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!) collect(child);
        };
        collect(continuing);
        for (const stmt of continues) {
            const at = tree.starts[stmt]!;
            for (let decl = tree.firsts[body]!; decl; decl = tree.nexts[decl]!) {
                if (tree.starts[decl]! <= at || !used.has(decl)) continue;
                this.error(
                    stmt,
                    `continue statement bypasses declaration of '${this.name(decl)}' used in continuing block`,
                );
                break;
            }
        }
    }

    private forLoop(node: number): number {
        const { tree } = this;
        this.statementAttributes(node);
        const init = skipAttributes(tree, node);
        const cond = tree.nexts[init]!;
        const update = tree.nexts[cond]!;
        const body = tree.nexts[update]!;
        let behavior = 0;
        if (this.kinds[init] !== Node.Empty) behavior |= this.statement(init);
        if (this.kinds[cond] !== Node.Empty) this.condition(cond, "for-loop");
        this.scopes.push(Scope.Loop);
        this.continues.push([]);
        if (this.kinds[update] !== Node.Empty) {
            this.scopes.push(Scope.Continuing);
            behavior |= this.statement(update);
            this.scopes.pop();
        }
        if (body) behavior |= this.block(body);
        this.continues.pop();
        this.scopes.pop();
        if (this.kinds[cond] !== Node.Empty || behavior & Behavior.Break) behavior |= Behavior.Next;
        else behavior &= ~Behavior.Next;
        behavior &= ~(Behavior.Break | Behavior.Continue);
        if (!behavior) this.error(node, "for-loop does not exit");
        return behavior;
    }

    private whileLoop(node: number): number {
        const { tree } = this;
        this.statementAttributes(node);
        const cond = skipAttributes(tree, node);
        this.condition(cond, "while");
        const body = tree.nexts[cond]!;
        this.scopes.push(Scope.Loop);
        this.continues.push([]);
        let behavior = body ? this.block(body) : Behavior.Next;
        this.continues.pop();
        this.scopes.pop();
        behavior |= Behavior.Next;
        behavior &= ~(Behavior.Break | Behavior.Continue);
        return behavior;
    }

    // ---- expressions ----

    /** Checks the expression as a value with the load rule applied; returns its type or undefined on errors. */
    private value(node: number): Type | undefined {
        const sem = this.expr(node);
        switch (sem) {
            case Sem.Value: {
                const type = this.types[node]!;
                if (type.kind === Kind.Reference || type.kind === Kind.Swizzle) {
                    if (type.access === "write") {
                        this.error(node, "cannot read from a write-only memory view");
                        return undefined;
                    }
                    this.loads[node] = 1;
                    if (type.kind === Kind.Reference) this.registerAccess(node, false);
                    return type.elem;
                }
                return type;
            }
            case Sem.Type:
                this.error(node, `cannot use type '${this.typeText(node)}' as a value`);
                return undefined;
            case Sem.Function:
                this.error(node, `cannot use function '${this.text(node)}' as a value`);
                return undefined;
            case Sem.Enum:
                this.error(
                    node,
                    `cannot use ${enumOf(this.values[node] as string)} '${this.values[node] as string}' as a value`,
                );
                return undefined;
            default:
                return undefined;
        }
    }

    private typeText(node: number): string {
        const type = this.types[node];
        return type ? typeName(type) : this.text(node);
    }

    private expr(node: number): Sem {
        const existing = this.sems[node]!;
        if (existing !== Sem.None) return existing;
        let sem: Sem;
        switch (this.kinds[node]) {
            case Node.Literal:
                sem = this.literal(node);
                break;
            case Node.Ident:
                sem = this.ident(node);
                break;
            case Node.Paren: {
                const inner = this.tree.firsts[node]!;
                sem = this.expr(inner);
                this.types[node] = this.types[inner];
                this.stages[node] = this.stages[inner]!;
                if (sem === Sem.Type || sem === Sem.Function || sem === Sem.Enum) {
                    this.error(node, "expected a value");
                    sem = Sem.Error;
                }
                break;
            }
            case Node.Unary:
                sem = this.unary(node);
                break;
            case Node.Binary:
                sem = this.binary(node);
                break;
            case Node.Index:
                sem = this.index(node);
                break;
            case Node.Member:
                sem = this.member(node);
                break;
            case Node.Call:
                sem = this.call(node);
                break;
            default:
                sem = Sem.Error;
        }
        if (
            sem === Sem.Value &&
            this.stages[node] === Stage.Const &&
            this.values[node] === undefined &&
            !this.skipEval
        ) {
            const kind = this.kinds[node];
            if (kind !== Node.Literal && kind !== Node.Ident) {
                const value = this.evaluate(node, () =>
                    valueOf(this.evaluation, node, n => this.values[n] as Value | undefined),
                );
                if (this.evalFailed) sem = Sem.Error;
                else this.values[node] = value;
            }
        }
        this.sems[node] = sem;
        return sem;
    }

    private setValue(node: number, type: Type, stage: Stage, value?: Value): Sem {
        this.types[node] = type;
        this.stages[node] = stage;
        if (stage === Stage.Const && value !== undefined && !this.skipEval)
            this.values[node] = value;
        return Sem.Value;
    }

    private literal(node: number): Sem {
        const text = this.text(node);
        switch (this.tree.tokens.kinds[this.tree.tokenOf[node]!] as Tok) {
            case Tok.True:
                return this.setValue(node, boolType, Stage.Const, true);
            case Tok.False:
                return this.setValue(node, boolType, Stage.Const, false);
            case Tok.Int:
                return this.setValue(node, abstractInt, Stage.Const, intValue(text));
            case Tok.IntI:
                return this.setValue(node, i32, Stage.Const, Number(intValue(text)));
            case Tok.IntU:
                return this.setValue(node, u32, Stage.Const, Number(intValue(text)));
            case Tok.Float:
                return this.setValue(node, abstractFloat, Stage.Const, floatValue(text));
            case Tok.FloatF:
                return this.setValue(node, f32, Stage.Const, Math.fround(floatValue(text)));
            case Tok.FloatH:
                if (!this.extensions.has("f16")) {
                    this.error(node, "f16 literal used without 'f16' extension enabled");
                    return Sem.Error;
                }
                return this.setValue(node, f16, Stage.Const, Math.f16round(floatValue(text)));
            default:
                return Sem.Error;
        }
    }

    private ident(node: number): Sem {
        if (this.sems[node] !== Sem.None) return this.sems[node]!;
        const sem = this.identInner(node);
        this.sems[node] = sem;
        return sem;
    }

    private identInner(node: number): Sem {
        const decl = this.refs[node]!;
        const hasTemplate = this.tree.firsts[node] !== 0;
        if (decl) {
            const kind = this.kinds[decl];
            if (kind === Node.Struct || kind === Node.Alias) {
                if (hasTemplate) {
                    this.error(node, `type '${this.text(node)}' does not take template arguments`);
                    return Sem.Error;
                }
                const type = this.types[decl];
                if (!type) return Sem.Error;
                this.types[node] = type;
                return Sem.Type;
            }
            if (hasTemplate) {
                this.error(node, `'${this.text(node)}' does not take template arguments`);
                return Sem.Error;
            }
            if (kind === Node.Function) return Sem.Function;
            const type = this.types[decl];
            if (!type || type === errorType) return Sem.Error;
            if (kind === Node.Var && this.fn && !this.fnLocal(decl))
                this.useGlobal(node, decl, type);
            if (kind === Node.Override && this.fn && !this.fnLocal(decl)) this.fn.globals.add(decl);
            const stage =
                kind === Node.Const
                    ? Stage.Const
                    : kind === Node.Override
                      ? Stage.Override
                      : Stage.Runtime;
            return this.setValue(node, type, stage, this.values[decl] as Value | undefined);
        }
        const name = this.text(node);
        if (predeclaredTypes.has(name) || typeGenerators.has(name)) {
            const type = this.predeclaredType(node, name);
            if (!type && (hasTemplate || predeclaredTypes.has(name))) return Sem.Error;
            this.types[node] = type;
            return Sem.Type;
        }
        if (functionOverloads(name)) {
            if (hasTemplate && name !== "bitcast" && !name.startsWith("buffer")) {
                this.error(node, `'${name}' does not take template arguments`);
                return Sem.Error;
            }
            return Sem.Function;
        }
        if (enumOf(name)) {
            if (hasTemplate) {
                this.error(node, `'${name}' does not take template arguments`);
                return Sem.Error;
            }
            this.values[node] = name;
            return Sem.Enum;
        }
        this.error(node, `unresolved identifier '${name}'`);
        return Sem.Error;
    }

    /** Whether the declaration is local to the current function. */
    private fnLocal(decl: number): boolean {
        return this.tree.parents[decl] !== 0;
    }

    private useGlobal(node: number, decl: number, type: Type): void {
        const fn = this.fn!;
        fn.globals.add(decl);
        const store = type.elem!;
        if (type.space === "workgroup") this.restrict(Stages.Compute, node);
        else if (
            (type.space === "storage" && type.access === "read_write") ||
            (store.format && store.access !== "read")
        )
            this.restrict(Stages.Fragment | Stages.Compute, node);
    }

    /** Restricts the current function to the shader stages. */
    private restrict(stages: Stages, node: number): void {
        const fn = this.fn;
        if (!fn) return;
        if ((fn.stages & stages) !== fn.stages && !fn.restriction) fn.restriction = node;
        fn.stages &= stages;
    }

    private unary(node: number): Sem {
        const { tree } = this;
        const operand = tree.firsts[node]!;
        let op = tree.tokens.kinds[tree.tokenOf[node]!] as Tok;
        if (op === Tok.MinusMinus) op = Tok.Minus;
        if (op === Tok.AndAnd) op = Tok.And;
        if (op === Tok.And) {
            const sem = this.expr(operand);
            if (sem === Sem.Error) return Sem.Error;
            const type = this.types[operand];
            if (sem !== Sem.Value || !type || type.kind !== Kind.Reference) {
                this.error(node, "cannot take the address of expression");
                return Sem.Error;
            }
            if (type.space === "handle") {
                this.error(node, "cannot take the address of expression in handle address space");
                return Sem.Error;
            }
            if (this.isVectorComponent(operand)) {
                this.error(node, "cannot take the address of a vector component");
                return Sem.Error;
            }
            return this.setValue(
                node,
                pointer(type.space!, type.elem!, type.access!),
                Stage.Runtime,
            );
        }
        if (op === Tok.Star) {
            const sem = this.expr(operand);
            if (sem === Sem.Error) return Sem.Error;
            const type = sem === Sem.Value ? this.types[operand] : undefined;
            if (!type || type.kind !== Kind.Pointer) {
                if (sem === Sem.Value)
                    this.error(
                        node,
                        `cannot dereference expression of type '${typeName(loaded(type!))}'`,
                    );
                else this.value(operand);
                return Sem.Error;
            }
            return this.setValue(
                node,
                reference(type.space!, type.elem!, type.access!),
                Stage.Runtime,
            );
        }
        const type = this.value(operand);
        if (!type) return Sem.Error;
        const operator = op === Tok.Minus ? "-" : op === Tok.Bang ? "!" : "~";
        const stage = this.stages[operand] as Stage;
        const res = this.resolve(operatorOverloads(operator, 1), [], [type], stage === Stage.Const);
        if (!res) {
            this.error(node, `no matching overload for operator ${operator} (${typeName(type)})`);
            return Sem.Error;
        }
        this.overloads[node] = res;
        return this.setValue(node, res.result, stage);
    }

    /** Whether the expression is a memory view of a vector component. */
    private isVectorComponent(node: number): boolean {
        node = this.unparen(node);
        const kind = this.kinds[node];
        if (kind !== Node.Index && kind !== Node.Member) return false;
        const base = this.tree.firsts[node]!;
        const type = this.types[base];
        const store =
            type && (type.kind === Kind.Reference || type.kind === Kind.Pointer)
                ? type.elem!
                : type;
        return store?.kind === Kind.Vector;
    }

    private binary(node: number): Sem {
        const { tree } = this;
        const lhs = tree.firsts[node]!;
        const rhs = tree.nexts[lhs]!;
        let op = tree.tokens.kinds[tree.tokenOf[node]!] as Tok;
        if (op === Tok.MinusMinus) op = Tok.Minus;
        const operator = binaryOperators.get(op)!;
        if (operator === "&&" || operator === "||") return this.logical(node, lhs, rhs, operator);
        const lt = this.value(lhs);
        const rt = this.value(rhs);
        if (!lt || !rt) return Sem.Error;
        const stage = Math.max(this.stages[lhs]!, this.stages[rhs]!) as Stage;
        const res = this.resolve(
            operatorOverloads(operator, 2),
            [],
            [lt, rt],
            stage === Stage.Const,
        );
        if (!res) {
            const what = res === null ? "ambiguous overload" : "no matching overload";
            this.error(node, `${what} for operator ${operator} (${typeName(lt)}, ${typeName(rt)})`);
            return Sem.Error;
        }
        this.overloads[node] = res;
        if (stage !== Stage.Const) {
            this.materialize(lhs, lt, res.params[0]!);
            this.materialize(rhs, rt, res.params[1]!);
        }
        if (!this.shiftCheck(operator, res.params[0]!, rhs)) return Sem.Error;
        if (!this.divisionCheck(operator, res.params[0]!, rhs)) return Sem.Error;
        return this.setValue(node, res.result, stage);
    }

    /** Validates the const shift amount against the bit width of the concrete shifted type. */
    private shiftCheck(operator: string, lhs: Type, rhs: number): boolean {
        if (operator !== "<<" && operator !== ">>") return true;
        if (this.stages[rhs] !== Stage.Const || scalarOf(lhs).kind === Kind.AbstractInt)
            return true;
        const value = this.values[rhs] as Value | undefined;
        if (value === undefined) return true;
        let ok = true;
        map1(value, v => {
            if (Number(v) >= 32) ok = false;
            return v;
        });
        if (!ok)
            this.error(
                rhs,
                `shift ${operator === "<<" ? "left" : "right"} value must be less than the bit width of the lhs, which is 32`,
            );
        return ok;
    }

    /** Reports the integer division by a const zero. */
    private divisionCheck(operator: string, lhs: Type, rhs: number): boolean {
        if (operator !== "/" && operator !== "%") return true;
        const kind = scalarOf(lhs).kind;
        if (kind !== Kind.I32 && kind !== Kind.U32) return true;
        if (this.stages[rhs] !== Stage.Const) return true;
        const value = this.values[rhs] as Value | undefined;
        if (value === undefined) return true;
        let zero = false;
        map1(value, v => {
            if (v === 0 || v === 0n) zero = true;
            return v;
        });
        if (zero) this.error(rhs, "integer division by zero is invalid");
        return !zero;
    }

    private logical(node: number, lhs: number, rhs: number, operator: string): Sem {
        const lt = this.value(lhs);
        const skip = this.stages[lhs] === Stage.Const && this.values[lhs] === (operator === "||");
        if (skip) this.skipEval++;
        const rt = this.value(rhs);
        if (skip) this.skipEval--;
        if (!lt || !rt) return Sem.Error;
        if (lt.kind !== Kind.Bool || rt.kind !== Kind.Bool) {
            this.error(
                node,
                `no matching overload for operator ${operator} (${typeName(lt)}, ${typeName(rt)})`,
            );
            return Sem.Error;
        }
        return this.setValue(
            node,
            boolType,
            Math.max(this.stages[lhs]!, this.stages[rhs]!) as Stage,
        );
    }

    private index(node: number): Sem {
        const { tree } = this;
        const base = tree.firsts[node]!;
        const indexNode = tree.nexts[base]!;
        const sem = this.expr(base);
        if (sem === Sem.Error) {
            this.value(indexNode);
            return Sem.Error;
        }
        let baseType = this.types[base];
        if (sem !== Sem.Value || !baseType) {
            this.value(base);
            return Sem.Error;
        }
        const indexType = this.value(indexNode);
        if (!indexType) return Sem.Error;
        if (
            indexType.kind !== Kind.I32 &&
            indexType.kind !== Kind.U32 &&
            indexType.kind !== Kind.AbstractInt
        ) {
            this.error(
                indexNode,
                `index must be of type 'i32' or 'u32', found: '${typeName(indexType)}'`,
            );
            return Sem.Error;
        }
        let view: Type | undefined;
        if (baseType.kind === Kind.Pointer) {
            if (!this.supportedFeatures.has("pointer_composite_access")) {
                this.error(base, "cannot index a pointer");
                return Sem.Error;
            }
            view = baseType;
            baseType = baseType.elem!;
        } else if (baseType.kind === Kind.Reference || baseType.kind === Kind.Swizzle) {
            view = baseType;
            baseType = baseType.elem!;
        }
        let elem: Type;
        let count: number;
        switch (baseType.kind) {
            case Kind.Array:
                elem = baseType.elem!;
                count = baseType.count;
                if (count === 0 && !view) {
                    this.error(
                        base,
                        "runtime-sized arrays can only be indexed through a memory view",
                    );
                    return Sem.Error;
                }
                break;
            case Kind.Vector:
                elem = baseType.elem!;
                count = baseType.count;
                break;
            case Kind.Matrix:
                elem = vec(baseType.rows, baseType.elem!);
                count = baseType.count;
                break;
            default:
                this.error(node, `cannot index type '${typeName(baseType)}'`);
                return Sem.Error;
        }
        const indexStage = this.stages[indexNode] as Stage;
        const indexValue = this.values[indexNode];
        if (indexStage === Stage.Const && indexValue !== undefined) {
            const position = Number(indexValue);
            if (position < 0 || (count > 0 && position >= count)) {
                this.error(
                    indexNode,
                    `index ${position} out of bounds [0..${Math.max(count, 1) - 1}]`,
                );
                return Sem.Error;
            }
        }
        if (view) {
            this.materialize(
                indexNode,
                indexType,
                indexType.kind === Kind.AbstractInt ? i32 : indexType,
            );
            return this.setValue(node, this.view(view, elem, baseType.count, 1), Stage.Runtime);
        }
        const stage = Math.max(this.stages[base]!, indexStage) as Stage;
        if (stage !== Stage.Const) {
            if (isAbstract(baseType)) elem = concretize(elem);
            this.materialize(
                indexNode,
                indexType,
                indexType.kind === Kind.AbstractInt ? i32 : indexType,
            );
        }
        return this.setValue(node, elem, stage);
    }

    private member(node: number): Sem {
        const { tree } = this;
        const base = tree.firsts[node]!;
        const sem = this.expr(base);
        if (sem === Sem.Error) return Sem.Error;
        let baseType = this.types[base];
        if (sem !== Sem.Value || !baseType) {
            this.value(base);
            return Sem.Error;
        }
        const name = this.text(node);
        if (tree.tokenOf[node] === tree.tokenOf[base] || !name) return Sem.Error;
        let view: Type | undefined;
        if (baseType.kind === Kind.Pointer) {
            if (!this.supportedFeatures.has("pointer_composite_access")) {
                this.error(base, "cannot access a member of a pointer");
                return Sem.Error;
            }
            view = baseType;
            baseType = baseType.elem!;
        } else if (baseType.kind === Kind.Reference || baseType.kind === Kind.Swizzle) {
            view = baseType;
            baseType = baseType.elem!;
        }
        const stage = this.stages[base] as Stage;
        if (baseType.kind === Kind.Struct) {
            const member = baseType.members.find(m => m.name === name);
            if (!member) {
                this.error(node, `struct member '${name}' not found`);
                return Sem.Error;
            }
            if (view)
                return this.setValue(
                    node,
                    reference(view.space!, member.type, view.access!),
                    Stage.Runtime,
                );
            return this.setValue(node, member.type, stage);
        }
        if (baseType.kind === Kind.Vector) {
            const indices = swizzle(name, baseType.count);
            if (!indices) {
                this.error(node, `invalid vector swizzle '${name}'`);
                return Sem.Error;
            }
            const elem = baseType.elem!;
            if (indices.length === 1) {
                if (view)
                    return this.setValue(
                        node,
                        this.view(view, elem, baseType.count, 1),
                        Stage.Runtime,
                    );
                return this.setValue(node, elem, stage);
            }
            const type = vec(indices.length, elem);
            if (view) {
                if (view.kind !== Kind.Swizzle) this.registerAccess(base, false);
                return this.setValue(
                    node,
                    swizzleView(view.space!, type, view.access!, baseType.count, indices.length),
                    Stage.Runtime,
                );
            }
            return this.setValue(node, type, stage);
        }
        this.error(node, `invalid member accessor expression on type '${typeName(baseType)}'`);
        return Sem.Error;
    }

    /**
     * Returns the memory view of a vector component or a part of a composite in the view:
     * a swizzle view when the view is a swizzle view, a reference otherwise.
     */
    private view(view: Type, store: Type, width: number, size: number): Type {
        return view.kind === Kind.Swizzle
            ? swizzleView(view.space!, store, view.access!, width, size)
            : reference(view.space!, store, view.access!);
    }

    // ---- calls ----

    private call(node: number): Sem {
        const { tree } = this;
        const callee = tree.firsts[node]!;
        const args: number[] = [];
        for (let arg = tree.nexts[callee]!; arg; arg = tree.nexts[arg]!) args.push(arg);
        const decl = this.refs[callee]!;
        if (decl) {
            const kind = this.kinds[decl];
            if (kind === Node.Function) {
                if (this.tree.firsts[callee]) {
                    this.error(
                        callee,
                        `function '${this.text(callee)}' does not take template arguments`,
                    );
                    return Sem.Error;
                }
                this.sems[callee] = Sem.Function;
                return this.userCall(node, decl, args);
            }
            if (kind !== Node.Struct && kind !== Node.Alias) {
                this.ident(callee);
                if (this.sems[callee] !== Sem.Error)
                    this.error(callee, `'${this.text(callee)}' is not a function or type`);
                for (const arg of args) this.value(arg);
                return Sem.Error;
            }
        }
        const sem = this.ident(callee);
        if (sem === Sem.Error) {
            for (const arg of args) this.value(arg);
            return Sem.Error;
        }
        if (sem === Sem.Function) return this.builtinCall(node, callee, args);
        if (sem === Sem.Type) return this.construct(node, callee, args);
        this.error(callee, `'${this.text(callee)}' is not a function or type`);
        for (const arg of args) this.value(arg);
        return Sem.Error;
    }

    private userCall(node: number, decl: number, args: readonly number[]): Sem {
        const info = this.functions.get(decl);
        const types = args.map(a => this.value(a));
        if (!info) return Sem.Error;
        const fn = this.fn;
        if (fn) {
            fn.callees.add(decl);
            if ((fn.stages & info.stages) !== fn.stages && !fn.restriction)
                fn.restriction = info.restriction || node;
            fn.stages &= info.stages;
        } else {
            this.error(node, "user-declared functions cannot be called at module scope");
            return Sem.Error;
        }
        if (info.stage) {
            this.error(node, "entry point functions cannot be the target of a function call");
            return Sem.Error;
        }
        if (args.length !== info.params.length) {
            this.error(
                node,
                `too ${args.length < info.params.length ? "few" : "many"} arguments in call to '${info.name}', expected ${info.params.length}, got ${args.length}`,
            );
            return Sem.Error;
        }
        let ok = true;
        for (let i = 0; i < args.length; i++) {
            const type = types[i];
            if (!type) {
                ok = false;
                continue;
            }
            const param = info.params[i]!;
            if (param === errorType || isBufferPointerConversion(type, param)) continue;
            if (conversionRank(type, param) === noConversion) {
                this.error(
                    args[i]!,
                    `type mismatch for argument ${i + 1} in call to '${info.name}', expected '${typeName(param)}', got '${typeName(type)}'`,
                );
                ok = false;
                continue;
            }
            this.convert(args[i]!, type, param, "convert");
        }
        if (!ok) return Sem.Error;
        this.aliasAnalysis(decl, args);
        this.views.userCall(node, decl);
        return this.setValue(node, info.result, Stage.Runtime);
    }

    /** Validates the store type of the pointer bufferView or bufferArrayView returns. */
    private bufferViewType(node: number, name: string, res: OverloadResolution): boolean {
        const { space, access } = res.result;
        const store = res.result.elem!;
        let problem: string | undefined;
        if (!isHostShareable(store)) problem = "must be host-shareable";
        else if (store.kind === Kind.Buffer) problem = "cannot be a buffer";
        else if (containsAtomic(store)) problem = "cannot contain an atomic type";
        else if (name === "bufferArrayView" && hasFixedFootprint(store))
            problem = "cannot have a fixed footprint";
        if (problem) {
            this.error(node, `return type of ${name} ${problem}`);
            return false;
        }
        return (
            this.addressSpaceUsage(node, store, space!) &&
            this.accessInSpace(node, store, access!, space!)
        );
    }

    private isGlobalVar(decl: number): boolean {
        return this.kinds[decl] === Node.Var && this.tree.parents[decl] === 0;
    }

    /** Registers the read or write of the memory view or pointer for the alias analysis. */
    private registerAccess(node: number, write: boolean): void {
        const access = this.access;
        if (!access) return;
        const root = memoryRoot(this.tree, this.refs, node);
        if (this.kinds[root] === Node.Param)
            (write ? access.paramWrites : access.paramReads).add(root);
        else if (this.isGlobalVar(root)) {
            const globals = write ? access.globalWrites : access.globalReads;
            if (!globals.has(root)) globals.set(root, node);
        }
    }

    /** Validates that the pointer arguments of the call don't alias, propagating the accesses. */
    private aliasAnalysis(decl: number, args: readonly number[]): void {
        const { tree } = this;
        const target = this.accesses.get(decl)!;
        const caller = this.access!;
        const params: number[] = [];
        for (let p = tree.firsts[decl]!; p; p = tree.nexts[p]!)
            if (this.kinds[p] === Node.Param) params.push(p);
        const reads = new Map<number, number>();
        const writes = new Map<number, number>();
        const fail = (arg: number, other: number, global?: string): void => {
            const note = global
                ? `aliases with module-scope variable ${global} in '${this.name(this.functionOf(other))}'`
                : "aliases with another argument passed here";
            this.diagnostics.push({
                start: tree.starts[arg]!,
                end: tree.ends[arg]!,
                severity: "error",
                message: "invalid aliased pointer argument",
                notes: [{ start: tree.starts[other]!, end: tree.ends[other]!, message: note }],
            });
        };
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]!;
            const param = params[i]!;
            if (this.types[arg]!.kind !== Kind.Pointer) continue;
            const root = memoryRoot(this.tree, this.refs, arg);
            let other: number | undefined;
            if (target.paramWrites.has(param)) {
                if ((other = writes.get(root) ?? reads.get(root))) return fail(arg, other);
                if ((other = target.globalReads.get(root))) return fail(arg, other, "read");
                if ((other = target.globalWrites.get(root))) return fail(arg, other, "write");
                if (!writes.has(root)) writes.set(root, arg);
                if (this.isGlobalVar(root)) {
                    if (!caller.globalWrites.has(root)) caller.globalWrites.set(root, arg);
                } else if (this.kinds[root] === Node.Param) caller.paramWrites.add(root);
            } else if (target.paramReads.has(param)) {
                if ((other = writes.get(root))) return fail(arg, other);
                if ((other = target.globalWrites.get(root))) return fail(arg, other, "write");
                if (!reads.has(root)) reads.set(root, arg);
                if (this.isGlobalVar(root)) {
                    if (!caller.globalReads.has(root)) caller.globalReads.set(root, arg);
                } else if (this.kinds[root] === Node.Param) caller.paramReads.add(root);
            }
        }
        for (const [root, node] of target.globalReads)
            if (!caller.globalReads.has(root)) caller.globalReads.set(root, node);
        for (const [root, node] of target.globalWrites)
            if (!caller.globalWrites.has(root)) caller.globalWrites.set(root, node);
    }

    /** Returns the function declaration containing the node. */
    private functionOf(node: number): number {
        while (this.kinds[node] !== Node.Function) node = this.tree.parents[node]!;
        return node;
    }

    private builtinCall(node: number, callee: number, args: readonly number[]): Sem {
        const { tree } = this;
        const name = this.text(callee);
        const overloads = functionOverloads(name)!;
        const templateArgs: TemplateArg[] = [];
        for (let t = tree.firsts[callee]!; t; t = tree.nexts[t]!) {
            const type = this.type(t);
            if (!type) {
                for (const arg of args) this.value(arg);
                return Sem.Error;
            }
            templateArgs.push(type);
        }
        const types: Type[] = [];
        let failed = false;
        let stage = Stage.Const;
        for (const arg of args) {
            const type = this.value(arg);
            if (!type) failed = true;
            else {
                types.push(type);
                stage = Math.max(stage, this.stages[arg]!);
            }
        }
        if (failed) return Sem.Error;
        const requirement = extensionOf(name);
        if (requirement && !this.extensions.has(requirement)) {
            this.error(
                callee,
                `cannot call built-in function '${name}' without extension '${requirement}'`,
            );
            return Sem.Error;
        }
        const res = this.resolve(overloads, templateArgs, types, stage === Stage.Const);
        if (!res) {
            const signature = `${name}${templateArgs.length ? `<${templateArgs.map(t => typeName(t as Type)).join(", ")}>` : ""}(${types.map(typeName).join(", ")})`;
            this.error(node, `no matching call to '${signature}'\n\n${candidates(overloads)}`);
            return Sem.Error;
        }
        this.overloads[node] = res;
        const overload = res.overload;
        const resultStage = overload.evaluator === undefined ? Stage.Runtime : stage;
        for (let i = 0; i < args.length; i++) {
            if (overload.params[i]!.constant && this.stages[args[i]!] !== Stage.Const) {
                const paramName = overload.params[i]!.name;
                this.error(
                    args[i]!,
                    `the ${paramName ? `'${paramName}' argument` : "argument"} of '${name}' must be a const-expression`,
                );
                return Sem.Error;
            }
            if (resultStage !== Stage.Const) this.materialize(args[i]!, types[i]!, res.params[i]!);
        }
        if (!this.builtinArguments(node, name, args, res)) return Sem.Error;
        this.requirements |= requirementOf(name);
        if (name === "bufferView" || name === "bufferArrayView") {
            if (!this.bufferViewType(node, name, res)) return Sem.Error;
            this.views.view(node);
        }
        if (name === "workgroupUniformLoad" || name === "atomicLoad")
            this.registerAccess(args[0]!, false);
        else if (name === "atomicStore") this.registerAccess(args[0]!, true);
        else if (atomicReadWrites.has(name)) {
            this.registerAccess(args[0]!, false);
            this.registerAccess(args[0]!, true);
        }
        if (overload.stages.length > 0) {
            let stages = Stages.None;
            for (const s of overload.stages) stages |= stageNames[s]!;
            this.restrict(stages, node);
        }
        return this.setValue(
            node,
            res.result,
            res.result === voidType ? Stage.Runtime : resultStage,
        );
    }

    /** Validates the builtin-specific restrictions on the arguments. */
    private builtinArguments(
        node: number,
        name: string,
        args: readonly number[],
        res: OverloadResolution,
    ): boolean {
        const constArg = (i: number): Value | undefined =>
            this.stages[args[i]!] === Stage.Const
                ? (this.values[args[i]!] as Value | undefined)
                : undefined;
        if (name.startsWith("texture")) {
            const offset = res.overload.params.findIndex(p => p.name === "offset");
            const offsetValue = offset >= 0 ? constArg(offset) : undefined;
            if (offsetValue !== undefined && (offsetValue as number[]).some(v => v < -8 || v > 7)) {
                this.error(
                    args[offset]!,
                    "each component of the 'offset' argument must be at least -8 and at most 7",
                );
                return false;
            }
            const component = res.overload.params.findIndex(p => p.name === "component");
            const componentValue = component >= 0 ? constArg(component) : undefined;
            if (
                componentValue !== undefined &&
                (Number(componentValue) < 0 || Number(componentValue) > 3)
            ) {
                this.error(
                    args[component]!,
                    "the 'component' argument must be at least 0 and at most 3",
                );
                return false;
            }
        }
        if (
            (name === "subgroupBroadcast" ||
                name === "quadBroadcast" ||
                name.startsWith("subgroupShuffle")) &&
            args.length === 2
        ) {
            const value = constArg(1);
            const limit = name === "quadBroadcast" ? 4 : 128;
            const param = res.overload.params[1]!.name;
            if (value !== undefined && Number(value) < 0) {
                this.error(
                    args[1]!,
                    `the ${param} argument of ${name} must be greater than or equal to zero`,
                );
                return false;
            }
            if (value !== undefined && Number(value) >= limit) {
                this.error(args[1]!, `the ${param} argument of ${name} must be less than ${limit}`);
                return false;
            }
        }
        return this.partialEvaluation(node, name, args, res);
    }

    /** Evaluates the builtins whose const arguments alone can be invalid when the others aren't const. */
    private partialEvaluation(
        node: number,
        name: string,
        args: readonly number[],
        res: OverloadResolution,
    ): boolean {
        const known = (indices: readonly number[]): Value[] | undefined => {
            const values: Value[] = [];
            for (const i of indices) {
                const arg = args[i]!;
                const value =
                    this.stages[arg] === Stage.Const
                        ? (this.values[arg] as Value | undefined)
                        : undefined;
                if (value === undefined) return undefined;
                const converted = this.convertValueAt(
                    arg,
                    value,
                    loaded(this.types[arg]!),
                    res.params[i]!,
                );
                if (converted === undefined) return undefined;
                values.push(converted);
            }
            return values;
        };
        const zero = (i: number): Value => zeroValue(res.params[i]!);
        let fake: Value[] | undefined;
        switch (name) {
            case "clamp": {
                const values = known([1, 2]);
                if (values) fake = [values[0]!, values[0]!, values[1]!];
                break;
            }
            case "smoothstep": {
                const values = known([0, 1]);
                if (values) fake = [values[0]!, values[1]!, values[1]!];
                break;
            }
            case "ldexp": {
                const values = known([1]);
                if (values) fake = [zero(0), values[0]!];
                break;
            }
            case "extractBits": {
                const values = known([1, 2]);
                if (values) fake = [zero(0), values[0]!, values[1]!];
                break;
            }
            case "insertBits": {
                const values = known([2, 3]);
                if (values) fake = [zero(0), zero(1), values[0]!, values[1]!];
                break;
            }
        }
        if (!fake || this.skipEval) return true;
        this.evaluate(node, () => evaluateBuiltin(name, fake, res));
        return !this.evalFailed;
    }

    private construct(node: number, callee: number, args: readonly number[]): Sem {
        const target = this.types[callee];
        const types: Type[] = [];
        let failed = false;
        let stage = Stage.Const;
        for (const arg of args) {
            const type = this.value(arg);
            if (!type) failed = true;
            else {
                types.push(type);
                stage = Math.max(stage, this.stages[arg]!);
            }
        }
        if (failed) return Sem.Error;
        const name = this.text(callee);
        if (!target) {
            if (name === "array") return this.inferredArray(node, args, types, stage);
            if (
                name === "ptr" ||
                name === "atomic" ||
                name.startsWith("texture") ||
                name === "buffer"
            ) {
                this.error(callee, `type '${name}' is not constructible`);
                return Sem.Error;
            }
            return this.builtinConstruct(node, name, [], args, types, stage);
        }
        switch (target.kind) {
            case Kind.Struct:
                return this.compositeConstruct(node, target, args, types, stage);
            case Kind.Array:
                return this.compositeConstruct(node, target, args, types, stage);
            case Kind.Vector:
                return this.builtinConstruct(
                    node,
                    `vec${target.count}`,
                    [target.elem!],
                    args,
                    types,
                    stage,
                );
            case Kind.Matrix:
                return this.builtinConstruct(
                    node,
                    `mat${target.count}x${target.rows}`,
                    [target.elem!],
                    args,
                    types,
                    stage,
                );
            case Kind.Bool:
            case Kind.I32:
            case Kind.U32:
            case Kind.F32:
            case Kind.F16:
                return this.builtinConstruct(node, target.name, [], args, types, stage);
            default:
                this.error(callee, `type '${typeName(target)}' is not constructible`);
                return Sem.Error;
        }
    }

    private builtinConstruct(
        node: number,
        name: string,
        templates: readonly Type[],
        args: readonly number[],
        types: readonly Type[],
        stage: Stage,
    ): Sem {
        const overloads = constructorOverloads(name);
        if (!overloads) {
            this.error(node, `type '${name}' is not constructible`);
            return Sem.Error;
        }
        const res = this.resolve(overloads, templates, types, stage === Stage.Const);
        if (!res) {
            if (res === null) {
                this.error(node, `ambiguous constructor call`);
                return Sem.Error;
            }
            const typeText = templates.length
                ? `${name}<${templates.map(typeName).join(", ")}>`
                : name;
            this.error(
                node,
                `no matching constructor for '${typeText}(${types.map(typeName).join(", ")})'\n\n${candidates(overloads)}`,
            );
            return Sem.Error;
        }
        this.overloads[node] = res;
        if (stage !== Stage.Const)
            for (let i = 0; i < args.length; i++)
                this.materialize(args[i]!, types[i]!, res.params[i]!);
        return this.setValue(node, res.result, stage);
    }

    /** Checks the construction of a structure or a fixed-size array. */
    private compositeConstruct(
        node: number,
        type: Type,
        args: readonly number[],
        types: readonly Type[],
        stage: Stage,
    ): Sem {
        const struct = type.kind === Kind.Struct;
        if (!struct && type.count === 0) {
            this.error(node, "cannot construct a runtime-sized array");
            return Sem.Error;
        }
        if (!isConstructible(type)) {
            this.error(node, `type '${typeName(type)}' is not constructible`);
            return Sem.Error;
        }
        if (args.length === 0) return this.setValue(node, type, Stage.Const);
        const expected = struct ? type.members.length : type.count;
        if (args.length !== expected) {
            const what = struct ? "structure constructor has too" : "array constructor has too";
            this.error(
                node,
                `${what} ${args.length < expected ? "few" : "many"} ${struct ? "inputs" : "elements"}: expected ${expected}, found ${args.length}`,
            );
            return Sem.Error;
        }
        for (let i = 0; i < args.length; i++) {
            const to = struct ? type.members[i]!.type : type.elem!;
            if (conversionRank(types[i]!, to) === noConversion) {
                this.error(
                    args[i]!,
                    struct
                        ? `type in structure constructor does not match struct member type: expected '${typeName(to)}', found '${typeName(types[i]!)}'`
                        : `'${typeName(types[i]!)}' cannot be used to construct an array of '${typeName(to)}'`,
                );
                return Sem.Error;
            }
            if (stage !== Stage.Const) this.materialize(args[i]!, types[i]!, to);
        }
        return this.setValue(node, type, stage);
    }

    private inferredArray(
        node: number,
        args: readonly number[],
        types: readonly Type[],
        stage: Stage,
    ): Sem {
        if (args.length === 0) {
            this.error(
                node,
                "cannot infer the element type of an array constructor without arguments",
            );
            return Sem.Error;
        }
        let elem: Type | undefined = types[0]!;
        for (const type of types) {
            elem = commonType(elem, type);
            if (!elem) {
                this.error(
                    node,
                    `cannot infer common array element type from constructor arguments`,
                );
                return Sem.Error;
            }
        }
        if (!isConstructible(elem)) {
            this.error(node, `'${typeName(elem)}' cannot be used as an element type of an array`);
            return Sem.Error;
        }
        if (stage !== Stage.Const) elem = concretize(elem);
        const type = array(elem, args.length);
        this.types[node] = type;
        return this.compositeConstruct(node, type, args, types, stage);
    }

    /** Resolves the overload, reusing the resolutions of the calls with the same types. */
    private resolve(
        overloads: readonly Overload[],
        templateArgs: readonly TemplateArg[],
        args: readonly Type[],
        constant: boolean,
    ): OverloadResolution | undefined | null {
        let cache = this.resolutions.get(overloads);
        if (!cache) this.resolutions.set(overloads, (cache = new Map()));
        let key = constant ? "c" : "r";
        for (const t of templateArgs) key += typeof t === "string" ? `,${t}` : `,${t.id}`;
        key += ";";
        for (const t of args) key += `,${t.id}`;
        if (cache.has(key)) return cache.get(key);
        const resolution = resolveOverload(overloads, templateArgs, args, constant);
        cache.set(key, resolution);
        return resolution;
    }

    // ---- conversions and evaluation ----

    private evalFailed = false;

    /** Runs the const-evaluation, reporting its errors at the node. */
    private evaluate(node: number, evaluation: () => Value | undefined): Value | undefined {
        this.evalFailed = false;
        if (this.skipEval) return undefined;
        try {
            return evaluation();
        } catch (e) {
            if (!(e instanceof EvalError)) throw e;
            this.error(node, e.message);
            this.evalFailed = true;
            return undefined;
        }
    }

    private convertValueAt(node: number, value: Value, from: Type, to: Type): Value | undefined {
        if (from === to) return value;
        return this.evaluate(node, () => convertValue(value, from, to));
    }

    /** Reports when the const value of the expression doesn't fit the concrete type it's converted to. */
    private materialize(node: number, from: Type, to: Type): void {
        if (this.stages[node] !== Stage.Const || from === to) return;
        const value = this.values[node] as Value | undefined;
        if (value !== undefined) this.convertValueAt(node, value, from, to);
    }

    /**
     * Converts the expression's value to the type, reporting when the types are incompatible or
     * the value doesn't fit; returns the converted value when it's known.
     */
    private convert(
        node: number,
        from: Type,
        to: Type,
        action: "initialize" | "assign" | "return" | "convert",
    ): Value | undefined {
        if (to === errorType) return undefined;
        if (conversionRank(from, to) === noConversion) {
            const message =
                action === "return"
                    ? `return statement type must match its function return type, returned '${typeName(from)}', expected '${typeName(to)}'`
                    : action === "assign"
                      ? `cannot assign '${typeName(from)}' to '${typeName(to)}'`
                      : `cannot ${action === "initialize" ? "initialize" : "convert"} '${typeName(to)}' with '${typeName(from)}'`;
            this.error(node, message);
            return undefined;
        }
        if (this.stages[node] !== Stage.Const) return undefined;
        const value = this.values[node] as Value | undefined;
        if (value === undefined) return undefined;
        return this.convertValueAt(node, value, from, to);
    }
}

function isNumericScalarOrVector(type: Type): boolean {
    const scalar = type.kind === Kind.Vector ? type.elem! : type;
    return scalar.kind >= Kind.I32 && scalar.kind <= Kind.F16;
}

function isIntegerScalarType(type: Type): boolean {
    return type.kind === Kind.I32 || type.kind === Kind.U32 || type.kind === Kind.AbstractInt;
}

/** Whether the pointer argument to a fixed-size buffer converts to a smaller or unsized buffer pointer parameter. */
function isBufferPointerConversion(arg: Type, param: Type): boolean {
    if (arg.kind !== Kind.Pointer || param.kind !== Kind.Pointer) return false;
    if (arg.space !== param.space || arg.access !== param.access) return false;
    const from = arg.elem!;
    const to = param.elem!;
    return (
        from.kind === Kind.Buffer &&
        to.kind === Kind.Buffer &&
        from.count !== 0 &&
        (to.count === 0 || (from.count > 0 && to.count > 0 && to.count < from.count))
    );
}

function swizzle(name: string, width: number): number[] | undefined {
    if (name.length < 1 || name.length > 4) return undefined;
    const sets = ["xyzw", "rgba"];
    for (const set of sets) {
        const indices: number[] = [];
        for (const c of name) {
            const i = set.indexOf(c);
            if (i < 0 || i >= width) break;
            indices.push(i);
        }
        if (indices.length === name.length) return indices;
    }
    return undefined;
}

function candidates(overloads: readonly Overload[]): string {
    return `${overloads.length} candidate${overloads.length > 1 ? "s" : ""}:\n${overloads.map(o => `  ${o.signature}`).join("\n")}`;
}

/** Returns the enable-extension the builtin function requires, if any. */
function extensionOf(name: string): string | undefined {
    if (name.startsWith("subgroup") || name.startsWith("quad")) return "subgroups";
    if (name === "atomicStoreMax" || name === "atomicStoreMin") return "atomic_vec2u_min_max";
    return undefined;
}

const binaryOperators = new Map<Tok, string>([
    [Tok.Plus, "+"],
    [Tok.Minus, "-"],
    [Tok.Star, "*"],
    [Tok.Slash, "/"],
    [Tok.Percent, "%"],
    [Tok.And, "&"],
    [Tok.Or, "|"],
    [Tok.Xor, "^"],
    [Tok.AndAnd, "&&"],
    [Tok.OrOr, "||"],
    [Tok.ShiftLeft, "<<"],
    [Tok.ShiftRight, ">>"],
    [Tok.EqualEqual, "=="],
    [Tok.NotEqual, "!="],
    [Tok.Less, "<"],
    [Tok.LessEqual, "<="],
    [Tok.Greater, ">"],
    [Tok.GreaterEqual, ">="],
]);

const compoundOperators = new Map<Tok, string>([
    [Tok.PlusEqual, "+"],
    [Tok.MinusEqual, "-"],
    [Tok.StarEqual, "*"],
    [Tok.SlashEqual, "/"],
    [Tok.PercentEqual, "%"],
    [Tok.AndEqual, "&"],
    [Tok.OrEqual, "|"],
    [Tok.XorEqual, "^"],
    [Tok.ShiftLeftEqual, "<<"],
    [Tok.ShiftRightEqual, ">>"],
]);

const storageFormats = new Set([
    "rgba8unorm",
    "rgba8snorm",
    "rgba8uint",
    "rgba8sint",
    "rgba16uint",
    "rgba16sint",
    "rgba16float",
    "r32uint",
    "r32sint",
    "r32float",
    "rg32uint",
    "rg32sint",
    "rg32float",
    "rgba32uint",
    "rgba32sint",
    "rgba32float",
    "bgra8unorm",
]);

const tier1Formats = new Set([
    "rgba16unorm",
    "rgba16snorm",
    "rg8unorm",
    "rg8snorm",
    "rg8uint",
    "rg8sint",
    "rg16unorm",
    "rg16snorm",
    "rg16uint",
    "rg16sint",
    "rg16float",
    "r8unorm",
    "r8snorm",
    "r8uint",
    "r8sint",
    "r16unorm",
    "r16snorm",
    "r16uint",
    "r16sint",
    "r16float",
    "rgb10a2unorm",
    "rgb10a2uint",
    "rg11b10ufloat",
]);

void unsizedBuffer;
void samplerType;
void comparisonSamplerType;
void texture;
