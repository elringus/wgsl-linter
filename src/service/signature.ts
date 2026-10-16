import { constructorOverloads, functionOverloads } from "../semantic/overloads.ts";
import { typeName } from "../semantic/types.ts";
import { Tok } from "../syntax/token.ts";
import { nameOf, Node } from "../syntax/tree.ts";
import type { Document } from "./document.ts";
import { nodeOfToken, tokenIndex } from "./query.ts";

/** A callable signature and the offsets of its parameters within the label. */
export interface Signature {
    readonly label: string;
    readonly parameters: readonly (readonly [number, number])[];
}

export interface SignatureHelp {
    readonly signatures: readonly Signature[];
    /** Index of the signature selected for the call. */
    readonly active: number;
    /** Index of the argument at the offset. */
    readonly parameter: number;
}

/** Returns the signatures of the function or constructor whose argument list contains the offset. */
export function signatureHelp(doc: Document, offset: number): SignatureHelp | undefined {
    const { tree } = doc;
    const { tokens } = tree;
    let index = tokenIndex(tokens, offset);
    while (index >= 0 && tokens.ends[index]! > offset) index--;
    let depth = 0;
    let parameter = 0;
    let paren = -1;
    for (let i = index; i >= 0 && paren < 0; i--) {
        const kind = tokens.kinds[i];
        if (kind === Tok.ParenRight || kind === Tok.BracketRight) depth++;
        else if (kind === Tok.ParenLeft || kind === Tok.BracketLeft) {
            if (depth > 0) depth--;
            else if (kind === Tok.ParenLeft) paren = i;
            else return undefined;
        } else if (kind === Tok.Comma && depth === 0) parameter++;
        else if (kind === Tok.Semicolon || kind === Tok.BraceLeft || kind === Tok.BraceRight)
            return undefined;
    }
    let callee = paren - 1;
    if (tokens.kinds[callee] === Tok.TemplateEnd) {
        let nesting = 0;
        for (; callee > 0; callee--) {
            const kind = tokens.kinds[callee];
            if (kind === Tok.TemplateEnd) nesting++;
            else if (kind === Tok.TemplateStart && --nesting === 0) break;
        }
        callee--;
    }
    if (callee < 0 || tokens.kinds[callee] !== Tok.Ident) return undefined;
    const name = tree.text.slice(tokens.starts[callee], tokens.ends[callee]);
    const node = nodeOfToken(tree, callee);
    const decl = node && tree.kinds[node] === Node.Ident ? doc.resolution.refs[node]! : 0;
    const sem = doc.semantics;
    if (decl) {
        const kind = tree.kinds[decl];
        if (kind !== Node.Function && kind !== Node.Struct) return undefined;
        const params: string[] = [];
        if (kind === Node.Function) {
            for (let child = tree.firsts[decl]!; child; child = tree.nexts[child]!)
                if (tree.kinds[child] === Node.Param) {
                    const type = sem.types[child];
                    params.push(`${nameOf(tree, child)}: ${type ? typeName(type) : "?"}`);
                }
        } else
            for (const member of sem.types[decl]?.members ?? [])
                params.push(`${member.name}: ${typeName(member.type)}`);
        const result = kind === Node.Function && sem.types[decl] ? sem.types[decl] : undefined;
        const suffix = result && result.name !== "void" ? ` -> ${typeName(result)}` : "";
        return { signatures: [signature(name, params, suffix)], active: 0, parameter };
    }
    const constructor = /^(vec[234]|mat[234]x[234])[iufh]$/.exec(name)?.[1] ?? name;
    const overloads = functionOverloads(name) ?? constructorOverloads(constructor);
    if (!overloads) return undefined;
    const call = tree.parents[node]!;
    const resolved = tree.kinds[call] === Node.Call ? sem.overloads[call]?.overload : undefined;
    const signatures = overloads.map(o => parseSignature(o.signature));
    return {
        signatures,
        active: Math.max(0, resolved ? overloads.indexOf(resolved) : 0),
        parameter,
    };
}

function signature(name: string, params: readonly string[], suffix: string): Signature {
    let label = `${name}(`;
    const parameters: [number, number][] = [];
    for (let i = 0; i < params.length; i++) {
        if (i > 0) label += ", ";
        parameters.push([label.length, label.length + params[i]!.length]);
        label += params[i];
    }
    return { label: `${label})${suffix}`, parameters };
}

/** Finds the parameters within the overload signature of the builtin table. */
function parseSignature(label: string): Signature {
    const parameters: [number, number][] = [];
    const open = label.indexOf("(");
    let depth = 0;
    let start = open + 1;
    for (let i = start; i < label.length; i++) {
        const c = label[i];
        if (c === "<" || c === "(") depth++;
        else if (c === ">" && label[i - 1] !== "-") depth--;
        else if ((c === "," || c === ")") && depth === 0) {
            if (i > start) parameters.push([start, i]);
            if (c === ")") break;
            start = i + 2;
        } else if (c === ")") depth--;
    }
    return { label, parameters };
}
