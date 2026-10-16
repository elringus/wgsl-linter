import { Kind, type Type, typeName } from "./types.ts";

/** Shader stages as a bit set. */
export enum Stages {
    None = 0,
    Vertex = 1,
    Fragment = 2,
    Compute = 4,
    All = 7,
}

/** IO attributes of an entry point parameter, return type or structure member. */
export interface Io {
    readonly node: number;
    readonly type: Type;
    /** The builtin value name, or empty. */
    builtin: string;
    builtinAttr: number;
    /** The location value, or -1 when absent or unknown. */
    location: number;
    locationAttr: number;
    blendSrc: number;
    blendSrcAttr: number;
    interpolation: string;
    interpolateAttr: number;
    invariantAttr: number;
}

interface BuiltinValue {
    readonly inputs: Stages;
    readonly outputs: Stages;
    readonly type: string;
    readonly accepts: (type: Type) => boolean;
    readonly extension?: string;
    readonly feature?: string;
}

const isU32 = (t: Type): boolean => t.kind === Kind.U32;
const isVec3u = (t: Type): boolean =>
    t.kind === Kind.Vector && t.count === 3 && t.elem!.kind === Kind.U32;
const u32Input = (stages: Stages, extension?: string, feature?: string): BuiltinValue => ({
    inputs: stages,
    outputs: Stages.None,
    type: "u32",
    accepts: isU32,
    extension,
    feature,
});
const vec3uInput: BuiltinValue = {
    inputs: Stages.Compute,
    outputs: Stages.None,
    type: "vec3<u32>",
    accepts: isVec3u,
};

/** The builtin input and output values. */
export const builtinValues: ReadonlyMap<string, BuiltinValue> = new Map([
    ["vertex_index", u32Input(Stages.Vertex)],
    ["instance_index", u32Input(Stages.Vertex)],
    [
        "clip_distances",
        {
            inputs: Stages.None,
            outputs: Stages.Vertex,
            type: "array<f32, N> (N <= 8)",
            accepts: t =>
                t.kind === Kind.Array && t.elem!.kind === Kind.F32 && t.count > 0 && t.count <= 8,
            extension: "clip_distances",
        },
    ],
    [
        "position",
        {
            inputs: Stages.Fragment,
            outputs: Stages.Vertex,
            type: "vec4<f32>",
            accepts: t => t.kind === Kind.Vector && t.count === 4 && t.elem!.kind === Kind.F32,
        },
    ],
    [
        "front_facing",
        {
            inputs: Stages.Fragment,
            outputs: Stages.None,
            type: "bool",
            accepts: t => t.kind === Kind.Bool,
        },
    ],
    [
        "frag_depth",
        {
            inputs: Stages.None,
            outputs: Stages.Fragment,
            type: "f32",
            accepts: t => t.kind === Kind.F32,
        },
    ],
    ["primitive_index", u32Input(Stages.Fragment, "primitive_index")],
    ["sample_index", u32Input(Stages.Fragment)],
    [
        "sample_mask",
        { inputs: Stages.Fragment, outputs: Stages.Fragment, type: "u32", accepts: isU32 },
    ],
    ["local_invocation_id", vec3uInput],
    ["local_invocation_index", u32Input(Stages.Compute)],
    ["global_invocation_id", vec3uInput],
    ["global_invocation_index", u32Input(Stages.Compute, undefined, "linear_indexing")],
    ["workgroup_id", vec3uInput],
    ["workgroup_index", u32Input(Stages.Compute, undefined, "linear_indexing")],
    ["num_workgroups", vec3uInput],
    ["subgroup_invocation_id", u32Input(Stages.Compute | Stages.Fragment, "subgroups")],
    ["subgroup_size", u32Input(Stages.Compute | Stages.Fragment, "subgroups")],
    ["subgroup_id", u32Input(Stages.Compute, "subgroups", "subgroup_id")],
    ["num_subgroups", u32Input(Stages.Compute, "subgroups", "subgroup_id")],
]);

export const interpolationTypes: readonly string[] = ["perspective", "linear", "flat"];
export const interpolationSamplings: readonly string[] = [
    "center",
    "centroid",
    "sample",
    "first",
    "either",
];

export function stageName(stage: Stages): string {
    return stage === Stages.Vertex ? "vertex" : stage === Stages.Fragment ? "fragment" : "compute";
}

/** Whether the type is an integer scalar or vector. */
export function isIntegral(type: Type): boolean {
    const scalar = type.kind === Kind.Vector ? type.elem! : type;
    return scalar.kind === Kind.I32 || scalar.kind === Kind.U32;
}

/** One side of an entry point interface: its parameters or its return type. */
export interface IoGroup {
    /** IO of a parameter or the return type. */
    readonly io: Io;
    /** IO of the members when the type is a structure. */
    readonly members: readonly Io[] | undefined;
}

/**
 * Validates the inputs or outputs of an entry point for its stage.
 * @param error reports an error at the node
 */
export function validateIo(
    stage: Stages,
    groups: readonly IoGroup[],
    input: boolean,
    error: (node: number, message: string) => void,
): Set<string> {
    const builtins = new Set<string>();
    const locations = new Set<string>();
    const direction = input ? "input" : "output";
    const check = (io: Io, member: boolean): boolean => {
        if (member && io.type.kind === Kind.Struct) {
            error(io.node, "nested structures cannot be used for entry point IO");
            return false;
        }
        if (io.type.kind !== Kind.Struct && !io.builtin && !io.locationAttr) {
            error(
                io.node,
                `missing entry point IO attribute${member ? "" : input ? " on parameter" : " on return type"}`,
            );
            return false;
        }
        if (io.builtin) {
            const value = builtinValues.get(io.builtin);
            if (value && !((input ? value.inputs : value.outputs) & stage)) {
                error(
                    io.builtinAttr,
                    `@builtin(${io.builtin}) cannot be used for ${stageName(stage)} shader ${direction}`,
                );
                return false;
            }
            if (builtins.has(io.builtin)) {
                error(
                    io.builtinAttr,
                    `@builtin(${io.builtin}) appears multiple times as pipeline ${direction}`,
                );
                return false;
            }
            builtins.add(io.builtin);
        }
        if (io.locationAttr) {
            if (stage === Stages.Compute) {
                error(io.locationAttr, "@location cannot be used by compute shaders");
                return false;
            }
            if (io.location >= 0) {
                const key = `${io.location}:${io.blendSrc < 0 ? 0 : io.blendSrc}`;
                if (locations.has(key)) {
                    error(io.locationAttr, `@location(${io.location}) appears multiple times`);
                    return false;
                }
                locations.add(key);
            }
            if (isIntegral(io.type) && !io.interpolateAttr) {
                if (stage === Stages.Vertex && !input) {
                    error(
                        io.node,
                        "integral user-defined vertex outputs must have a @interpolate(flat) attribute",
                    );
                    return false;
                }
                if (stage === Stages.Fragment && input) {
                    error(
                        io.node,
                        "integral user-defined fragment inputs must have a @interpolate(flat) attribute",
                    );
                    return false;
                }
            }
        }
        if (io.interpolateAttr && stage === Stages.Compute) {
            error(io.interpolateAttr, "@interpolate cannot be used by compute shaders");
            return false;
        }
        if (io.invariantAttr && stage === Stages.Compute) {
            error(io.invariantAttr, "@invariant cannot be used by compute shaders");
            return false;
        }
        if (io.blendSrcAttr && (stage !== Stages.Fragment || input)) {
            error(io.blendSrcAttr, "@blend_src can only be used for fragment shader output");
            return false;
        }
        if (io.interpolateAttr && !io.locationAttr) {
            error(io.interpolateAttr, "@interpolate can only be used with @location");
            return false;
        }
        if (io.invariantAttr && io.builtin !== "position") {
            error(io.invariantAttr, "@invariant must be applied to a @builtin(position)");
            return false;
        }
        return true;
    };
    for (const group of groups) {
        if (!check(group.io, false)) break;
        if (group.members && !group.members.every(m => check(m, true))) break;
    }
    return builtins;
}

/** Formats the type for the builtin type mismatch message. */
export function builtinTypeMessage(builtin: string, type: Type): string {
    const value = builtinValues.get(builtin)!;
    return `store type of @builtin(${builtin}) must be '${value.type}', got '${typeName(type)}'`;
}
