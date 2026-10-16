import { Sem, type Semantics } from "../semantic/check.ts";
import { builtinValues } from "../semantic/interface.ts";
import { layoutOf } from "../semantic/layout.ts";
import { functionOverloads } from "../semantic/overloads.ts";
import { enumOf, predeclaredTypes } from "../semantic/predeclared.ts";
import { Kind, loaded, type Type, typeName, voidType } from "../semantic/types.ts";
import { Node, tokenText, type Tree } from "../syntax/tree.ts";
import { describeDeclaration, type Layout, typeLayout } from "./describe.ts";
import type { Document } from "./document.ts";
import * as docs from "./docs.ts";
import { targetAt, tokenRange } from "./navigation.ts";
import { nodeOfToken, wordAt } from "./query.ts";

/** Information on a name in the source. */
export interface Hover {
    readonly start: number;
    readonly end: number;
    /** WGSL code declaring the name. */
    readonly code: string;
    /** Memory layout, for the types laid out in buffers. */
    readonly layout?: Layout;
    /** Markdown: the comments preceding the declaration or the specification's description. */
    readonly documentation?: string;
    /** URL of the specification section on the predeclared name. */
    readonly link?: string;
}

/** Returns the information on the name at the offset. */
export function hover(doc: Document, offset: number): Hover | undefined {
    const target = targetAt(doc, offset);
    if (!target) return attributeHover(doc.tree, offset);
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

/** Returns the types laid out in buffers, with their components. */
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

type Description = Omit<Hover, "start" | "end">;

function describeBuiltin(sem: Semantics, node: number): Description | undefined {
    const { tree, types } = sem;
    const name = tree.text.slice(...tokenRange(tree, node));
    if (tree.kinds[node] === Node.Member) {
        const type = types[node];
        return type && { code: `${name}: ${typeName(loaded(type))}` };
    }
    const parent = tree.parents[node]!;
    if (tree.kinds[parent] === Node.Attribute) {
        const value = tokenText(tree, parent) === "builtin" && builtinValues.get(name);
        return value ? documented(`builtin ${name}: ${value.type}`, docs.values[name]) : undefined;
    }
    switch (sem.sems[node]) {
        case Sem.Function: {
            const res = sem.overloads[parent];
            const overloads = docs.functions[name];
            if (!res) {
                const code = functionOverloads(name)?.map(o => `fn ${o.signature}`);
                return code && documented(code.join("\n"), overloads?.[0]);
            }
            const paramTypes = res.params.map(typeName);
            const params = paramTypes.map((type, i) => {
                const param = res.overload.params[i]?.name;
                return param ? `${param}: ${type}` : type;
            });
            const result = res.result === voidType ? "" : ` -> ${typeName(res.result)}`;
            const signature = paramTypes.join(", ");
            const doc = overloads?.findLast(([, , types]) => !types || types.test(signature));
            return documented(`fn ${name}(${params.join(", ")})${result}`, doc);
        }
        case Sem.Type: {
            const inferred = tree.kinds[parent] === Node.Call ? types[parent] : undefined;
            const type = types[node] ?? inferred;
            if (!type) return undefined;
            const text = typeName(type);
            const code =
                predeclaredTypes.has(name) && text !== name ? `alias ${name} = ${text}` : text;
            const description = documented(code, docs.types[typeFamily.exec(name)?.[0] ?? name]);
            return bufferTypes(sem).has(type)
                ? { ...description, layout: typeLayout(type) }
                : description;
        }
        case Sem.Enum: {
            const kind = enumOf(name);
            const doc = kind && docs.types[kind.replace(" ", "_")];
            return documented(`${kind ?? "enumerant"} ${name}`, doc);
        }
        default:
            return undefined;
    }
}

const typeFamily = /^(?:vec|mat|texture_(?:depth|storage|external|multisampled)|texture)/;

/** Returns the information on the attribute named at the offset. */
function attributeHover(tree: Tree, offset: number): Hover | undefined {
    const token = wordAt(tree.tokens, offset);
    const attr = token < 0 ? 0 : nodeOfToken(tree, token);
    const doc = tree.kinds[attr] === Node.Attribute && docs.attributes[tokenText(tree, attr)];
    if (!doc) return undefined;
    const [start, end] = tokenRange(tree, attr);
    const code = tree.text.slice(tree.starts[attr], tree.ends[attr]).replace(/\s+/g, " ");
    return { start, end, ...documented(code, doc) };
}

function documented(code: string, doc: docs.Doc | undefined): Description {
    return doc
        ? { code, documentation: doc[0], link: `${docs.specification}#${doc[1]}` }
        : { code };
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
