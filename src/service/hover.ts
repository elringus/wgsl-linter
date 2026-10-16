import { Sem, type Semantics } from "../semantic/check.ts";
import { functionOverloads } from "../semantic/overloads.ts";
import { enumOf } from "../semantic/predeclared.ts";
import { Kind, loaded, typeName, voidType } from "../semantic/types.ts";
import { Node, type Tree } from "../syntax/tree.ts";
import { describeDeclaration, typeText } from "./describe.ts";
import type { Document } from "./document.ts";
import { targetAt, tokenRange } from "./navigation.ts";

/** Information on a name in the source. */
export interface Hover {
    readonly start: number;
    readonly end: number;
    /** WGSL text describing the name. */
    readonly code: string;
    /** The comments preceding the declaration, when any. */
    readonly documentation?: string;
}

/** Returns the information on the name at the offset. */
export function hover(doc: Document, offset: number): Hover | undefined {
    const target = targetAt(doc, offset);
    if (!target) return undefined;
    const { tree } = doc;
    const sem = doc.semantics;
    const [start, end] = tokenRange(tree, target.node);
    if (target.decl) {
        const documentation = comments(tree, target.decl);
        const code = describeDeclaration(sem, target.decl);
        return documentation ? { start, end, code, documentation } : { start, end, code };
    }
    const code = describeBuiltin(sem, target.node);
    return code ? { start, end, code } : undefined;
}

function describeBuiltin(sem: Semantics, node: number): string | undefined {
    const { tree, types } = sem;
    const name = tree.text.slice(...tokenRange(tree, node));
    if (tree.kinds[node] === Node.Member) {
        const type = types[node];
        return type && `${name}: ${typeName(loaded(type))}`;
    }
    switch (sem.sems[node]) {
        case Sem.Function: {
            const res = sem.overloads[tree.parents[node]!];
            if (!res)
                return functionOverloads(name)
                    ?.map(o => `fn ${o.signature}`)
                    .join("\n");
            const params = res.params.map((type, i) => {
                const param = res.overload.params[i]?.name;
                return `${param ? `${param}: ` : ""}${typeName(type)}`;
            });
            const result = res.result === voidType ? "" : ` -> ${typeName(res.result)}`;
            return `fn ${name}(${params.join(", ")})${result}`;
        }
        case Sem.Type: {
            const type = types[node];
            if (!type) return undefined;
            const text = typeText(type);
            return type.kind !== Kind.Struct && typeName(type) !== name
                ? `alias ${name} = ${text}`
                : text;
        }
        case Sem.Enum:
            return `${enumOf(name) ?? "enumerant"} ${name}`;
        default:
            return undefined;
    }
}

/** Returns the text of the line comments right before the declaration. */
function comments(tree: Tree, decl: number): string | undefined {
    const { comments: ranges } = tree.tokens;
    const text = tree.text;
    let at = tree.starts[decl]!;
    const lines: string[] = [];
    for (let i = ranges.length - 2; i >= 0; i -= 2) {
        const start = ranges[i]!;
        const end = ranges[i + 1]!;
        if (end > at) continue;
        if (!/^[ \t]*\r?\n[ \t]*$/.test(text.slice(end, at)) || !text.startsWith("//", start))
            break;
        lines.unshift(text.slice(start + 2, end).replace(/^ /, ""));
        at = start;
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
}
