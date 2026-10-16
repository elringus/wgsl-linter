import type { Semantics } from "../semantic/check.ts";
import { formatScalar, type Value } from "../semantic/eval.ts";
import { alignOf, sizeOf } from "../semantic/layout.ts";
import { Kind, type Type, typeName, vec } from "../semantic/types.ts";
import { childOf, nameOf, Node } from "../syntax/tree.ts";

/** Returns the WGSL code describing the user declaration, as shown on hover. */
export function describeDeclaration(sem: Semantics, decl: number): string {
    const { tree, types, values } = sem;
    const name = nameOf(tree, decl);
    const type = types[decl];
    const typed = (prefix: string): string =>
        `${prefix}${name}${type ? `: ${typeName(type)}` : ""}`;
    switch (tree.kinds[decl]) {
        case Node.Var: {
            if (!type || type.kind !== Kind.Reference) return `var ${name}`;
            const space = type.space === "function" ? "" : type.space;
            const access =
                type.space === "storage" && type.access !== "read" ? `, ${type.access}` : "";
            const template = space && type.space !== "handle" ? `<${space}${access}>` : "";
            return `var${template} ${name}: ${typeName(type.elem!)}`;
        }
        case Node.Let:
            return typed("let ");
        case Node.Override:
            return typed("override ");
        case Node.Const: {
            const value = values[decl];
            const text = typed("const ");
            return value === undefined || typeof value === "string"
                ? text
                : `${text} = ${valueText(value, type!)}`;
        }
        case Node.Param:
            return typed("");
        case Node.Alias:
            return `alias ${name} = ${type ? typeName(type) : "?"}`;
        case Node.Function:
            return functionSignature(sem, decl);
        case Node.Struct: {
            let members = "";
            for (let member = tree.firsts[decl]!; member; member = tree.nexts[member]!) {
                if (tree.kinds[member] !== Node.StructMember) continue;
                let attributes = "";
                for (
                    let attr = tree.firsts[member]!;
                    tree.kinds[attr] === Node.Attribute;
                    attr = tree.nexts[attr]!
                )
                    attributes += `${tree.text.slice(tree.starts[attr], tree.ends[attr])} `;
                const memberType = type?.members.find(m => m.node === member)?.type;
                const typed = memberType ? `: ${typeName(memberType)}` : "";
                members += `    ${attributes}${nameOf(tree, member)}${typed},\n`;
            }
            return `struct ${name} {\n${members}}`;
        }
        case Node.StructMember: {
            const struct = types[tree.parents[decl]!];
            const member = struct?.members.find(m => m.node === decl);
            return member ? `${struct!.name}.${name}: ${typeName(member.type)}` : name;
        }
        default:
            return name;
    }
}

/** Returns the signature of the user-declared function. */
export function functionSignature(sem: Semantics, decl: number): string {
    const { tree, types } = sem;
    const params: string[] = [];
    for (let node = tree.firsts[decl]!; node; node = tree.nexts[node]!)
        if (tree.kinds[node] === Node.Param) {
            const type = types[node];
            params.push(`${nameOf(tree, node)}: ${type ? typeName(type) : "?"}`);
        }
    const result = childOf(tree, decl, Node.Result) ? types[decl] : undefined;
    return `fn ${nameOf(tree, decl)}(${params.join(", ")})${result ? ` -> ${typeName(result)}` : ""}`;
}

/** Memory layout of a type, or of a struct member, in bytes. */
export interface Layout {
    readonly size: number;
    readonly align: number;
    /** Offset of the struct member within the struct. */
    readonly offset?: number;
}

/** Returns the memory layout of the type, when it has one. */
export function typeLayout(type: Type): Layout | undefined {
    switch (type.kind) {
        case Kind.I32:
        case Kind.U32:
        case Kind.F32:
        case Kind.F16:
        case Kind.Vector:
        case Kind.Matrix:
        case Kind.Atomic:
        case Kind.Struct:
            return { size: sizeOf(type), align: alignOf(type) };
        case Kind.Array:
            return type.count > 0 ? { size: sizeOf(type), align: alignOf(type) } : undefined;
        default:
            return undefined;
    }
}

/** Formats the constant value of the type as WGSL. */
export function valueText(value: Value, type: Type): string {
    if (!Array.isArray(value)) {
        const text = formatScalar(value);
        const float =
            type.kind === Kind.AbstractFloat || type.kind === Kind.F32 || type.kind === Kind.F16;
        return float && /^-?\d+$/.test(text) ? `${text}.0` : text;
    }
    const elem = (i: number): Type =>
        type.kind === Kind.Struct
            ? type.members[i]!.type
            : type.kind === Kind.Matrix
              ? vec(type.rows, type.elem!)
              : type.elem!;
    const items = (value as readonly Value[]).map((v, i) => valueText(v, elem(i)));
    const name = type.kind === Kind.Struct ? type.name : typeName(type);
    return `${name}(${items.join(", ")})`;
}
