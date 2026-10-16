import { Kind, type Member, type Type, vec } from "./types.ts";

/** Layout of a structure member. */
export interface MemberLayout {
    readonly offset: number;
    readonly align: number;
    readonly size: number;
}

const layouts = new WeakMap<Type, readonly MemberLayout[]>();

/** Records the layout of the structure's members, computed when the structure is declared. */
export function setLayout(struct: Type, members: readonly MemberLayout[]): void {
    layouts.set(struct, members);
}

/** Returns the layout of the structure's members. */
export function layoutOf(struct: Type): readonly MemberLayout[] {
    let layout = layouts.get(struct);
    if (!layout) layouts.set(struct, (layout = defaultLayout(struct.members)));
    return layout;
}

function defaultLayout(members: readonly Member[]): MemberLayout[] {
    const out: MemberLayout[] = [];
    let offset = 0;
    for (const member of members) {
        const align = alignOf(member.type);
        const size = sizeOf(member.type);
        offset = roundUp(align, offset);
        out.push({ offset, align, size });
        offset += size;
    }
    return out;
}

export function roundUp(k: number, n: number): number {
    return Math.ceil(n / k) * k;
}

/** Returns the alignment of the host-shareable or fixed-footprint type in bytes. */
export function alignOf(type: Type): number {
    switch (type.kind) {
        case Kind.F16:
            return 2;
        case Kind.Vector: {
            const scalar = type.elem!.kind === Kind.F16 ? 2 : 4;
            return (type.count === 2 ? 2 : 4) * scalar;
        }
        case Kind.Matrix:
            return alignOf(vec(type.rows, type.elem!));
        case Kind.Array:
            return alignOf(type.elem!);
        case Kind.Struct:
            return Math.max(1, ...layoutOf(type).map(m => m.align));
        case Kind.Atomic:
            return type.elem!.kind === Kind.Vector ? 8 : 4;
        default:
            return 4;
    }
}

/** Returns the size of the type in bytes; runtime-sized arrays count no elements. */
export function sizeOf(type: Type): number {
    switch (type.kind) {
        case Kind.F16:
            return 2;
        case Kind.Vector:
            return type.count * (type.elem!.kind === Kind.F16 ? 2 : 4);
        case Kind.Matrix: {
            const column = vec(type.rows, type.elem!);
            return type.count * roundUp(alignOf(column), sizeOf(column));
        }
        case Kind.Array:
            return Math.max(type.count, 0) * strideOf(type);
        case Kind.Struct: {
            const layout = layoutOf(type);
            const last = layout[layout.length - 1];
            return last ? roundUp(alignOf(type), last.offset + last.size) : 0;
        }
        case Kind.Atomic:
            return type.elem!.kind === Kind.Vector ? 8 : 4;
        case Kind.Buffer:
            return Math.max(type.count, 0);
        default:
            return 4;
    }
}

/** Returns the byte distance between the consecutive elements of the array. */
export function strideOf(array: Type): number {
    return roundUp(alignOf(array.elem!), sizeOf(array.elem!));
}
