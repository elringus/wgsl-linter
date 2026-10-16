import { loaded, typeName } from "../semantic/types.ts";
import { Tok } from "../syntax/token.ts";
import { nameOf, Node, type Tree } from "../syntax/tree.ts";
import { functionSignature } from "./describe.ts";
import type { Document } from "./document.ts";
import { nameRange, type Range } from "./navigation.ts";

export enum SymbolKind {
    Function,
    Struct,
    Field,
    Variable,
    Constant,
    TypeAlias,
}

/** A declaration in the outline of the document. */
export interface DocumentSymbol {
    readonly name: string;
    readonly kind: SymbolKind;
    readonly detail: string;
    /** Range of the whole declaration. */
    readonly range: Range;
    /** Range of the declaration's name. */
    readonly selection: Range;
    readonly children: readonly DocumentSymbol[];
}

/** Returns the module-scope declarations of the text and the members of its structures. */
export function documentSymbols(doc: Document): DocumentSymbol[] {
    const { tree, base } = doc;
    const symbols: DocumentSymbol[] = [];
    for (let node = tree.firsts[0]!; node; node = tree.nexts[node]!)
        if (tree.starts[node]! >= base) {
            const symbol = declarationSymbol(doc, node);
            if (symbol) symbols.push(symbol);
        }
    return symbols;
}

function declarationSymbol(doc: Document, decl: number): DocumentSymbol | undefined {
    const { tree } = doc;
    const name = nameOf(tree, decl);
    if (!name) return undefined;
    const symbol = (
        kind: SymbolKind,
        detail = "",
        children: DocumentSymbol[] = [],
    ): DocumentSymbol => ({
        name,
        kind,
        detail,
        range: { start: tree.starts[decl]!, end: tree.ends[decl]! },
        selection: nameRange(tree, decl),
        children,
    });
    const type = (): string => {
        const declared = doc.semantics.types[decl];
        return declared ? typeName(loaded(declared)) : "";
    };
    switch (tree.kinds[decl]) {
        case Node.Function:
            return symbol(SymbolKind.Function, functionSignature(doc.semantics, decl));
        case Node.Struct: {
            const members: DocumentSymbol[] = [];
            for (let member = tree.firsts[decl]!; member; member = tree.nexts[member]!)
                if (tree.kinds[member] === Node.StructMember) {
                    const symbol = declarationSymbol(doc, member);
                    if (symbol) members.push(symbol);
                }
            return symbol(SymbolKind.Struct, "", members);
        }
        case Node.StructMember:
            return symbol(SymbolKind.Field, type());
        case Node.Var:
            return symbol(SymbolKind.Variable, type());
        case Node.Const:
        case Node.Override:
            return symbol(SymbolKind.Constant, type());
        case Node.Alias:
            return symbol(SymbolKind.TypeAlias, type());
        default:
            return undefined;
    }
}

/** A foldable region of the source. */
export interface FoldingRange extends Range {
    readonly comment: boolean;
}

/**
 * Returns the foldable regions: from the opening to the closing brace of the blocks and
 * structures, and the comments spanning multiple lines.
 */
export function foldingRanges(doc: Document): FoldingRange[] {
    const { tree, base } = doc;
    const { tokens } = tree;
    const ranges: FoldingRange[] = [];
    const stack: number[] = [];
    for (let i = 0; i < tokens.count; i++) {
        const kind = tokens.kinds[i];
        if (kind === Tok.BraceLeft) stack.push(i);
        else if (kind === Tok.BraceRight && stack.length > 0) {
            const open = stack.pop()!;
            const start = tokens.starts[open]!;
            const end = tokens.starts[i]!;
            if (start >= base && hasLineBreak(tree, start, end))
                ranges.push({ start, end, comment: false });
        }
    }
    const comments = tokens.comments;
    for (let i = 0; i < comments.length; i += 2) {
        const start = comments[i]!;
        let end = comments[i + 1]!;
        if (start < base) continue;
        if (tree.text.startsWith("//", start))
            while (i + 2 < comments.length && isNextLineComment(tree, end, comments[i + 2]!)) {
                i += 2;
                end = comments[i + 1]!;
            }
        if (hasLineBreak(tree, start, end)) ranges.push({ start, end, comment: true });
    }
    return ranges.sort((a, b) => a.start - b.start);
}

function hasLineBreak(tree: Tree, start: number, end: number): boolean {
    const text = tree.text;
    for (let i = start; i < end; i++) if (text.charCodeAt(i) === 10) return true;
    return false;
}

function isNextLineComment(tree: Tree, end: number, next: number): boolean {
    return (
        tree.text.startsWith("//", next) && /^[ \t]*\r?\n[ \t]*$/.test(tree.text.slice(end, next))
    );
}
