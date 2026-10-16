import { Sem } from "../semantic/check.ts";
import { Node, tokenText } from "../syntax/tree.ts";
import type { Document } from "./document.ts";
import { memberDeclaration } from "./navigation.ts";

/** Names of the semantic token types, indexed by {@link TokenType}. */
export const tokenTypes: readonly string[] = [
    "type",
    "struct",
    "function",
    "variable",
    "parameter",
    "property",
    "enumMember",
    "decorator",
];

/** Names of the semantic token modifiers, indexed by the bits of {@link TokenModifier}. */
export const tokenModifiers: readonly string[] = ["declaration", "readonly", "defaultLibrary"];

export enum TokenType {
    Type,
    Struct,
    Function,
    Variable,
    Parameter,
    Property,
    EnumMember,
    Decorator,
}

export enum TokenModifier {
    None = 0,
    Declaration = 1,
    Readonly = 2,
    DefaultLibrary = 4,
}

const enumAttributes = new Set(["builtin", "interpolate"]);

/**
 * Returns the semantic tokens of the text as flat quadruples of the offset, length,
 * {@link TokenType} and {@link TokenModifier} bits, sorted by offset.
 */
export function semanticTokens(doc: Document): number[] {
    const { tree, base } = doc;
    const sem = doc.semantics;
    const { refs } = doc.resolution;
    const { starts, ends } = tree.tokens;
    const data: number[] = [];
    let sorted = true;
    for (let node = 1; node < tree.count; node++) {
        const token = tree.tokenOf[node]!;
        const start = starts[token]!;
        if (start < base) continue;
        let type: TokenType | undefined;
        let modifiers = TokenModifier.None;
        switch (tree.kinds[node]) {
            case Node.Name: {
                const decl = tree.parents[node]!;
                [type, modifiers] = declarationToken(tree.kinds[decl]!);
                modifiers |= TokenModifier.Declaration;
                break;
            }
            case Node.Ident: {
                const decl = refs[node]!;
                if (decl) [type, modifiers] = declarationToken(tree.kinds[decl]!);
                else {
                    modifiers = TokenModifier.DefaultLibrary;
                    const parent = tree.parents[node]!;
                    if (sem.sems[node] === Sem.Function) type = TokenType.Function;
                    else if (sem.sems[node] === Sem.Type) type = TokenType.Type;
                    else if (sem.sems[node] === Sem.Enum) type = TokenType.EnumMember;
                    else if (
                        tree.kinds[parent] === Node.Attribute &&
                        enumAttributes.has(tokenText(tree, parent))
                    )
                        type = TokenType.EnumMember;
                }
                break;
            }
            case Node.Member:
                type = TokenType.Property;
                if (!memberDeclaration(sem, node)) modifiers = TokenModifier.DefaultLibrary;
                break;
            case Node.Attribute:
                type = TokenType.Decorator;
                break;
        }
        if (type === undefined) continue;
        if (data.length > 0 && start < data[data.length - 4]!) sorted = false;
        data.push(start, ends[token]! - start, type, modifiers);
    }
    return sorted ? data : sortQuadruples(data);
}

function declarationToken(kind: Node): [TokenType | undefined, TokenModifier] {
    switch (kind) {
        case Node.Struct:
            return [TokenType.Struct, TokenModifier.None];
        case Node.Alias:
            return [TokenType.Type, TokenModifier.None];
        case Node.Function:
            return [TokenType.Function, TokenModifier.None];
        case Node.Param:
            return [TokenType.Parameter, TokenModifier.None];
        case Node.StructMember:
            return [TokenType.Property, TokenModifier.None];
        case Node.Var:
            return [TokenType.Variable, TokenModifier.None];
        case Node.Let:
        case Node.Const:
        case Node.Override:
            return [TokenType.Variable, TokenModifier.Readonly];
        default:
            return [undefined, TokenModifier.None];
    }
}

function sortQuadruples(data: readonly number[]): number[] {
    const order = Array.from({ length: data.length / 4 }, (_, i) => i * 4);
    order.sort((a, b) => data[a]! - data[b]!);
    return order.flatMap(i => [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]);
}
