import type { Semantics } from "../semantic/check.ts";
import { formatScalar, type Value } from "../semantic/eval.ts";
import { alignOf, layoutOf, sizeOf } from "../semantic/layout.ts";
import { Kind, type Type, typeName, vec } from "../semantic/types.ts";
import { childOf, nameOf, Node } from "../syntax/tree.ts";

/** Returns the WGSL text describing the user declaration, as shown on hover. */
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
        case Node.Struct:
            return type ? structText(type) : `struct ${name}`;
        case Node.StructMember: {
            const struct = types[tree.parents[decl]!];
            const member = struct?.members.findIndex(m => m.node === decl) ?? -1;
            if (!struct || member < 0) return typed("");
            const { offset, size, align } = layoutOf(struct)[member]!;
            const memberType = typeName(struct.members[member]!.type);
            return `${struct.name}.${name}: ${memberType} // offset ${offset}, size ${size}, align ${align}`;
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

/** Returns the declaration of the structure with the layout of its members as comments. */
export function structText(struct: Type): string {
    const layout = layoutOf(struct);
    const members = struct.members.map((member, i) => {
        const { offset, size, align } = layout[i]!;
        return `    ${member.name}: ${typeName(member.type)}, // offset ${offset}, size ${size}, align ${align}`;
    });
    return `// size ${sizeOf(struct)}, align ${alignOf(struct)}\nstruct ${struct.name} {\n${members.join("\n")}\n}`;
}

/** Returns the type with its memory layout, when it has one. */
export function typeText(type: Type): string {
    if (type.kind === Kind.Struct) return structText(type);
    const name = typeName(type);
    if (!hasLayout(type)) return name;
    return `${name} // size ${sizeOf(type)}, align ${alignOf(type)}`;
}

function hasLayout(type: Type): boolean {
    switch (type.kind) {
        case Kind.I32:
        case Kind.U32:
        case Kind.F32:
        case Kind.F16:
        case Kind.Vector:
        case Kind.Matrix:
        case Kind.Atomic:
        case Kind.Array:
            return type.kind !== Kind.Array || type.count > 0;
        default:
            return false;
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
