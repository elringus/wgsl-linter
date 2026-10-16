import type { Diagnostic } from "../syntax/diagnostic.ts";
import { childOf, initializerOf, Node, tokenText, type Tree } from "../syntax/tree.ts";

/** Identifier resolution of a syntax tree. */
export interface Resolution {
    readonly tree: Tree;
    /**
     * Declaration each identifier refers to: the node of the declaration for user-declared names,
     * or 0 for the predeclared and unresolved names.
     */
    readonly refs: Uint32Array;
    /** Module-scope declarations by name; the first one when redeclared. */
    readonly globals: ReadonlyMap<string, number>;
    /** Module-scope declarations ordered so that each follows the declarations it depends on. */
    readonly order: readonly number[];
    /** Module-scope declarations that are part of a dependency cycle. */
    readonly cyclic: ReadonlySet<number>;
    readonly diagnostics: readonly Diagnostic[];
}

/** Resolves the identifiers of the tree to their declarations. */
export function resolve(tree: Tree): Resolution {
    return new Resolver(tree).run();
}

/** Whether the node is a declaration introducing a name. */
export function isDeclaration(kind: Node): boolean {
    return (
        kind === Node.Struct ||
        kind === Node.Alias ||
        kind === Node.Function ||
        kind === Node.Param ||
        kind === Node.Var ||
        kind === Node.Let ||
        kind === Node.Const ||
        kind === Node.Override
    );
}

/**
 * Returns the variable or parameter declaration whose memory the memory view or pointer
 * expression refers to, following the pointer `let` declarations; 0 when there is none.
 */
export function memoryRoot(tree: Tree, refs: Uint32Array, node: number): number {
    for (;;)
        switch (tree.kinds[node]) {
            case Node.Ident: {
                const decl = refs[node]!;
                if (tree.kinds[decl] !== Node.Let) return decl;
                node = initializerOf(tree, decl);
                break;
            }
            case Node.Paren:
            case Node.Index:
            case Node.Member:
            case Node.Unary:
                node = tree.firsts[node]!;
                break;
            case Node.Call:
                node = tree.nexts[tree.firsts[node]!]!;
                break;
            default:
                return 0;
        }
}

class Resolver {
    private readonly refs: Uint32Array;
    private readonly globals = new Map<string, number>();
    private readonly scopes: Map<string, number>[] = [];
    private readonly diagnostics: Diagnostic[] = [];
    /** Module-scope declarations each module-scope declaration depends on. */
    private readonly edges = new Map<number, number[]>();
    private current: number[] = [];

    constructor(private readonly tree: Tree) {
        this.refs = new Uint32Array(tree.count);
    }

    run(): Resolution {
        const { tree } = this;
        const decls: number[] = [];
        for (let node = tree.firsts[0]!; node; node = tree.nexts[node]!) {
            if (!isDeclaration(tree.kinds[node]!)) continue;
            decls.push(node);
            const name = childOf(tree, node, Node.Name);
            if (!name) continue;
            const text = tokenText(tree, name);
            if (this.globals.has(text)) this.redeclared(name, text);
            else this.globals.set(text, node);
        }
        for (let node = tree.firsts[0]!; node; node = tree.nexts[node]!) {
            const kind = tree.kinds[node]!;
            if (kind === Node.Enable || kind === Node.Requires || kind === Node.Directive) continue;
            this.current = [];
            if (kind === Node.Function) this.function(node);
            else this.visit(node);
            this.edges.set(node, this.current);
        }
        const { order, cyclic } = this.sort(decls);
        return {
            tree,
            refs: this.refs,
            globals: this.globals,
            order,
            cyclic,
            diagnostics: this.diagnostics,
        };
    }

    private function(node: number): void {
        const { tree } = this;
        for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!) {
            const kind = tree.kinds[child]!;
            if (kind === Node.Param) this.visitChildren(child);
            else if (kind !== Node.Block) this.visit(child);
        }
        this.scopes.push(new Map());
        for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!) {
            const kind = tree.kinds[child]!;
            if (kind === Node.Param) this.declare(child);
            else if (kind === Node.Block) this.statements(child);
        }
        this.scopes.pop();
    }

    /** Visits the statements of the block in the current scope. */
    private statements(block: number): void {
        const { tree } = this;
        for (let child = tree.firsts[block]!; child; child = tree.nexts[child]!) this.visit(child);
    }

    private visit(node: number): void {
        const { tree } = this;
        switch (tree.kinds[node]) {
            case Node.Ident:
                this.reference(node);
                this.visitChildren(node);
                return;
            case Node.Attribute: {
                const name = tokenText(tree, node);
                if (name !== "builtin" && name !== "interpolate" && name !== "diagnostic")
                    this.visitChildren(node);
                return;
            }
            case Node.Var:
            case Node.Let:
            case Node.Const:
            case Node.Override:
                this.visitChildren(node);
                if (this.scopes.length > 0) this.declare(node);
                return;
            case Node.Block:
                this.scopes.push(new Map());
                this.statements(node);
                this.scopes.pop();
                return;
            case Node.For: {
                this.scopes.push(new Map());
                for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!)
                    if (tree.kinds[child] === Node.Block) this.statements(child);
                    else this.visit(child);
                this.scopes.pop();
                return;
            }
            case Node.Loop: {
                // The continuing block is nested in the loop body's scope.
                this.visitChildren(node);
                return;
            }
            default:
                this.visitChildren(node);
        }
    }

    private visitChildren(node: number): void {
        const { tree } = this;
        for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!) this.visit(child);
    }

    private declare(decl: number): void {
        const { tree } = this;
        const name = childOf(tree, decl, Node.Name);
        if (!name) return;
        const text = tokenText(tree, name);
        const scope = this.scopes[this.scopes.length - 1]!;
        if (scope.has(text)) this.redeclared(name, text);
        else scope.set(text, decl);
    }

    private reference(ident: number): void {
        const text = tokenText(this.tree, ident);
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            const decl = this.scopes[i]!.get(text);
            if (decl !== undefined) {
                this.refs[ident] = decl;
                return;
            }
        }
        const global = this.globals.get(text);
        if (global === undefined) return;
        this.refs[ident] = global;
        this.current.push(global);
    }

    private redeclared(name: number, text: string): void {
        const { tree } = this;
        this.diagnostics.push({
            start: tree.starts[name]!,
            end: tree.ends[name]!,
            severity: "error",
            message: `redeclaration of '${text}'`,
        });
    }

    /** Orders the declarations by their dependencies and reports the dependency cycles. */
    private sort(decls: readonly number[]): { order: number[]; cyclic: Set<number> } {
        const { tree } = this;
        const order: number[] = [];
        const cyclic = new Set<number>();
        const state = new Map<number, number>();
        const path: number[] = [];
        const stack: [number, number][] = [];
        for (const root of decls) {
            if (state.has(root)) continue;
            stack.push([root, 0]);
            state.set(root, 1);
            path.push(root);
            while (stack.length > 0) {
                const top = stack[stack.length - 1]!;
                const deps = this.edges.get(top[0]) ?? [];
                if (top[1] < deps.length) {
                    const dep = deps[top[1]++]!;
                    const s = state.get(dep);
                    if (s === undefined) {
                        state.set(dep, 1);
                        path.push(dep);
                        stack.push([dep, 0]);
                    } else if (s === 1 && !cyclic.has(dep)) {
                        const cycle = path.slice(path.indexOf(dep));
                        for (const node of cycle) cyclic.add(node);
                        const names = [...cycle, dep].map(
                            d => `'${tokenText(tree, childOf(tree, d, Node.Name))}'`,
                        );
                        const name = childOf(tree, dep, Node.Name);
                        this.diagnostics.push({
                            start: tree.starts[name]!,
                            end: tree.ends[name]!,
                            severity: "error",
                            message: `cyclic dependency found: ${names.join(" -> ")}`,
                        });
                    }
                    continue;
                }
                stack.pop();
                path.pop();
                state.set(top[0], 2);
                order.push(top[0]);
            }
        }
        return { order, cyclic };
    }
}
