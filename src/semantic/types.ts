/** Kinds of the WGSL types. */
export enum Kind {
    /** Type of an erroneous expression; compatible with everything to avoid cascading errors. */
    Error,
    /** Absence of a value: the result of a function without a return type. */
    Void,
    Bool,
    AbstractInt,
    AbstractFloat,
    I32,
    U32,
    F32,
    F16,
    Vector,
    Matrix,
    Atomic,
    Array,
    Struct,
    Pointer,
    Reference,
    /** Swizzle view of a vector in memory; the count is the vector width, the rows the swizzle size. */
    Swizzle,
    Sampler,
    Texture,
    Buffer,
}

export type AddressSpace =
    | "function"
    | "private"
    | "workgroup"
    | "uniform"
    | "storage"
    | "immediate"
    | "handle";
export type Access = "read" | "write" | "read_write";

/** Member of a structure type. */
export interface Member {
    readonly name: string;
    readonly type: Type;
    /** The declaring struct member node, or 0 for the builtin structures. */
    readonly node: number;
}

/** A WGSL type. Types are interned, so the same types are the same objects. */
export interface Type {
    readonly kind: Kind;
    readonly id: number;
    /** Name of the scalar, sampler, texture and structure types. */
    readonly name: string;
    /** Component type of vectors, matrices, atomics, arrays and sampled textures; store type of memory views. */
    readonly elem: Type | undefined;
    /** Vector width, matrix columns, array element count or buffer size; 0 when runtime-sized, -1 when overridden. */
    readonly count: number;
    /** Matrix rows. */
    readonly rows: number;
    /** Address space of memory views. */
    readonly space: AddressSpace | undefined;
    /** Access mode of memory views and storage textures. */
    readonly access: Access | undefined;
    /** Texel format of storage textures. */
    readonly format: string;
    /** Members of structures. */
    readonly members: readonly Member[];
    /** Declaring node of structures; element count expression or override of override-sized arrays and buffers. */
    readonly node: number;
    /** Derived types interned with this type as their component. */
    derived: Map<string | number, Type> | undefined;
}

let nextId = 0;

function create(
    kind: Kind,
    name: string,
    elem?: Type,
    count = 0,
    rows = 0,
    space?: AddressSpace,
    access?: Access,
    format = "",
    members: readonly Member[] = [],
    node = 0,
): Type {
    return {
        kind,
        id: nextId++,
        name,
        elem,
        count,
        rows,
        space,
        access,
        format,
        members,
        node,
        derived: undefined,
    };
}

function derive(base: Type, key: string | number, make: () => Type): Type {
    base.derived ??= new Map();
    let type = base.derived.get(key);
    if (!type) base.derived.set(key, (type = make()));
    return type;
}

export const errorType: Type = create(Kind.Error, "<error>");
export const voidType: Type = create(Kind.Void, "void");
export const boolType: Type = create(Kind.Bool, "bool");
export const abstractInt: Type = create(Kind.AbstractInt, "abstract-int");
export const abstractFloat: Type = create(Kind.AbstractFloat, "abstract-float");
export const i32: Type = create(Kind.I32, "i32");
export const u32: Type = create(Kind.U32, "u32");
export const f32: Type = create(Kind.F32, "f32");
export const f16: Type = create(Kind.F16, "f16");
export const samplerType: Type = create(Kind.Sampler, "sampler");
export const comparisonSamplerType: Type = create(Kind.Sampler, "sampler_comparison");
export const unsizedBuffer: Type = create(Kind.Buffer, "buffer");

/** Scalar types by name, including the abstract ones as named in the builtin table. */
export const scalars: ReadonlyMap<string, Type> = new Map([
    ["bool", boolType],
    ["i32", i32],
    ["u32", u32],
    ["f32", f32],
    ["f16", f16],
    ["ia", abstractInt],
    ["fa", abstractFloat],
]);

const textures = new Map<string, Type>();

/** Returns the texture type with no parameters, such as `texture_depth_2d` or `texture_external`. */
export function texture(name: string): Type {
    let type = textures.get(name);
    if (!type) textures.set(name, (type = create(Kind.Texture, name)));
    return type;
}

/** Returns the sampled or multisampled texture type with the sampled type. */
export function sampledTexture(name: string, sampled: Type): Type {
    return derive(sampled, name, () => create(Kind.Texture, name, sampled));
}

/** Returns the storage texture type. */
export function storageTexture(name: string, format: string, access: Access): Type {
    return derive(texture(name), `${format}:${access}`, () =>
        create(Kind.Texture, name, undefined, 0, 0, undefined, access, format),
    );
}

export function vec(width: number, elem: Type): Type {
    return derive(elem, width, () => create(Kind.Vector, "", elem, width));
}

export function mat(columns: number, rows: number, elem: Type): Type {
    return derive(elem, columns * 8 + rows, () => create(Kind.Matrix, "", elem, columns, rows));
}

export function atomic(elem: Type): Type {
    return derive(elem, "atomic", () => create(Kind.Atomic, "", elem));
}

/** Returns the array type with the constant element count, or the runtime-sized array when the count is 0. */
export function array(elem: Type, count = 0): Type {
    return derive(elem, -1 - count, () => create(Kind.Array, "", elem, count));
}

/** Returns the array type whose element count is the override-expression; interned by the given key. */
export function overrideArray(elem: Type, node: number, interned: Map<string, Type>): Type {
    const key = `${elem.id}:${node}`;
    let type = interned.get(key);
    if (!type)
        interned.set(
            key,
            (type = create(Kind.Array, "", elem, -1, 0, undefined, undefined, "", [], node)),
        );
    return type;
}

/** Returns the fixed-size buffer type, or the runtime-sized buffer when the size is 0. */
export function buffer(size: number): Type {
    if (size === 0) return unsizedBuffer;
    return derive(unsizedBuffer, size, () => create(Kind.Buffer, "buffer", undefined, size));
}

/** Returns the buffer type whose size is the override-expression; interned by the given key. */
export function overrideBuffer(node: number, interned: Map<string, Type>): Type {
    const key = `buffer:${node}`;
    let type = interned.get(key);
    if (!type)
        interned.set(
            key,
            (type = create(
                Kind.Buffer,
                "buffer",
                undefined,
                -1,
                0,
                undefined,
                undefined,
                "",
                [],
                node,
            )),
        );
    return type;
}

export function pointer(space: AddressSpace, store: Type, access: Access): Type {
    return derive(store, `ptr:${space}:${access}`, () =>
        create(Kind.Pointer, "", store, 0, 0, space, access),
    );
}

export function reference(space: AddressSpace, store: Type, access: Access): Type {
    return derive(store, `ref:${space}:${access}`, () =>
        create(Kind.Reference, "", store, 0, 0, space, access),
    );
}

export function swizzleView(
    space: AddressSpace,
    store: Type,
    access: Access,
    width: number,
    size: number,
): Type {
    return derive(store, `swizzle:${space}:${access}:${width}:${size}`, () =>
        create(Kind.Swizzle, "", store, width, size, space, access),
    );
}

/** Creates a new structure type; each declaration is a distinct type. */
export function struct(name: string, members: readonly Member[], node: number): Type {
    return create(Kind.Struct, name, undefined, 0, 0, undefined, undefined, "", members, node);
}

const builtinStructs = new Map<string, Type>();

function builtinStruct(name: string, members: [string, Type][]): Type {
    let type = builtinStructs.get(name);
    if (!type)
        builtinStructs.set(
            name,
            (type = struct(
                name,
                members.map(([name, type]) => ({ name, type, node: 0 })),
                0,
            )),
        );
    return type;
}

function suffixOf(type: Type): string {
    return type.kind === Kind.AbstractFloat ? "abstract" : type.name;
}

/** Returns the result type of `frexp` for the argument type. */
export function frexpResult(arg: Type): Type {
    const scalar = arg.kind === Kind.Vector ? arg.elem! : arg;
    const exp = scalar.kind === Kind.AbstractFloat ? abstractInt : i32;
    if (arg.kind !== Kind.Vector)
        return builtinStruct(`__frexp_result_${suffixOf(scalar)}`, [
            ["fract", scalar],
            ["exp", exp],
        ]);
    return builtinStruct(`__frexp_result_vec${arg.count}_${suffixOf(scalar)}`, [
        ["fract", arg],
        ["exp", vec(arg.count, exp)],
    ]);
}

/** Returns the result type of `modf` for the argument type. */
export function modfResult(arg: Type): Type {
    const scalar = arg.kind === Kind.Vector ? arg.elem! : arg;
    const name =
        arg.kind === Kind.Vector ? `vec${arg.count}_${suffixOf(scalar)}` : suffixOf(scalar);
    return builtinStruct(`__modf_result_${name}`, [
        ["fract", arg],
        ["whole", arg],
    ]);
}

/** Returns the result type of `atomicCompareExchangeWeak` for the atomic's type. */
export function atomicCompareExchangeResult(type: Type): Type {
    return builtinStruct(`__atomic_compare_exchange_result_${type.name}`, [
        ["old_value", type],
        ["exchanged", boolType],
    ]);
}

// ---- classification ----

export function isScalar(type: Type): boolean {
    return type.kind >= Kind.Bool && type.kind <= Kind.F16;
}

export function isNumericScalar(type: Type): boolean {
    return type.kind >= Kind.AbstractInt && type.kind <= Kind.F16;
}

export function isIntegerScalar(type: Type): boolean {
    return type.kind === Kind.AbstractInt || type.kind === Kind.I32 || type.kind === Kind.U32;
}

export function isFloatScalar(type: Type): boolean {
    return type.kind === Kind.AbstractFloat || type.kind === Kind.F32 || type.kind === Kind.F16;
}

/** Returns the scalar type of a scalar or vector, or of the matrix and array elements, recursively. */
export function scalarOf(type: Type): Type {
    while (
        type.elem &&
        (type.kind === Kind.Vector || type.kind === Kind.Matrix || type.kind === Kind.Array)
    )
        type = type.elem;
    return type;
}

/** Whether the type is abstract or composed of abstract types. */
export function isAbstract(type: Type): boolean {
    const scalar = scalarOf(type);
    return scalar.kind === Kind.AbstractInt || scalar.kind === Kind.AbstractFloat;
}

/** Returns the concretization of the type: abstract-int becomes i32 and abstract-float becomes f32. */
export function concretize(type: Type): Type {
    switch (type.kind) {
        case Kind.AbstractInt:
            return i32;
        case Kind.AbstractFloat:
            return f32;
        case Kind.Vector:
            return isAbstract(type) ? vec(type.count, concretize(type.elem!)) : type;
        case Kind.Matrix:
            return isAbstract(type) ? mat(type.count, type.rows, concretize(type.elem!)) : type;
        case Kind.Array:
            return isAbstract(type) ? array(concretize(type.elem!), type.count) : type;
        case Kind.Struct:
            if (type.node === 0 && type.name.endsWith("_abstract"))
                return concretizeBuiltinStruct(type);
            return type;
        default:
            return type;
    }
}

function concretizeBuiltinStruct(type: Type): Type {
    const fract = concretize(type.members[0]!.type);
    return type.name.startsWith("__frexp") ? frexpResult(fract) : modfResult(fract);
}

/** Whether the type is one of the concrete numeric scalars, or a vector or matrix of them. */
export function isConcreteNumeric(type: Type): boolean {
    const scalar = type.kind === Kind.Vector || type.kind === Kind.Matrix ? type.elem! : type;
    return scalar.kind >= Kind.I32 && scalar.kind <= Kind.F16;
}

export function isConstructible(type: Type): boolean {
    switch (type.kind) {
        case Kind.Bool:
        case Kind.AbstractInt:
        case Kind.AbstractFloat:
        case Kind.I32:
        case Kind.U32:
        case Kind.F32:
        case Kind.F16:
        case Kind.Vector:
        case Kind.Matrix:
            return true;
        case Kind.Array:
            return type.count > 0 && isConstructible(type.elem!);
        case Kind.Struct:
            return type.members.every(m => isConstructible(m.type));
        default:
            return false;
    }
}

/** Whether the type has a creation-fixed footprint. */
export function hasCreationFixedFootprint(type: Type): boolean {
    switch (type.kind) {
        case Kind.Array:
            return type.count > 0 && hasCreationFixedFootprint(type.elem!);
        case Kind.Struct:
            return type.members.every(m => hasCreationFixedFootprint(m.type));
        case Kind.Buffer:
            return type.count > 0;
        default:
            return isStorable(type);
    }
}

/** Whether the type has a fixed footprint: its size is known at pipeline creation. */
export function hasFixedFootprint(type: Type): boolean {
    switch (type.kind) {
        case Kind.Array:
            return type.count !== 0 && hasFixedFootprint(type.elem!);
        case Kind.Struct:
            return type.members.every(m => hasFixedFootprint(m.type));
        case Kind.Buffer:
            return type.count !== 0;
        default:
            return isStorable(type);
    }
}

/** Whether the type can be the store type of a variable. */
export function isStorable(type: Type): boolean {
    switch (type.kind) {
        case Kind.Bool:
        case Kind.I32:
        case Kind.U32:
        case Kind.F32:
        case Kind.F16:
        case Kind.Vector:
        case Kind.Matrix:
        case Kind.Atomic:
        case Kind.Sampler:
        case Kind.Texture:
        case Kind.Buffer:
            return !isAbstract(type);
        case Kind.Array:
            return isStorable(type.elem!);
        case Kind.Struct:
            return type.members.every(m => isStorable(m.type));
        default:
            return false;
    }
}

/** Whether the type can be shared with the host: stored in the uniform or storage buffers. */
export function isHostShareable(type: Type): boolean {
    switch (type.kind) {
        case Kind.I32:
        case Kind.U32:
        case Kind.F32:
        case Kind.F16:
        case Kind.Atomic:
        case Kind.Buffer:
            return true;
        case Kind.Vector:
        case Kind.Matrix:
            return isHostShareable(type.elem!);
        case Kind.Array:
            return isHostShareable(type.elem!);
        case Kind.Struct:
            return type.members.every(m => isHostShareable(m.type));
        default:
            return false;
    }
}

/** Whether the type is or contains an atomic type. */
export function containsAtomic(type: Type): boolean {
    switch (type.kind) {
        case Kind.Atomic:
            return true;
        case Kind.Array:
            return containsAtomic(type.elem!);
        case Kind.Struct:
            return type.members.some(m => containsAtomic(m.type));
        default:
            return false;
    }
}

/** Whether the type is a runtime-sized array or a structure ending with one. */
export function isRuntimeSized(type: Type): boolean {
    if (type.kind === Kind.Array || type.kind === Kind.Buffer) return type.count === 0;
    if (type.kind === Kind.Struct) {
        const last = type.members[type.members.length - 1];
        return !!last && isRuntimeSized(last.type);
    }
    return false;
}

/** Whether the type is a texture or sampler: a type of the handle address space. */
export function isHandle(type: Type): boolean {
    return type.kind === Kind.Texture || type.kind === Kind.Sampler;
}

/** Returns the type of a value loaded from the memory view, or the type itself. */
export function loaded(type: Type): Type {
    return type.kind === Kind.Reference || type.kind === Kind.Swizzle ? type.elem! : type;
}

// ---- conversions ----

/** No feasible automatic conversion. */
export const noConversion = 0x7fffffff;

/** Returns the rank of the automatic conversion between the types, or {@link noConversion}. */
export function conversionRank(from: Type, to: Type): number {
    if (from === to) return 0;
    if (from.kind === Kind.Reference || from.kind === Kind.Swizzle)
        return from.elem === to && from.access !== "write" ? 0 : noConversion;
    switch (from.kind) {
        case Kind.AbstractFloat:
            return to.kind === Kind.F32 ? 1 : to.kind === Kind.F16 ? 2 : noConversion;
        case Kind.AbstractInt:
            switch (to.kind) {
                case Kind.I32:
                    return 3;
                case Kind.U32:
                    return 4;
                case Kind.AbstractFloat:
                    return 5;
                case Kind.F32:
                    return 6;
                case Kind.F16:
                    return 7;
                default:
                    return noConversion;
            }
        case Kind.Vector:
            return to.kind === Kind.Vector && to.count === from.count
                ? conversionRank(from.elem!, to.elem!)
                : noConversion;
        case Kind.Matrix:
            return to.kind === Kind.Matrix && to.count === from.count && to.rows === from.rows
                ? conversionRank(from.elem!, to.elem!)
                : noConversion;
        case Kind.Array:
            return to.kind === Kind.Array && to.count === from.count && from.count > 0
                ? conversionRank(from.elem!, to.elem!)
                : noConversion;
        case Kind.Struct:
            if (from.node !== 0 || !from.name.endsWith("_abstract") || to.kind !== Kind.Struct)
                return noConversion;
            return to.name === from.name.replace(/abstract$/, "f32")
                ? 1
                : to.name === from.name.replace(/abstract$/, "f16")
                  ? 2
                  : noConversion;
        default:
            return noConversion;
    }
}

/** Returns the type both types can be automatically converted to, preferring the lower rank, or undefined. */
export function commonType(a: Type, b: Type): Type | undefined {
    if (a === b) return a;
    if (conversionRank(b, a) !== noConversion) return a;
    if (conversionRank(a, b) !== noConversion) return b;
    return undefined;
}

// ---- printing ----

/** Returns the WGSL spelling of the type. */
export function typeName(type: Type): string {
    switch (type.kind) {
        case Kind.Vector:
            return `vec${type.count}<${typeName(type.elem!)}>`;
        case Kind.Matrix:
            return `mat${type.count}x${type.rows}<${typeName(type.elem!)}>`;
        case Kind.Atomic:
            return `atomic<${typeName(type.elem!)}>`;
        case Kind.Array:
            if (type.count === 0) return `array<${typeName(type.elem!)}>`;
            return `array<${typeName(type.elem!)}, ${type.count < 0 ? "?" : type.count}>`;
        case Kind.Pointer:
        case Kind.Reference:
            return `${type.kind === Kind.Pointer ? "ptr" : "ref"}<${type.space}, ${typeName(type.elem!)}, ${type.access}>`;
        case Kind.Swizzle:
            return `swizzle<${type.space}, ${typeName(type.elem!)}, ${type.access}, ${type.count}, ${type.rows}>`;
        case Kind.Texture:
            if (type.format) return `${type.name}<${type.format}, ${type.access}>`;
            return type.elem ? `${type.name}<${typeName(type.elem)}>` : type.name;
        case Kind.Buffer:
            return type.count === 0 ? "buffer" : `buffer<${type.count < 0 ? "?" : type.count}>`;
        default:
            return type.name;
    }
}
