import { Sem, type Semantics } from "../semantic/check.ts";
import { layoutOf } from "../semantic/layout.ts";
import { functionOverloads } from "../semantic/overloads.ts";
import { enumOf } from "../semantic/predeclared.ts";
import { Kind, loaded, type Type, typeName, voidType } from "../semantic/types.ts";
import { Node, type Tree } from "../syntax/tree.ts";
import { describeDeclaration, type Layout, typeLayout } from "./describe.ts";
import type { Document } from "./document.ts";
import { targetAt, tokenRange } from "./navigation.ts";

/** Information on a name in the source. */
export interface Hover {
    readonly start: number;
    readonly end: number;
    /** WGSL code declaring the name. */
    readonly code: string;
    /**
     * Memory layout of the type, struct member or buffer variable, for the types laid out in
     * the buffers: the uniform, storage and immediate variables and the buffer views.
     */
    readonly layout?: Layout;
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
    if (!target.decl) {
        const builtin = describeBuiltin(sem, target.node);
        return builtin && { start, end, ...builtin };
    }
    const code = describeDeclaration(sem, target.decl);
    const layout = declarationLayout(sem, target.decl);
    const documentation = comments(tree, target.decl);
    return {
        start,
        end,
        code,
        ...(layout && { layout }),
        ...(documentation && { documentation }),
    };
}

/** Returns the memory layout of the buffer variable, or of the struct or member in a buffer. */
function declarationLayout(sem: Semantics, decl: number): Layout | undefined {
    const { tree, types } = sem;
    const type = types[decl];
    switch (tree.kinds[decl]) {
        case Node.Var:
            return type && isBufferSpace(type) ? typeLayout(type.elem!) : undefined;
        case Node.Struct:
            return type && bufferTypes(sem).has(type) ? typeLayout(type) : undefined;
        case Node.StructMember: {
            const struct = types[tree.parents[decl]!];
            if (!struct || !bufferTypes(sem).has(struct)) return undefined;
            const index = struct.members.findIndex(m => m.node === decl);
            return index < 0 ? undefined : layoutOf(struct)[index];
        }
        default:
            return undefined;
    }
}

function isBufferSpace(view: Type): boolean {
    return view.space === "uniform" || view.space === "storage" || view.space === "immediate";
}

const buffers = new WeakMap<Semantics, Set<Type>>();

/**
 * Returns the types laid out in the buffers: the store types of the uniform, storage and
 * immediate variables and of the buffer views, and their components.
 */
function bufferTypes(sem: Semantics): Set<Type> {
    const cached = buffers.get(sem);
    if (cached) return cached;
    const { tree, types, overloads } = sem;
    const found = new Set<Type>();
    const add = (type: Type): void => {
        if (found.has(type)) return;
        found.add(type);
        if (type.kind === Kind.Struct) for (const member of type.members) add(member.type);
        else if (type.elem) add(type.elem);
    };
    for (let decl = tree.firsts[0]!; decl; decl = tree.nexts[decl]!) {
        const type = types[decl];
        if (tree.kinds[decl] === Node.Var && type && isBufferSpace(type)) add(type.elem!);
    }
    for (let node = 1; node < tree.count; node++) {
        const res = overloads[node];
        const name = res?.overload.name;
        if (name === "bufferView" || name === "bufferArrayView") add(res!.result.elem!);
    }
    buffers.set(sem, found);
    return found;
}

function describeBuiltin(sem: Semantics, node: number): Pick<Hover, "code" | "layout"> | undefined {
    const { tree, types } = sem;
    const name = tree.text.slice(...tokenRange(tree, node));
    if (tree.kinds[node] === Node.Member) {
        const type = types[node];
        return type && { code: `${name}: ${typeName(loaded(type))}` };
    }
    switch (sem.sems[node]) {
        case Sem.Function: {
            const res = sem.overloads[tree.parents[node]!];
            if (!res) {
                const overloads = functionOverloads(name);
                return overloads && { code: overloads.map(o => `fn ${o.signature}`).join("\n") };
            }
            const params = res.params.map((type, i) => {
                const param = res.overload.params[i]?.name;
                return `${param ? `${param}: ` : ""}${typeName(type)}`;
            });
            const result = res.result === voidType ? "" : ` -> ${typeName(res.result)}`;
            return { code: `fn ${name}(${params.join(", ")})${result}` };
        }
        case Sem.Type: {
            const type = types[node];
            if (!type) return undefined;
            const text = typeName(type);
            const code =
                type.kind !== Kind.Struct && text !== name ? `alias ${name} = ${text}` : text;
            const layout = bufferTypes(sem).has(type) ? typeLayout(type) : undefined;
            return layout ? { code, layout } : { code };
        }
        case Sem.Enum:
            return { code: `${enumOf(name) ?? "enumerant"} ${name}` };
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
