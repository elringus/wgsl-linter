import type { Diagnostic, Note, Severity } from "../syntax/diagnostic.ts";
import {
    childOf,
    initializerOf,
    nameOf,
    Node,
    skipAttributes,
    tokenText,
    type Tree,
} from "../syntax/tree.ts";
import type { FunctionInfo } from "./check.ts";
import { Stages } from "./interface.ts";
import type { Resolution as OverloadResolution } from "./overloads.ts";
import { memoryRoot } from "./resolve.ts";
import { Kind, loaded, type Type } from "./types.ts";

/** Behaviors of statements as a bit set. */
export enum Behavior {
    Next = 1,
    Return = 2,
    Break = 4,
    Continue = 8,
}

/** Semantic facts of a valid module the uniformity analysis depends on. */
export interface UniformityInput {
    readonly tree: Tree;
    readonly refs: Uint32Array;
    /** Module-scope declarations in dependency order. */
    readonly order: readonly number[];
    readonly types: readonly (Type | undefined)[];
    readonly overloads: readonly (OverloadResolution | undefined)[];
    readonly functions: ReadonlyMap<number, FunctionInfo>;
    /** Whether the load rule is applied to each expression node. */
    readonly loads: Uint8Array;
    /** Behaviors of each statement node. */
    readonly behaviors: Uint8Array;
    /** Severities of the diagnostic rules set with the diagnostic directives. */
    readonly directives: ReadonlyMap<string, string>;
    /** Uniformity the builtins called in the module require; nothing to analyze without any. */
    readonly requirements: Requirement;
}

/**
 * Analyzes the uniformity of the control flow and values in the functions, reporting the
 * builtins requiring uniformity that may be invoked from non-uniform control flow.
 */
export function analyzeUniformity(
    input: UniformityInput,
    subgroupUniformity: boolean,
    diagnostics: Diagnostic[],
): void {
    const { requirements } = input;
    if (!requirements) return;
    if (!subgroupUniformity) new Uniformity(input, Scope.All, diagnostics).run();
    else if (
        !(requirements & Requirement.Workgroup) ||
        new Uniformity(input, Scope.Workgroup, diagnostics).run()
    )
        if (requirements & Requirement.Subgroup)
            new Uniformity(input, Scope.Subgroup, diagnostics).run();
}

/** Uniformity the builtins called in a module require, as a bit set. */
export enum Requirement {
    None = 0,
    Workgroup = 1,
    Subgroup = 2,
}

/** Returns the uniformity the builtin function requires. */
export function requirementOf(name: string): Requirement {
    if (isBarrier(name) || name === "workgroupUniformLoad" || isDerivative(name))
        return Requirement.Workgroup;
    if (name.startsWith("subgroup") || name.startsWith("quad")) return Requirement.Subgroup;
    return Requirement.None;
}

/** Scope in which the uniformity is analyzed. */
enum Scope {
    All,
    Workgroup,
    Subgroup,
}

enum Tag {
    None,
    ValueRequired,
    ContentsRequired,
}

enum NodeType {
    Regular,
    ArgumentValue,
    ArgumentContents,
    PointerArgumentResult,
    ReturnValue,
    PointerParameterContents,
}

class GraphNode {
    readonly edges: GraphNode[] = [];
    visitedFrom: GraphNode | undefined = undefined;
    affectsControlFlow = false;
    type = NodeType.Regular;
    argIndex = 0;

    constructor(readonly ast: number) {}

    edge(to: GraphNode): void {
        this.edges.push(to);
    }
}

interface Parameter {
    readonly decl: number;
    direct: Tag;
    directSeverity: Severity;
    retval: Tag;
    pointerMayBecomeNonUniform: boolean;
    readonly sourceValues: number[];
    readonly sourceContents: number[];
    readonly value: GraphNode;
    readonly inputContents: GraphNode | undefined;
    readonly outputContents: GraphNode | undefined;
}

interface FunctionGraph {
    readonly decl: number;
    readonly name: string;
    readonly nodes: GraphNode[];
    readonly parameters: Parameter[];
    readonly required: Record<Severity, GraphNode>;
    readonly mayBeNonUniform: GraphNode;
    readonly cfStart: GraphNode;
    readonly valueReturn: GraphNode | undefined;
    /** Severity of the requirement for the function to be called from uniform control flow. */
    callsite: Severity | undefined;
    returnMayBeNonUniform: boolean;
}

interface LoopSwitch {
    readonly varIn: Map<number, GraphNode>;
    readonly varContinuing: Map<number, GraphNode>;
    readonly varExit: Map<number, GraphNode>;
}

const severities: readonly Severity[] = ["error", "warning", "info"];

const subgroupUniformResults = new Set([
    "subgroupAdd",
    "subgroupAll",
    "subgroupAnd",
    "subgroupAny",
    "subgroupBallot",
    "subgroupBroadcast",
    "subgroupBroadcastFirst",
    "subgroupMax",
    "subgroupMin",
    "subgroupMul",
    "subgroupOr",
    "subgroupXor",
]);

const atomics = new Set([
    "atomicLoad",
    "atomicStore",
    "atomicAdd",
    "atomicSub",
    "atomicMax",
    "atomicMin",
    "atomicAnd",
    "atomicOr",
    "atomicXor",
    "atomicExchange",
    "atomicCompareExchangeWeak",
]);

/** Port of Tint's uniformity graph, building and traversing the graph of each function. */
class Uniformity {
    private readonly tree: Tree;
    private readonly refs: Uint32Array;
    private readonly types: readonly (Type | undefined)[];
    private readonly graphs = new Map<number, FunctionGraph>();
    private readonly loopSwitches = new Map<number, LoopSwitch>();
    private fn!: FunctionGraph;
    /** Stack of the scopes mapping the variables to the nodes of their current values. */
    private variables: Map<number, GraphNode>[] = [];
    /** Function-scope variables and pointer parameters in scope. */
    private readonly localVars = new Set<number>();
    /** Pointers to a part of the variable they point to. */
    private readonly partialPointers = new Set<number>();

    constructor(
        private readonly input: UniformityInput,
        private readonly scope: Scope,
        private readonly diagnostics: Diagnostic[],
    ) {
        this.tree = input.tree;
        this.refs = input.refs;
        this.types = input.types;
    }

    run(): boolean {
        for (const decl of this.input.order)
            if (this.tree.kinds[decl] === Node.Function && !this.function(decl)) return false;
        return true;
    }

    // ---- graph ----

    private node(ast = 0): GraphNode {
        const node = new GraphNode(ast);
        this.fn.nodes.push(node);
        return node;
    }

    private get(variable: number): GraphNode | undefined {
        for (let i = this.variables.length - 1; i >= 0; i--) {
            const node = this.variables[i]!.get(variable);
            if (node) return node;
        }
        return undefined;
    }

    private set(variable: number, node: GraphNode): void {
        this.variables[this.variables.length - 1]!.set(variable, node);
    }

    private loopSwitch(statement: number): LoopSwitch {
        let info = this.loopSwitches.get(statement);
        if (!info) {
            info = { varIn: new Map(), varContinuing: new Map(), varExit: new Map() };
            this.loopSwitches.set(statement, info);
        }
        return info;
    }

    private behavior(statement: number): number {
        return this.input.behaviors[statement]!;
    }

    private isGlobal(decl: number): boolean {
        return this.tree.parents[decl] === 0;
    }

    private isInside(node: number, ancestor: number): boolean {
        for (let n = node; n; n = this.tree.parents[n]!) if (n === ancestor) return true;
        return false;
    }

    private parameter(decl: number): Parameter {
        return this.fn.parameters.find(p => p.decl === decl)!;
    }

    // ---- functions ----

    private function(decl: number): boolean {
        const { tree } = this;
        const nodes: GraphNode[] = [];
        const create = (): GraphNode => {
            const node = new GraphNode(0);
            nodes.push(node);
            return node;
        };
        const parameters: Parameter[] = [];
        const fn: FunctionGraph = {
            decl,
            name: nameOf(tree, decl),
            nodes,
            parameters,
            required: { error: create(), warning: create(), info: create() },
            mayBeNonUniform: create(),
            cfStart: create(),
            valueReturn: childOf(tree, decl, Node.Result) ? create() : undefined,
            callsite: undefined,
            returnMayBeNonUniform: false,
        };
        this.fn = fn;
        this.graphs.set(decl, fn);
        this.variables = [new Map()];
        this.localVars.clear();
        this.partialPointers.clear();
        for (let param = tree.firsts[decl]!; param; param = tree.nexts[param]!) {
            if (tree.kinds[param] !== Node.Param) continue;
            const pointer = this.types[param]!.kind === Kind.Pointer;
            const value = this.node(param);
            const inputContents = pointer ? this.node(param) : undefined;
            parameters.push({
                decl: param,
                direct: Tag.None,
                directSeverity: "error",
                retval: Tag.None,
                pointerMayBecomeNonUniform: false,
                sourceValues: [],
                sourceContents: [],
                value,
                inputContents,
                outputContents: pointer ? this.node() : undefined,
            });
            if (inputContents) {
                inputContents.type = NodeType.PointerParameterContents;
                this.set(param, inputContents);
                this.localVars.add(param);
            } else this.set(param, value);
        }
        this.statement(fn.cfStart, childOf(tree, decl, Node.Block));

        const tagOf = (reachable: Set<GraphNode>, param: Parameter): Tag => {
            if (param.inputContents && reachable.has(param.inputContents))
                return Tag.ContentsRequired;
            return reachable.has(param.value) ? Tag.ValueRequired : Tag.None;
        };
        const reachable = new Set<GraphNode>();
        for (const severity of severities) {
            this.traverse(fn.required[severity], reachable);
            if (reachable.has(fn.mayBeNonUniform)) {
                this.error(fn, fn.mayBeNonUniform, severity);
                if (severity === "error") return false;
                break;
            }
            if (reachable.has(fn.cfStart)) fn.callsite ??= severity;
            for (const param of parameters)
                if (param.direct === Tag.None) {
                    param.direct = tagOf(reachable, param);
                    param.directSeverity = severity;
                }
        }
        if (fn.valueReturn) {
            this.resetVisited(fn);
            const reachable = new Set<GraphNode>();
            this.traverse(fn.valueReturn, reachable);
            fn.returnMayBeNonUniform = reachable.has(fn.mayBeNonUniform);
            for (const param of parameters) param.retval = tagOf(reachable, param);
        }
        for (const param of parameters) {
            if (!param.outputContents) continue;
            this.resetVisited(fn);
            const reachable = new Set<GraphNode>();
            this.traverse(param.outputContents, reachable);
            param.pointerMayBecomeNonUniform = reachable.has(fn.mayBeNonUniform);
            for (let i = 0; i < parameters.length; i++) {
                const tag = tagOf(reachable, parameters[i]!);
                if (tag === Tag.ContentsRequired) param.sourceContents.push(i);
                else if (tag === Tag.ValueRequired) param.sourceValues.push(i);
            }
        }
        return true;
    }

    // ---- statements ----

    private statement(cf: GraphNode, stmt: number): GraphNode {
        const { tree } = this;
        switch (tree.kinds[stmt]) {
            case Node.Assign: {
                const lhs = tree.firsts[stmt]!;
                const rhs = tree.nexts[lhs]!;
                if (tree.kinds[lhs] === Node.Phony) {
                    this.expression(cf, rhs);
                    return cf;
                }
                const [lvalue, root] = this.lvalue(cf, lhs);
                if (tokenText(tree, stmt) === "=") lvalue.edge(this.expression(cf, rhs));
                else {
                    const load = this.get(root);
                    const result = this.node();
                    result.edge(this.expression(cf, rhs));
                    if (load) result.edge(load);
                    lvalue.edge(result);
                }
                if (root) this.set(root, lvalue);
                return cf;
            }
            case Node.IncDec: {
                const [lvalue, root] = this.lvalue(cf, tree.firsts[stmt]!);
                const load = this.get(root);
                const result = this.node();
                result.edge(cf);
                if (load) result.edge(load);
                lvalue.edge(result);
                if (root) this.set(root, lvalue);
                return cf;
            }
            case Node.Block:
                return this.block(cf, stmt);
            case Node.Break:
                this.exit(this.enclosing(stmt, true));
                return cf;
            case Node.BreakIf: {
                const v = this.node(stmt);
                v.affectsControlFlow = true;
                v.edge(this.expression(cf, tree.firsts[stmt]!));
                this.exit(this.enclosing(stmt, false));
                const end = this.node();
                end.edge(v);
                return end;
            }
            case Node.Call:
                this.call(cf, stmt);
                return cf;
            case Node.Continue:
                this.continueStatement(stmt);
                return cf;
            case Node.For:
                return this.forLoop(cf, stmt);
            case Node.While:
                return this.whileLoop(cf, stmt);
            case Node.If:
                return this.ifStatement(cf, stmt);
            case Node.Loop:
                return this.loop(cf, stmt);
            case Node.Switch:
                return this.switchStatement(cf, stmt);
            case Node.Return: {
                const value = tree.firsts[stmt];
                if (value) this.fn.valueReturn!.edge(this.expression(cf, value));
                this.outputPointerContents();
                return cf;
            }
            case Node.Var:
            case Node.Let:
            case Node.Const: {
                const init = initializerOf(tree, stmt);
                let node = cf;
                if (init) {
                    node = this.expression(cf, init);
                    if (this.types[stmt]!.kind === Kind.Pointer && this.isPartialPointer(init))
                        this.partialPointers.add(stmt);
                }
                this.set(stmt, node);
                if (tree.kinds[stmt] === Node.Var) this.localVars.add(stmt);
                return cf;
            }
            default:
                return cf;
        }
    }

    private outputPointerContents(): void {
        for (const param of this.fn.parameters) param.outputContents?.edge(this.get(param.decl)!);
    }

    /** Returns the loop, or the loop or switch with `orSwitch`, enclosing the statement. */
    private enclosing(stmt: number, orSwitch: boolean): number {
        const { tree } = this;
        for (let n = tree.parents[stmt]!; ; n = tree.parents[n]!) {
            const kind = tree.kinds[n];
            if (
                kind === Node.Loop ||
                kind === Node.For ||
                kind === Node.While ||
                (orSwitch && kind === Node.Switch)
            )
                return n;
        }
    }

    /** Merges the values of the variables declared outside the construct into its exit values. */
    private exit(construct: number): void {
        const info = this.loopSwitch(construct);
        for (const variable of this.localVars)
            if (!this.isInside(variable, construct))
                this.exitNode(info, variable).edge(this.get(variable)!);
    }

    private exitNode(info: LoopSwitch, variable: number): GraphNode {
        let node = info.varExit.get(variable);
        if (!node) info.varExit.set(variable, (node = this.node()));
        return node;
    }

    private continueStatement(stmt: number): void {
        const { tree } = this;
        const loop = this.enclosing(stmt, false);
        const info = this.loopSwitch(loop);
        let continuing: boolean;
        if (tree.kinds[loop] === Node.Loop) {
            const node = childOf(tree, skipAttributes(tree, loop), Node.Continuing);
            continuing = node !== 0 && skipAttributes(tree, tree.firsts[node]!) !== 0;
        } else
            continuing =
                tree.kinds[loop] === Node.For && tree.kinds[this.forParts(loop)[2]] !== Node.Empty;
        if (!continuing) this.loopBack(info);
        else
            for (const variable of this.localVars) {
                let node = info.varContinuing.get(variable);
                if (!node) info.varContinuing.set(variable, (node = this.node(variable)));
                node.edge(this.get(variable)!);
            }
    }

    /** Links the loop entry values of the variables to their values at the end of the iteration. */
    private loopBack(info: LoopSwitch): void {
        for (const [variable, node] of info.varIn) {
            const out = this.get(variable)!;
            if (out !== node) node.edge(out);
        }
    }

    /** Creates the loop entry values of the variables in scope. */
    private loopEntry(info: LoopSwitch, ast: boolean): void {
        for (const variable of this.localVars) {
            const node = this.node(ast ? variable : 0);
            node.edge(this.get(variable)!);
            info.varIn.set(variable, node);
            this.set(variable, node);
        }
    }

    /** Sets the values of the variables to the continuing block entry values. */
    private enterContinuing(info: LoopSwitch, behavior: number): void {
        for (const [variable, node] of info.varContinuing) {
            if (behavior & Behavior.Next) {
                const end = this.get(variable);
                if (end) node.edge(end);
            }
            this.set(variable, node);
        }
    }

    private block(cf: GraphNode, block: number): GraphNode {
        const { tree } = this;
        const parent = tree.parents[block]!;
        const behavior = this.behavior(block);
        this.variables.push(new Map());
        for (let stmt = skipAttributes(tree, block); stmt; stmt = tree.nexts[stmt]!) {
            if (tree.kinds[stmt] === Node.Continuing) break;
            cf = this.statement(cf, stmt);
            if (!(this.behavior(stmt) & Behavior.Next)) break;
        }
        if (tree.kinds[parent] === Node.Loop && behavior & (Behavior.Next | Behavior.Continue)) {
            const info = this.loopSwitch(parent);
            const continuing = childOf(tree, block, Node.Continuing);
            if (continuing) {
                this.enterContinuing(info, behavior);
                cf = this.statement(cf, tree.firsts[continuing]!);
            }
            this.loopBack(info);
        }
        if (tree.kinds[parent] === Node.Function) this.outputPointerContents();
        const assigned = this.variables.pop()!;
        if (behavior & Behavior.Next)
            for (const [variable, node] of assigned) this.set(variable, node);
        for (let stmt = tree.firsts[block]!; stmt; stmt = tree.nexts[stmt]!)
            if (tree.kinds[stmt] === Node.Var) this.localVars.delete(stmt);
        return cf;
    }

    private forParts(loop: number): [number, number, number, number] {
        const { tree } = this;
        const init = skipAttributes(tree, loop);
        const cond = tree.nexts[init]!;
        const update = tree.nexts[cond]!;
        return [init, cond, update, tree.nexts[update]!];
    }

    private forLoop(cf: GraphNode, loop: number): GraphNode {
        const { tree } = this;
        const [init, cond, update, body] = this.forParts(loop);
        const iterationStart = this.node();
        const initEnd = tree.kinds[init] === Node.Empty ? cf : this.statement(cf, init);
        const info = this.loopSwitch(loop);
        this.loopEntry(info, false);
        let bodyStart = iterationStart;
        if (tree.kinds[cond] !== Node.Empty) {
            bodyStart = this.node(loop);
            bodyStart.affectsControlFlow = true;
            bodyStart.edge(this.expression(iterationStart, cond));
            for (const variable of this.localVars)
                this.exitNode(info, variable).edge(this.get(variable)!);
        }
        const bodyEnd = this.statement(bodyStart, body);
        const behavior = this.behavior(body);
        const proceeds = (behavior & (Behavior.Next | Behavior.Continue)) !== 0;
        let iterationEnd = bodyEnd;
        if (tree.kinds[update] !== Node.Empty && proceeds) {
            this.enterContinuing(info, behavior);
            iterationEnd = this.statement(bodyEnd, update);
        }
        if (proceeds) iterationStart.edge(iterationEnd);
        iterationStart.edge(initEnd);
        this.loopBack(info);
        for (const [variable, node] of info.varExit) this.set(variable, node);
        if (tree.kinds[init] === Node.Var) this.localVars.delete(init);
        this.loopSwitches.delete(loop);
        if (behavior & Behavior.Return) return proceeds ? iterationStart : bodyEnd;
        return cf;
    }

    private whileLoop(cf: GraphNode, loop: number): GraphNode {
        const { tree } = this;
        const cond = skipAttributes(tree, loop);
        const start = this.node();
        const info = this.loopSwitch(loop);
        this.loopEntry(info, false);
        const condEnd = this.node(loop);
        condEnd.affectsControlFlow = true;
        condEnd.edge(this.expression(start, cond));
        for (const variable of this.localVars)
            this.exitNode(info, variable).edge(this.get(variable)!);
        start.edge(this.statement(condEnd, tree.nexts[cond]!));
        start.edge(cf);
        this.loopBack(info);
        for (const [variable, node] of info.varExit) this.set(variable, node);
        this.loopSwitches.delete(loop);
        return this.behavior(loop) === Behavior.Next ? cf : start;
    }

    private loop(cf: GraphNode, loop: number): GraphNode {
        const body = skipAttributes(this.tree, loop);
        const start = this.node();
        const info = this.loopSwitch(loop);
        this.loopEntry(info, true);
        const bodyEnd = this.statement(start, body);
        if (this.behavior(body) & (Behavior.Next | Behavior.Continue)) start.edge(bodyEnd);
        start.edge(cf);
        for (const [variable, node] of info.varExit) this.set(variable, node);
        this.loopSwitches.delete(loop);
        return this.behavior(loop) & Behavior.Return ? bodyEnd : cf;
    }

    private ifStatement(cf: GraphNode, stmt: number): GraphNode {
        const { tree } = this;
        const cond = skipAttributes(tree, stmt);
        const body = tree.nexts[cond]!;
        const otherwise = tree.nexts[body]!;
        const v = this.node(stmt);
        v.affectsControlFlow = true;
        v.edge(this.expression(cf, cond));
        this.variables.push(new Map());
        const trueEnd = this.statement(v, body);
        const trueVars = this.variables.pop()!;
        const trueNext = (this.behavior(body) & Behavior.Next) !== 0;
        let falseEnd: GraphNode | undefined;
        let falseVars: Map<number, GraphNode> | undefined;
        let falseNext = true;
        if (otherwise) {
            this.variables.push(new Map());
            falseEnd = this.statement(v, otherwise);
            falseVars = this.variables.pop()!;
            falseNext = (this.behavior(otherwise) & Behavior.Next) !== 0;
        }
        for (const variable of this.localVars) {
            const trueValue = trueVars.get(variable);
            const falseValue = falseVars?.get(variable);
            if (!trueValue && !falseValue) continue;
            const out = this.node();
            if (trueNext) out.edge(trueValue ?? this.get(variable)!);
            if (falseNext) out.edge(falseValue ?? this.get(variable)!);
            this.set(variable, out);
        }
        if (this.behavior(stmt) === Behavior.Next) return cf;
        const end = this.node();
        end.edge(trueEnd);
        if (falseEnd) end.edge(falseEnd);
        return end;
    }

    private switchStatement(cf: GraphNode, stmt: number): GraphNode {
        const { tree } = this;
        const selector = skipAttributes(tree, stmt);
        const v = this.node(stmt);
        v.affectsControlFlow = true;
        v.edge(this.expression(cf, selector));
        const end = this.behavior(stmt) === Behavior.Next ? undefined : this.node();
        const info = this.loopSwitch(stmt);
        for (let clause = tree.nexts[selector]!; clause; clause = tree.nexts[clause]!) {
            if (tree.kinds[clause] !== Node.Case) continue;
            let body = tree.firsts[clause]!;
            while (tree.kinds[body] !== Node.Block) body = tree.nexts[body]!;
            this.variables.push(new Map());
            const caseEnd = this.statement(v, body);
            end?.edge(caseEnd);
            if (this.behavior(body) & Behavior.Next)
                for (const variable of this.localVars)
                    if (!this.isInside(variable, stmt))
                        this.exitNode(info, variable).edge(this.get(variable)!);
            this.variables.pop();
        }
        for (const [variable, node] of info.varExit) this.set(variable, node);
        this.loopSwitches.delete(stmt);
        return end ?? cf;
    }

    // ---- expressions ----

    private expression(cf: GraphNode, expr: number, load = false): GraphNode {
        const { tree } = this;
        if (this.input.loads[expr]) load = true;
        switch (tree.kinds[expr]) {
            case Node.Binary: {
                const lhs = tree.firsts[expr]!;
                const rhs = tree.nexts[lhs]!;
                const op = tokenText(tree, expr);
                if (op === "&&" || op === "||") {
                    const lhsEnd = this.node(expr);
                    lhsEnd.affectsControlFlow = true;
                    lhsEnd.edge(this.expression(cf, lhs));
                    this.variables.push(new Map());
                    const v = this.expression(lhsEnd, rhs);
                    const rhsVars = this.variables.pop()!;
                    for (const variable of this.localVars) {
                        const value = rhsVars.get(variable);
                        if (!value) continue;
                        const out = this.node();
                        out.edge(value);
                        out.edge(this.get(variable)!);
                        this.set(variable, out);
                    }
                    return v;
                }
                const v1 = this.expression(cf, lhs);
                const v2 = this.expression(cf, rhs);
                const result = this.node(expr);
                result.edge(v1);
                result.edge(v2);
                return result;
            }
            case Node.Call:
                return this.call(cf, expr);
            case Node.Ident:
                return this.ident(cf, expr, load);
            case Node.Index: {
                const object = tree.firsts[expr]!;
                const v1 = this.expression(cf, tree.nexts[object]!);
                const v2 = this.expression(cf, object, load);
                const result = this.node();
                result.edge(v1);
                result.edge(v2);
                return result;
            }
            case Node.Member:
            case Node.Unary:
            case Node.Paren:
                return this.expression(cf, tree.firsts[expr]!, load);
            default:
                return cf;
        }
    }

    private ident(cf: GraphNode, ident: number, load: boolean): GraphNode {
        const { tree, fn } = this;
        const node = this.node(ident);
        const decl = this.refs[ident]!;
        const kind = tree.kinds[decl];
        const type = this.types[decl]!;
        if (kind === Node.Param) {
            const stage = this.input.functions.get(tree.parents[decl]!)!.stage;
            if (stage) {
                const nonUniform =
                    type.kind === Kind.Struct
                        ? type.members.some(member => this.nonUniformInput(member.node, stage))
                        : this.nonUniformInput(decl, stage);
                node.edge(nonUniform ? fn.mayBeNonUniform : cf);
                return node;
            }
            node.edge(cf);
            if (type.kind !== Kind.Pointer) node.edge(this.get(decl)!);
            else if (!load) node.edge(this.parameter(decl).value);
            else if (type.space === "function" || type.access === "read")
                node.edge(this.get(decl)!);
            else node.edge(fn.mayBeNonUniform);
            return node;
        }
        if (this.isGlobal(decl)) {
            const nonUniform = kind === Node.Var && type.access !== "read" && load;
            node.edge(nonUniform ? fn.mayBeNonUniform : cf);
            return node;
        }
        node.edge(cf);
        const value = this.get(decl)!;
        if (type.kind === Kind.Pointer) {
            if (load) {
                const root = this.rootOf(ident);
                if (!this.isGlobal(root)) node.edge(this.get(root)!);
                else if (this.types[root]!.access !== "read") node.edge(fn.mayBeNonUniform);
            }
            node.edge(value);
        } else if (kind !== Node.Var || load) node.edge(value);
        return node;
    }

    /** Whether the entry point parameter or structure member may have a non-uniform value. */
    private nonUniformInput(decl: number, stage: Stages): boolean {
        const { tree } = this;
        for (
            let attr = tree.firsts[decl]!;
            tree.kinds[attr] === Node.Attribute;
            attr = tree.nexts[attr]!
        ) {
            if (tokenText(tree, attr) !== "builtin") continue;
            if (stage !== Stages.Compute) return true;
            switch (tokenText(tree, tree.firsts[attr]!)) {
                case "num_subgroups":
                case "num_workgroups":
                case "subgroup_size":
                case "workgroup_id":
                    return false;
                case "subgroup_id":
                    return this.scope !== Scope.Subgroup;
                default:
                    return true;
            }
        }
        return true;
    }

    private rootOf(expr: number): number {
        return memoryRoot(this.tree, this.refs, expr);
    }

    /** Whether the pointer expression points to a part of its root variable. */
    private isPartialPointer(expr: number): boolean {
        const { tree } = this;
        for (;;) {
            const kind = tree.kinds[expr];
            if (kind === Node.Paren) expr = tree.firsts[expr]!;
            else if (kind === Node.Unary) {
                const op = tokenText(tree, expr);
                if (op !== "*" && op !== "&") return false;
                expr = tree.firsts[expr]!;
            } else if (kind === Node.Ident) return this.partialPointers.has(this.refs[expr]!);
            else return kind === Node.Index || kind === Node.Member;
        }
    }

    /** Whether the member expression is a swizzle selecting all the components of a vector. */
    private isFullSwizzle(member: number): boolean {
        const { tree } = this;
        let object = member;
        let width = 0;
        for (;;) {
            object = tree.firsts[object]!;
            while (tree.kinds[object] === Node.Paren) object = tree.firsts[object]!;
            const type = this.types[object]!;
            const store = type.kind === Kind.Pointer ? type.elem! : loaded(type);
            if (store.kind !== Kind.Vector) break;
            width = store.count;
            if (tree.kinds[object] !== Node.Member) break;
        }
        return tokenText(tree, member).length === width;
    }

    /** Processes the left-hand side of an assignment; returns its new value and root variable. */
    private lvalue(
        cf: GraphNode,
        expr: number,
        dereferencing = false,
        partial = false,
    ): [GraphNode, number] {
        const { tree } = this;
        switch (tree.kinds[expr]) {
            case Node.Ident: {
                const decl = this.refs[expr]!;
                if (this.isGlobal(decl)) return [this.fn.mayBeNonUniform, 0];
                let root = decl;
                const value = this.node();
                if (tree.kinds[decl] === Node.Param) value.edge(this.parameter(decl).value);
                else if (dereferencing) {
                    root = this.rootOf(initializerOf(tree, decl));
                    value.edge(this.get(decl)!);
                }
                const old = this.get(root);
                if (partial && old) value.edge(old);
                return [value, root];
            }
            case Node.Index: {
                const object = tree.firsts[expr]!;
                const index = this.expression(cf, tree.nexts[object]!);
                const deref = dereferencing || this.types[object]!.kind === Kind.Pointer;
                const lvalue = this.lvalue(cf, object, deref, true);
                lvalue[0].edge(index);
                return lvalue;
            }
            case Node.Member: {
                const object = tree.firsts[expr]!;
                const deref = dereferencing || this.types[object]!.kind === Kind.Pointer;
                return this.lvalue(cf, object, deref, partial || !this.isFullSwizzle(expr));
            }
            case Node.Unary: {
                const operand = tree.firsts[expr]!;
                if (tokenText(tree, expr) === "*")
                    return this.lvalue(cf, operand, true, partial || this.isPartialPointer(expr));
                return this.lvalue(cf, operand, false, partial);
            }
            case Node.Paren:
                return this.lvalue(cf, tree.firsts[expr]!, dereferencing, partial);
            default:
                return [this.call(cf, expr), this.rootOf(tree.nexts[tree.firsts[expr]!]!)];
        }
    }

    // ---- calls ----

    private call(cf: GraphNode, call: number): GraphNode {
        const { tree, fn } = this;
        const callee = tree.firsts[call]!;
        const graph = this.graphs.get(this.refs[callee]!);
        const resolution = this.input.overloads[call];
        const builtin =
            !graph && resolution?.overload.kind === "function" ? resolution.overload.name : "";
        const args: GraphNode[] = [];
        const contents: (GraphNode | undefined)[] = [];
        const argNodes: number[] = [];
        for (let arg = tree.nexts[callee]!; arg; arg = tree.nexts[arg]!) {
            const value = this.node(call);
            value.type = NodeType.ArgumentValue;
            value.argIndex = args.length;
            value.edge(this.expression(cf, arg));
            let content: GraphNode | undefined;
            if (this.types[arg]!.kind === Kind.Pointer) {
                content = this.node(call);
                content.type = NodeType.ArgumentContents;
                content.argIndex = args.length;
                const root = this.rootOf(arg);
                if (!this.isGlobal(root)) content.edge(this.get(root)!);
                else if (this.types[root]!.access !== "read") content.edge(fn.mayBeNonUniform);
                content.edge(value);
            }
            args.push(value);
            contents.push(content);
            argNodes.push(arg);
        }
        const callNode = this.node(call);
        callNode.edge(cf);
        const result = this.node(call);
        result.type = NodeType.ReturnValue;
        let callsite: Severity | undefined;
        let nonUniformResult = false;
        if (graph) {
            callsite = graph.callsite;
            nonUniformResult = graph.returnMayBeNonUniform;
        } else if (builtin) {
            if (isBarrier(builtin) || builtin === "workgroupUniformLoad") {
                if (this.scope !== Scope.Subgroup) callsite = "error";
            } else if (isDerivative(builtin)) {
                const severity = this.severity(call, "derivative_uniformity");
                if (severity && this.scope !== Scope.Subgroup) callsite = severity;
                nonUniformResult = true;
            } else if (atomics.has(builtin)) nonUniformResult = true;
            else if (builtin === "textureLoad")
                nonUniformResult = resolution!.params[0]!.access === "read_write";
            else if (builtin.startsWith("subgroup") || builtin.startsWith("quad")) {
                const severity = this.severity(call, "subgroup_uniformity");
                if (severity && this.scope !== Scope.Workgroup) callsite = severity;
                nonUniformResult =
                    this.scope !== Scope.Subgroup || !subgroupUniformResults.has(builtin);
            }
        }
        if (nonUniformResult) result.edge(fn.mayBeNonUniform);
        result.edge(callNode);
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]!;
            const content = contents[i];
            if (graph) {
                const param = graph.parameters[i]!;
                if (param.direct === Tag.ValueRequired) fn.required[param.directSeverity].edge(arg);
                else if (param.direct === Tag.ContentsRequired)
                    fn.required[param.directSeverity].edge(content!);
                if (param.retval === Tag.ValueRequired) result.edge(arg);
                else if (param.retval === Tag.ContentsRequired) result.edge(content!);
                if (!content) continue;
                const pointerResult = this.node(call);
                pointerResult.type = NodeType.PointerArgumentResult;
                pointerResult.argIndex = i;
                if (param.pointerMayBecomeNonUniform) pointerResult.edge(fn.mayBeNonUniform);
                else {
                    pointerResult.edge(callNode);
                    for (const source of param.sourceValues) pointerResult.edge(args[source]!);
                    for (const source of param.sourceContents)
                        pointerResult.edge(contents[source]!);
                }
                const root = this.rootOf(argNodes[i]!);
                const old = this.get(root);
                if (old && this.isPartialPointer(argNodes[i]!)) pointerResult.edge(old);
                this.set(root, pointerResult);
            } else if (builtin === "workgroupUniformLoad" && this.scope !== Scope.Subgroup)
                fn.required.error.edge(arg);
            else if (i === 1 && isShuffle(builtin)) {
                const severity = this.severity(argNodes[i]!, "subgroup_uniformity");
                if (severity && this.scope !== Scope.Workgroup) fn.required[severity].edge(arg);
            } else result.edge(arg);
        }
        if (callsite) fn.required[callsite].edge(callNode);
        return result;
    }

    /** Returns the severity of the diagnostic rule at the node, or undefined when it's off. */
    private severity(node: number, rule: string): Severity | undefined {
        const { tree } = this;
        let severity: string | undefined;
        for (let n = node; n && !severity; n = tree.parents[n]!)
            for (let attr = tree.firsts[n]!; attr; attr = tree.nexts[attr]!)
                if (
                    tree.kinds[attr] === Node.Attribute &&
                    tokenText(tree, attr) === "diagnostic" &&
                    ruleName(tree, childOf(tree, attr, Node.Rule)) === rule
                ) {
                    severity = tokenText(tree, childOf(tree, attr, Node.Name));
                    break;
                }
        severity ??= this.input.directives.get(rule) ?? "error";
        return severity === "off" ? undefined : (severity as Severity);
    }

    // ---- traversal and diagnostics ----

    private traverse(source: GraphNode, reachable?: Set<GraphNode>): void {
        const stack = [source];
        while (stack.length > 0) {
            const node = stack.pop()!;
            reachable?.add(node);
            for (const to of node.edges)
                if (!to.visitedFrom) {
                    to.visitedFrom = node;
                    stack.push(to);
                }
        }
    }

    private resetVisited(fn: FunctionGraph): void {
        for (const node of fn.nodes) node.visitedFrom = undefined;
    }

    /** Reports the uniformity failure of the function caused by the node; returns its notes. */
    private error(fn: FunctionGraph, source: GraphNode, severity: Severity): Note[] {
        const { tree } = this;
        const required = fn.required[severity];
        this.resetVisited(fn);
        this.traverse(required);
        let cause = source;
        while (cause.visitedFrom !== required) cause = cause.visitedFrom!;
        const call = cause.ast;
        const callee = tree.firsts[call]!;
        const name = tokenText(tree, callee);
        if (cause.type === NodeType.ArgumentValue || cause.type === NodeType.ArgumentContents) {
            const value = cause.type === NodeType.ArgumentValue;
            const arg = this.argument(call, cause.argIndex);
            const graph = this.graphs.get(this.refs[callee]!);
            let notes: Note[];
            if (graph) {
                const param = graph.parameters[cause.argIndex]!;
                notes = this.error(graph, value ? param.value : param.inputContents!, severity);
                const via = value ? "" : " via pointer";
                this.note(notes, arg, `possibly non-uniform value passed${via} here`);
            } else {
                const what = value ? "be uniform" : "have uniform contents";
                const message = `'${name}' requires argument ${cause.argIndex} to ${what}`;
                notes = this.report(arg, message, severity);
            }
            this.sourceNote(notes, source.visitedFrom!);
            return notes;
        }
        const builtin = this.builtinRequiringUniformity(call, severity);
        const builtinName = tree.firsts[builtin]!;
        const scope = this.scope === Scope.Subgroup ? "subgroup " : "";
        const notes = this.report(
            builtinName,
            `'${tokenText(tree, builtinName)}' must only be called from ${scope}uniform control flow`,
            severity,
        );
        if (builtin !== call) {
            const indirectly = this.functionOf(builtin) !== this.refs[callee] ? "indirectly " : "";
            this.note(notes, call, `called ${indirectly}by '${name}' from '${fn.name}'`);
        }
        this.resetVisited(fn);
        this.traverse(cause);
        const nonUniform = source === fn.mayBeNonUniform ? source.visitedFrom! : source;
        let flow: GraphNode | undefined = nonUniform;
        while (flow && !flow.affectsControlFlow) flow = flow.visitedFrom;
        if (flow) this.note(notes, flow.ast, "control flow depends on possibly non-uniform value");
        this.sourceNote(notes, nonUniform);
        return notes;
    }

    /** Adds the note explaining the source of the non-uniformity. */
    private sourceNote(notes: Note[], source: GraphNode): void {
        const { tree } = this;
        const node = source.ast;
        switch (tree.kinds[node]) {
            case Node.Ident: {
                const decl = this.refs[node]!;
                if (tree.kinds[decl] !== Node.Param) this.readNote(notes, node, decl);
                else this.parameterNote(notes, node, decl, false);
                return;
            }
            case Node.Param:
                this.parameterNote(
                    notes,
                    node,
                    node,
                    source.type === NodeType.PointerParameterContents,
                );
                return;
            case Node.Var:
            case Node.Let:
            case Node.Const:
                this.readNote(notes, node, node);
                return;
            case Node.Call: {
                const name = tokenText(tree, tree.firsts[node]!);
                const arg = this.argument(node, source.argIndex);
                if (source.type === NodeType.ReturnValue)
                    this.note(notes, node, `return value of '${name}' may be non-uniform`);
                else if (source.type === NodeType.ArgumentContents) {
                    const root = this.rootOf(arg);
                    this.readNote(notes, root, root);
                } else if (source.type === NodeType.ArgumentValue)
                    this.note(
                        notes,
                        arg,
                        `passing non-uniform pointer to '${name}' may produce a non-uniform output`,
                    );
                else
                    this.note(
                        notes,
                        arg,
                        `contents of pointer may become non-uniform after calling '${name}'`,
                    );
                return;
            }
            default:
                if (node) this.note(notes, node, "result of expression may be non-uniform");
        }
    }

    private readNote(notes: Note[], node: number, decl: number): void {
        const { tree } = this;
        const space = this.types[decl]!.space;
        const kind =
            space === "storage"
                ? "read_write storage buffer "
                : space === "workgroup"
                  ? "workgroup storage variable "
                  : space === "private"
                    ? "module-scope private variable "
                    : "";
        const name = tree.kinds[node] === Node.Ident ? tokenText(tree, node) : nameOf(tree, node);
        this.note(notes, node, `reading from ${kind}'${name}' may result in a non-uniform value`);
    }

    private parameterNote(notes: Note[], node: number, param: number, contents: boolean): void {
        const { tree } = this;
        const name = `'${nameOf(tree, param)}' of '${nameOf(tree, tree.parents[param]!)}'`;
        if (contents) {
            this.note(notes, node, `parameter ${name} may point to a non-uniform value`);
            return;
        }
        let kind = "parameter ";
        for (
            let attr = tree.firsts[param]!;
            tree.kinds[attr] === Node.Attribute;
            attr = tree.nexts[attr]!
        ) {
            const attribute = tokenText(tree, attr);
            if (attribute === "builtin") kind = "builtin ";
            else if (attribute === "location" && kind === "parameter ")
                kind = "user-defined input ";
        }
        this.note(notes, node, `${kind}${name} may be non-uniform`);
    }

    private argument(call: number, index: number): number {
        let arg = this.tree.nexts[this.tree.firsts[call]!]!;
        for (let i = 0; i < index; i++) arg = this.tree.nexts[arg]!;
        return arg;
    }

    /** Returns the function declaration containing the node. */
    private functionOf(node: number): number {
        while (this.tree.kinds[node] !== Node.Function) node = this.tree.parents[node]!;
        return node;
    }

    /** Finds the builtin call requiring uniformity invoked by the call. */
    private builtinRequiringUniformity(call: number, severity: Severity): number {
        const graph = this.graphs.get(this.refs[this.tree.firsts[call]!]!);
        const node = graph?.required[severity].edges.find(n => n.type === NodeType.Regular);
        return node ? this.builtinRequiringUniformity(node.ast, severity) : call;
    }

    private report(node: number, message: string, severity: Severity): Note[] {
        const notes: Note[] = [];
        const { starts, ends } = this.tree;
        this.diagnostics.push({ start: starts[node]!, end: ends[node]!, severity, message, notes });
        return notes;
    }

    /** Adds a note on the expression or declaration, or on the keyword of the statement. */
    private note(notes: Note[], node: number, message: string): void {
        const { tree } = this;
        const kind = tree.kinds[node];
        if (
            kind >= Node.Ident ||
            kind === Node.Param ||
            kind === Node.Var ||
            kind === Node.Let ||
            kind === Node.Const
        )
            notes.push({ start: tree.starts[node]!, end: tree.ends[node]!, message });
        else {
            const token = tree.tokenOf[node]!;
            const { starts, ends } = tree.tokens;
            notes.push({ start: starts[token]!, end: ends[token]!, message });
        }
    }
}

function ruleName(tree: Tree, rule: number): string {
    const first = tree.firsts[rule]!;
    const second = tree.nexts[first]!;
    return second ? `${tokenText(tree, first)}.${tokenText(tree, second)}` : tokenText(tree, first);
}

function isBarrier(name: string): boolean {
    return name === "workgroupBarrier" || name === "storageBarrier" || name === "textureBarrier";
}

function isDerivative(name: string): boolean {
    return (
        name.startsWith("dpdx") ||
        name.startsWith("dpdy") ||
        name.startsWith("fwidth") ||
        name === "textureSample" ||
        name === "textureSampleBias" ||
        name === "textureSampleCompare"
    );
}

function isShuffle(name: string): boolean {
    return (
        name === "subgroupShuffleUp" ||
        name === "subgroupShuffleDown" ||
        name === "subgroupShuffleXor"
    );
}
