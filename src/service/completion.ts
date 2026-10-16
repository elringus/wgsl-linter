import {
    builtinValues,
    interpolationSamplings,
    interpolationTypes,
} from "../semantic/interface.ts";
import { builtinFunctionNames, functionOverloads } from "../semantic/overloads.ts";
import {
    accessModes,
    addressSpaces,
    predeclaredTypes,
    texelFormats,
    typeGenerators,
} from "../semantic/predeclared.ts";
import { Kind, loaded, type Type, typeName } from "../semantic/types.ts";
import type { Tokens } from "../syntax/lexer.ts";
import { Tok } from "../syntax/token.ts";
import { nameOf, Node, type Tree } from "../syntax/tree.ts";
import { functionSignature } from "./describe.ts";
import type { Document } from "./document.ts";
import { ancestor, nodeAt, tokenIndex, wordAt } from "./query.ts";

export enum CompletionKind {
    Keyword,
    Function,
    Variable,
    Constant,
    Parameter,
    Field,
    Struct,
    Type,
    EnumMember,
    Property,
}

export interface CompletionItem {
    readonly label: string;
    readonly kind: CompletionKind;
    readonly detail?: string;
}

/** The completion items and the range of the source they replace. */
export interface Completions {
    readonly start: number;
    readonly end: number;
    readonly items: readonly CompletionItem[];
}

const attributeNames = [
    "align",
    "binding",
    "blend_src",
    "builtin",
    "compute",
    "diagnostic",
    "fragment",
    "group",
    "id",
    "interpolate",
    "invariant",
    "location",
    "must_use",
    "size",
    "subgroup_size",
    "vertex",
    "workgroup_size",
];

const moduleKeywords = [
    "alias",
    "const",
    "const_assert",
    "diagnostic",
    "enable",
    "fn",
    "override",
    "requires",
    "struct",
    "var",
];

const statementKeywords = [
    "break",
    "case",
    "const",
    "const_assert",
    "continue",
    "continuing",
    "default",
    "discard",
    "else",
    "false",
    "for",
    "if",
    "let",
    "loop",
    "return",
    "switch",
    "true",
    "var",
    "while",
];

/** Returns the completions at the offset. */
export function completion(doc: Document, offset: number): Completions | undefined {
    const { tree } = doc;
    const { tokens } = tree;
    if (inComment(tree, offset)) return undefined;
    const word = wordAt(tokens, offset);
    const start = word >= 0 ? tokens.starts[word]! : offset;
    const end = word >= 0 ? Math.max(offset, tokens.ends[word]!) : offset;
    const before = word >= 0 ? word - 1 : tokenBefore(tokens, offset);
    const result = (items: CompletionItem[]): Completions => ({ start, end, items });
    const previous = before >= 0 ? tokens.kinds[before] : Tok.EOF;
    if (previous === Tok.Period) return result(members(doc, before));
    if (previous === Tok.At) return result(names(attributeNames, CompletionKind.Function));
    const template = templateArgument(tree, before);
    if (template) return result(templateItems(doc, offset, template[0], template[1]));
    const attribute = attributeArgument(tree, before);
    if (attribute === "builtin")
        return result(names([...builtinValues.keys()], CompletionKind.EnumMember));
    if (attribute === "interpolate")
        return result(
            names([...interpolationTypes, ...interpolationSamplings], CompletionKind.EnumMember),
        );
    if (previous === Tok.Colon || previous === Tok.Arrow) return result(typeItems(doc));
    return result(scopeItems(doc, offset));
}

function inComment(tree: Tree, offset: number): boolean {
    const { comments } = tree.tokens;
    for (let i = 0; i < comments.length; i += 2) {
        const start = comments[i]!;
        const end = comments[i + 1]!;
        const line = tree.text.startsWith("//", start);
        if (start < offset && (line ? offset <= end : offset < end)) return true;
    }
    return false;
}

/** Returns the index of the last token ending at or before the offset, or -1. */
function tokenBefore(tokens: Tokens, offset: number): number {
    let index = tokenIndex(tokens, offset);
    while (index >= 0 && (tokens.ends[index]! > offset || tokens.kinds[index] === Tok.EOF)) index--;
    return index;
}

function names(labels: readonly string[], kind: CompletionKind, detail?: string): CompletionItem[] {
    return labels.map(label => (detail ? { label, kind, detail } : { label, kind }));
}

/** Returns the members of the structure or the components of the vector before the period. */
function members(doc: Document, period: number): CompletionItem[] {
    const { tree } = doc;
    const at = tree.tokens.starts[period]!;
    let node = nodeAt(tree, at - 1);
    while (tree.parents[node] && tree.ends[tree.parents[node]!] === at) node = tree.parents[node]!;
    if (tree.ends[node] !== at) return [];
    const type = doc.semantics.types[node];
    if (!type) return [];
    const store = type.kind === Kind.Pointer ? type.elem! : loaded(type);
    if (store.kind === Kind.Struct)
        return store.members.map(m => ({
            label: m.name,
            kind: CompletionKind.Field,
            detail: typeName(m.type),
        }));
    if (store.kind !== Kind.Vector) return [];
    const items: CompletionItem[] = [];
    for (const set of ["xyzw", "rgba"]) {
        for (let i = 0; i < store.count; i++)
            items.push({
                label: set[i]!,
                kind: CompletionKind.Property,
                detail: typeName(store.elem!),
            });
        for (let n = 2; n <= store.count; n++)
            items.push({
                label: set.slice(0, n),
                kind: CompletionKind.Property,
                detail: `vec${n}<${typeName(store.elem!)}>`,
            });
    }
    return items;
}

/**
 * Returns the name of the type generator or `var` whose template list contains the token
 * after the index, and the index of the template argument; or undefined.
 */
function templateArgument(tree: Tree, index: number): [string, number] | undefined {
    const { tokens } = tree;
    let depth = 0;
    let argument = 0;
    for (let i = index; i > 0; i--) {
        const kind = tokens.kinds[i];
        if (kind === Tok.ParenRight || kind === Tok.BracketRight || kind === Tok.TemplateEnd)
            depth++;
        else if (kind === Tok.ParenLeft || kind === Tok.BracketLeft) {
            if (depth-- === 0) return undefined;
        } else if (kind === Tok.TemplateStart || kind === Tok.Less) {
            if (depth > 0) {
                if (kind === Tok.TemplateStart) depth--;
                continue;
            }
            const previous = tokens.kinds[i - 1];
            if (previous === Tok.Var) return ["var", argument];
            if (previous !== Tok.Ident) return undefined;
            return [tree.text.slice(tokens.starts[i - 1], tokens.ends[i - 1]), argument];
        } else if (kind === Tok.Comma && depth === 0) argument++;
        else if (kind === Tok.Semicolon || kind === Tok.BraceLeft || kind === Tok.BraceRight)
            return undefined;
    }
    return undefined;
}

function templateItems(
    doc: Document,
    offset: number,
    name: string,
    argument: number,
): CompletionItem[] {
    const spaces = names(addressSpaces, CompletionKind.EnumMember);
    const access = names(accessModes, CompletionKind.EnumMember);
    if (name === "var") return argument === 0 ? spaces : access;
    if (name === "ptr") return argument === 0 ? spaces : argument === 1 ? typeItems(doc) : access;
    if (name.startsWith("texture_storage"))
        return argument === 0 ? names(texelFormats, CompletionKind.EnumMember) : access;
    if (typeGenerators.has(name) || functionOverloads(name)) return typeItems(doc);
    return scopeItems(doc, offset);
}

/** Returns the attribute whose arguments contain the token after the index, or undefined. */
function attributeArgument(tree: Tree, index: number): string | undefined {
    const { tokens } = tree;
    let i = index;
    while (i > 0 && (tokens.kinds[i] === Tok.Comma || tokens.kinds[i] === Tok.Ident)) i--;
    if (tokens.kinds[i] !== Tok.ParenLeft || tokens.kinds[i - 2] !== Tok.At) return undefined;
    return tree.text.slice(tokens.starts[i - 1], tokens.ends[i - 1]);
}

/** Returns the types: the predeclared ones and the user structures and aliases. */
function typeItems(doc: Document): CompletionItem[] {
    const items = names([...predeclaredTypes.keys(), ...typeGenerators], CompletionKind.Type);
    const { tree } = doc;
    for (const [name, decl] of doc.resolution.globals) {
        const kind = tree.kinds[decl];
        if (kind === Node.Struct) items.push({ label: name, kind: CompletionKind.Struct });
        else if (kind === Node.Alias) items.push({ label: name, kind: CompletionKind.Type });
    }
    return items;
}

/** Returns the names in scope at the offset, the builtins and the keywords. */
function scopeItems(doc: Document, offset: number): CompletionItem[] {
    const { tree } = doc;
    const items: CompletionItem[] = [];
    const seen = new Set<string>();
    const add = (decl: number): void => {
        const name = nameOf(tree, decl);
        if (!name || seen.has(name)) return;
        seen.add(name);
        items.push(declarationItem(doc, decl, name));
    };
    const fn = ancestor(tree, nodeAt(tree, offset), Node.Function);
    if (fn) {
        for (let scope = nodeAt(tree, offset); scope && scope !== fn; scope = tree.parents[scope]!)
            for (let child = tree.firsts[scope]!; child; child = tree.nexts[child]!) {
                const kind = tree.kinds[child];
                if (
                    (kind === Node.Var || kind === Node.Let || kind === Node.Const) &&
                    tree.ends[child]! <= offset
                )
                    add(child);
            }
        for (let child = tree.firsts[fn]!; child; child = tree.nexts[child]!)
            if (tree.kinds[child] === Node.Param) add(child);
    }
    for (const decl of doc.resolution.globals.values()) add(decl);
    for (const name of builtinFunctionNames())
        if (!seen.has(name))
            items.push({
                label: name,
                kind: CompletionKind.Function,
                detail: functionOverloads(name)![0]!.signature,
            });
    items.push(...typeItems(doc).filter(item => !seen.has(item.label)));
    items.push(...names(fn ? statementKeywords : moduleKeywords, CompletionKind.Keyword));
    return items;
}

function declarationItem(doc: Document, decl: number, label: string): CompletionItem {
    const { tree } = doc;
    const type: Type | undefined = doc.semantics.types[decl];
    const detail = type ? typeName(loaded(type)) : undefined;
    const item = (kind: CompletionKind, text = detail): CompletionItem =>
        text ? { label, kind, detail: text } : { label, kind };
    switch (tree.kinds[decl]) {
        case Node.Function:
            return item(CompletionKind.Function, functionSignature(doc.semantics, decl));
        case Node.Struct:
            return item(CompletionKind.Struct, "struct");
        case Node.Alias:
            return item(CompletionKind.Type);
        case Node.Param:
            return item(CompletionKind.Parameter);
        case Node.Const:
        case Node.Override:
            return item(CompletionKind.Constant);
        default:
            return item(CompletionKind.Variable);
    }
}
