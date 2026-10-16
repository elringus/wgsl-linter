import type { Tokens } from "../syntax/lexer.ts";
import { Tok } from "../syntax/token.ts";
import { Node, type Tree } from "../syntax/tree.ts";

/** Returns the index of the token containing the offset, or of the last token before it. */
export function tokenIndex(tokens: Tokens, offset: number): number {
    let low = 0;
    let high = tokens.count - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (tokens.starts[mid]! <= offset) low = mid;
        else high = mid - 1;
    }
    return low;
}

/**
 * Returns the index of the identifier-like token at the offset: the token containing it or
 * ending at it, as when the cursor is right after a name; -1 when there's none.
 */
export function wordAt(tokens: Tokens, offset: number): number {
    const index = tokenIndex(tokens, offset);
    if (isWordToken(tokens, index) && offset <= tokens.ends[index]!) return index;
    if (index > 0 && tokens.ends[index - 1] === offset && isWordToken(tokens, index - 1))
        return index - 1;
    return -1;
}

function isWordToken(tokens: Tokens, index: number): boolean {
    const kind = tokens.kinds[index]!;
    return kind === Tok.Ident || kind === Tok.Diagnostic;
}

const owners = new WeakMap<Tree, Uint32Array>();

/** Returns the innermost node whose main token is the token, or 0. */
export function nodeOfToken(tree: Tree, token: number): number {
    let map = owners.get(tree);
    if (!map) {
        map = new Uint32Array(tree.tokens.count);
        for (let node = 1; node < tree.count; node++) map[tree.tokenOf[node]!] = node;
        owners.set(tree, map);
    }
    return map[token]!;
}

/** Returns the innermost node containing the offset, or the root. */
export function nodeAt(tree: Tree, offset: number): number {
    let node = 0;
    for (let child = tree.firsts[0]!; child;) {
        if (tree.starts[child]! <= offset && offset < tree.ends[child]!) {
            node = child;
            child = tree.firsts[child]!;
        } else child = tree.nexts[child]!;
    }
    return node;
}

/** Returns the closest ancestor of the node, or the node itself, of the kind; or 0. */
export function ancestor(tree: Tree, node: number, kind: Node): number {
    for (let n = node; n; n = tree.parents[n]!) if (tree.kinds[n] === kind) return n;
    return 0;
}

/** Calls the visitor for each node of the subtree in source order. */
export function walk(tree: Tree, node: number, visit: (node: number) => void): void {
    visit(node);
    for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!)
        walk(tree, child, visit);
}

/** Whether the node declares a name. */
export function isDeclaration(kind: Node): boolean {
    return (
        kind === Node.Struct ||
        kind === Node.StructMember ||
        kind === Node.Alias ||
        kind === Node.Function ||
        kind === Node.Param ||
        kind === Node.Var ||
        kind === Node.Let ||
        kind === Node.Const ||
        kind === Node.Override
    );
}
