// Compiles WGSL shaders with Tint, the WGSL compiler of Chrome, via Dawn's node bindings
// (the webgpu dev dependency) on the null backend, for comparing the analyzer with Tint.
// Usage: node scripts/tint.ts < shaders.json, where the input is a JSON array of the shader
// sources; prints a JSON object with the WGSL extensions and language features of the device
// and, for each shader, its first error as { line, column, message }, or null when it's valid.
// Runs in Node, which strips the types: the bindings crash in Bun and in the test workers.

import { create, globals } from "webgpu";

/** The WGSL enable-extensions of the device features. */
const extensions: Readonly<Record<string, string>> = {
    "shader-f16": "f16",
    "clip-distances": "clip_distances",
    "dual-source-blending": "dual_source_blending",
    subgroups: "subgroups",
    "primitive-index": "primitive_index",
    "subgroup-size-control": "subgroup_size_control",
    "atomic-vec2u-min-max": "atomic_vec2u_min_max",
};

let input = "";
for await (const chunk of process.stdin) input += chunk;
const shaders = JSON.parse(input) as string[];

Object.assign(globalThis, globals);
const gpu = create(["backend=null"]);
const adapter = (await gpu.requestAdapter())!;
const requiredFeatures = Object.keys(extensions).filter(f => adapter.features.has(f));
const device = await adapter.requestDevice({
    requiredFeatures: requiredFeatures as GPUFeatureName[],
});
const results: ({ line: number; column: number; message: string } | null)[] = [];
for (const code of shaders) {
    device.pushErrorScope("validation");
    const module = device.createShaderModule({ code });
    await device.popErrorScope();
    const { messages } = await module.getCompilationInfo();
    const error = messages.find(m => m.type === "error");
    results.push(
        error ? { line: error.lineNum, column: error.linePos, message: error.message } : null,
    );
}
device.destroy();
console.log(
    JSON.stringify({
        extensions: requiredFeatures.map(f => extensions[f]),
        features: [...gpu.wgslLanguageFeatures],
        results,
    }),
);
