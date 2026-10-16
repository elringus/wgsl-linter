import { describe, expect, it } from "vite-plus/test";
import { lint } from "../../src/index.ts";

const resources =
    "@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;\n";
const sampleIf = (attributes = "") =>
    `${resources}@fragment fn f(@location(0) uv: vec2f) -> @location(0) vec4f { ${attributes} if uv.x > 0.5 { return textureSample(t, s, uv); } return vec4f(); }`;

describe("uniformity analysis", () => {
    it("reports a derivative in non-uniform control flow, explaining the cause", () => {
        const [diagnostic, ...rest] = lint(sampleIf());
        expect(rest).toEqual([]);
        expect(diagnostic?.severity).toBe("error");
        expect(diagnostic?.message).toBe(
            "'textureSample' must only be called from uniform control flow",
        );
        expect(diagnostic?.notes?.map(n => n.message)).toEqual([
            "control flow depends on possibly non-uniform value",
            "user-defined input 'uv' of 'f' may be non-uniform",
        ]);
    });

    it("accepts a derivative in uniform control flow", () => {
        const code = `${resources}@fragment fn f(@location(0) uv: vec2f) -> @location(0) vec4f { var c = vec4f(); if uv.x > 0.5 { c = vec4f(1); } return textureSample(t, s, uv) * c; }`;
        expect(lint(code)).toEqual([]);
    });

    it("applies the severity of the diagnostic directives and attributes", () => {
        const warning = lint(`diagnostic(warning, derivative_uniformity);\n${sampleIf()}`);
        expect(warning.map(d => d.severity)).toEqual(["warning"]);
        expect(lint(sampleIf("@diagnostic(off, derivative_uniformity)"))).toEqual([]);
    });

    it("tracks the requirements through the function calls", () => {
        const code =
            "@group(0) @binding(0) var<storage, read_write> b: u32;\nfn g() { if b > 0u { workgroupBarrier(); } }\n@compute @workgroup_size(1) fn c() { g(); }";
        const [diagnostic] = lint(code);
        expect(diagnostic?.message).toBe(
            "'workgroupBarrier' must only be called from uniform control flow",
        );
        expect(diagnostic?.notes?.at(-1)?.message).toBe(
            "reading from read_write storage buffer 'b' may result in a non-uniform value",
        );
    });

    it("treats the workgroup-uniform builtins as uniform in compute shaders", () => {
        const uniform =
            "@compute @workgroup_size(64) fn c(@builtin(workgroup_id) w: vec3u) { if w.x > 0u { workgroupBarrier(); } }";
        const varying =
            "@compute @workgroup_size(64) fn c(@builtin(local_invocation_index) i: u32) { if i > 0u { workgroupBarrier(); } }";
        expect(lint(uniform)).toEqual([]);
        expect(lint(varying).map(d => d.message)).toEqual([
            "'workgroupBarrier' must only be called from uniform control flow",
        ]);
    });

    it("follows the values written through pointer parameters", () => {
        const code =
            "fn f(p: ptr<function, u32>) { *p = 1u; } @compute @workgroup_size(64) fn c(@builtin(local_invocation_index) i: u32) { var x = i; f(&x); if x > 0u { workgroupBarrier(); } }";
        expect(lint(code)).toEqual([]);
    });

    it("analyzes the subgroup uniformity separately", () => {
        const code =
            "enable subgroups;\n@compute @workgroup_size(64) fn c(@builtin(local_invocation_index) i: u32) { if i > 0u { _ = subgroupAdd(1u); } }";
        expect(lint(code).map(d => d.message)).toEqual([
            "'subgroupAdd' must only be called from subgroup uniform control flow",
        ]);
    });
});
