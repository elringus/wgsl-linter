import type { Semantics } from "../semantic/check.ts";
import { Kind, loaded } from "../semantic/types.ts";
import { keywords, reserved } from "../syntax/token.ts";
import { childOf, Node, type Tree } from "../syntax/tree.ts";
import type { Document } from "./document.ts";
import { isDeclaration, nodeOfToken, wordAt } from "./query.ts";

/** A range of the analyzed source. */
export interface Range {
    readonly start: number;
    readonly end: number;
}

/** A name in the source and the user declaration it names, or 0 for the predeclared ones. */
export interface Target {
    /** The name node: a declaration's name, an identifier or a member accessor. */
    readonly node: number;
    readonly decl: number;
}

/** Returns the name at the offset and the declaration it names. */
export function targetAt(doc: Document, offset: number): Target | undefined {
    const { tree } = doc;
    const token = wordAt(tree.tokens, offset);
    if (token < 0) return undefined;
    const node = nodeOfToken(tree, token);
    switch (tree.kinds[node]) {
        case Node.Name: {
            const decl = tree.parents[node]!;
            return isDeclaration(tree.kinds[decl]!) ? { node, decl } : undefined;
        }
        case Node.Ident:
            return { node, decl: doc.resolution.refs[node]! };
        case Node.Member:
            return { node, decl: memberDeclaration(doc.semantics, node) };
        default:
            return undefined;
    }
}

/** Returns the struct member declaration the member accessor refers to, or 0. */
export function memberDeclaration(sem: Semantics, member: number): number {
    const { tree } = sem;
    const type = sem.types[tree.firsts[member]!];
    if (!type) return 0;
    const store = type.kind === Kind.Pointer ? type.elem! : loaded(type);
    if (store.kind !== Kind.Struct) return 0;
    const name = tree.text.slice(...tokenRange(tree, member));
    return store.members.find(m => m.name === name)?.node ?? 0;
}

/** Returns the start and end of the node's main token. */
export function tokenRange(tree: Tree, node: number): [number, number] {
    const token = tree.tokenOf[node]!;
    return [tree.tokens.starts[token]!, tree.tokens.ends[token]!];
}

/** Returns the range of the declaration's name. */
export function nameRange(tree: Tree, decl: number): Range {
    const [start, end] = tokenRange(tree, childOf(tree, decl, Node.Name) || decl);
    return { start, end };
}

/** Returns the declaration of the name at the offset. */
export function definition(doc: Document, offset: number): Range | undefined {
    const target = targetAt(doc, offset);
    return target?.decl ? nameRange(doc.tree, target.decl) : undefined;
}

/** Returns the occurrences of the declaration named at the offset, in source order. */
export function references(
    doc: Document,
    offset: number,
    includeDeclaration = true,
): Range[] | undefined {
    const target = targetAt(doc, offset);
    return target?.decl ? occurrences(doc, target.decl, includeDeclaration) : undefined;
}

/** Returns the occurrences of the declaration's name, in source order. */
export function occurrences(doc: Document, decl: number, includeDeclaration: boolean): Range[] {
    const { tree } = doc;
    const ranges: Range[] = [];
    if (includeDeclaration) ranges.push(nameRange(tree, decl));
    const push = (node: number): void => {
        const [start, end] = tokenRange(tree, node);
        ranges.push({ start, end });
    };
    if (tree.kinds[decl] === Node.StructMember) {
        const sem = doc.semantics;
        for (let node = 1; node < tree.count; node++)
            if (tree.kinds[node] === Node.Member && memberDeclaration(sem, node) === decl)
                push(node);
    } else {
        const { refs } = doc.resolution;
        for (let node = 1; node < tree.count; node++)
            if (refs[node] === decl && tree.kinds[node] === Node.Ident) push(node);
    }
    return ranges.sort((a, b) => a.start - b.start);
}

/** Returns the range of the name at the offset when it names a declaration of the text. */
export function prepareRename(doc: Document, offset: number): Range | undefined {
    const target = targetAt(doc, offset);
    if (!target?.decl || doc.tree.starts[target.decl]! < doc.base) return undefined;
    const [start, end] = tokenRange(doc.tree, target.node);
    return { start, end };
}

/** Returns the ranges to replace with the new name to rename the declaration named at the offset. */
export function rename(doc: Document, offset: number): Range[] | undefined {
    const target = targetAt(doc, offset);
    if (!target?.decl || doc.tree.starts[target.decl]! < doc.base) return undefined;
    return occurrences(doc, target.decl, true);
}

/** Whether the text is a valid name of a user declaration. */
export function isValidName(name: string): boolean {
    return (
        /^(?:[_\p{XID_Start}]\p{XID_Continue}+|\p{XID_Start})$/u.test(name) &&
        !name.startsWith("__") &&
        !keywords.has(name) &&
        !reserved.has(name)
    );
}
