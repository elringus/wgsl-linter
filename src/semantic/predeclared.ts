import { enums } from "./builtins.ts";
import { isBuiltinFunction } from "./overloads.ts";
import {
    abstractFloat,
    abstractInt,
    boolType,
    comparisonSamplerType,
    f16,
    f32,
    i32,
    mat,
    samplerType,
    texture,
    type Type,
    u32,
    vec,
} from "./types.ts";

/** Predeclared types that take no template arguments, including the type aliases. */
export const predeclaredTypes: ReadonlyMap<string, Type> = new Map([
    ["bool", boolType],
    ["i32", i32],
    ["u32", u32],
    ["f32", f32],
    ["f16", f16],
    ["sampler", samplerType],
    ["sampler_comparison", comparisonSamplerType],
    ["texture_depth_2d", texture("texture_depth_2d")],
    ["texture_depth_2d_array", texture("texture_depth_2d_array")],
    ["texture_depth_cube", texture("texture_depth_cube")],
    ["texture_depth_cube_array", texture("texture_depth_cube_array")],
    ["texture_depth_multisampled_2d", texture("texture_depth_multisampled_2d")],
    ["texture_external", texture("texture_external")],
    ...aliases(),
]);

function* aliases(): Generator<[string, Type]> {
    const scalars: [string, Type][] = [
        ["i", i32],
        ["u", u32],
        ["f", f32],
        ["h", f16],
    ];
    for (const [suffix, scalar] of scalars)
        for (let n = 2; n <= 4; n++) yield [`vec${n}${suffix}`, vec(n, scalar)];
    for (const [suffix, scalar] of scalars.slice(2))
        for (let c = 2; c <= 4; c++)
            for (let r = 2; r <= 4; r++) yield [`mat${c}x${r}${suffix}`, mat(c, r, scalar)];
}

/** Whether the alias names a type of the f16 extension. */
export function isF16Alias(name: string): boolean {
    return name.endsWith("h") && (name.startsWith("vec") || name.startsWith("mat"));
}

/** Predeclared type generators: the types parameterized with template arguments. */
export const typeGenerators: ReadonlySet<string> = new Set([
    "vec2",
    "vec3",
    "vec4",
    "mat2x2",
    "mat2x3",
    "mat2x4",
    "mat3x2",
    "mat3x3",
    "mat3x4",
    "mat4x2",
    "mat4x3",
    "mat4x4",
    "array",
    "atomic",
    "ptr",
    "buffer",
    "texture_1d",
    "texture_2d",
    "texture_2d_array",
    "texture_3d",
    "texture_cube",
    "texture_cube_array",
    "texture_multisampled_2d",
    "texture_storage_1d",
    "texture_storage_2d",
    "texture_storage_2d_array",
    "texture_storage_3d",
]);

export const accessModes: readonly string[] = enums.access!;
export const addressSpaces: readonly string[] = [
    "function",
    "private",
    "workgroup",
    "uniform",
    "storage",
    "immediate",
];
export const texelFormats: readonly string[] = enums.texel_format!;

/** Kind of an enumerant name: the enum it belongs to. */
export function enumOf(name: string): "access" | "address space" | "texel format" | undefined {
    if (accessModes.includes(name)) return "access";
    if (addressSpaces.includes(name)) return "address space";
    if (texelFormats.includes(name)) return "texel format";
    return undefined;
}

/** Whether the name is predeclared: a type, type generator, builtin function or enumerant. */
export function isPredeclared(name: string): boolean {
    return (
        predeclaredTypes.has(name) ||
        typeGenerators.has(name) ||
        isBuiltinFunction(name) ||
        !!enumOf(name)
    );
}

/** The abstract numeric types, which can't be spelled in the source. */
export const abstractTypes: readonly Type[] = [abstractInt, abstractFloat];
