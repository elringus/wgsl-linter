import { describe, expect, it } from "vite-plus/test";
import { analyze, validatePipeline } from "../../src/index.ts";

describe("pipeline creation", () => {
    const compute = (
        code: string,
        constants: Record<string, number> = {},
        limits: Record<string, number> = {},
    ) => validatePipeline(analyze(code), { stage: "compute", constants, limits });

    it("evaluates the overrides with the pipeline constants", () => {
        const code = "override size: u32 = 64; @compute @workgroup_size(size) fn c() {}";
        const limits = { maxComputeWorkgroupSizeX: 256 };
        expect(compute(code, {}, limits)).toBeUndefined();
        expect(compute(code, { size: 1024 }, limits)).toBe(
            "workgroup_size x (1024) exceeds the limit of 256",
        );
    });

    it("rejects the constants the module doesn't declare", () => {
        expect(compute("@compute @workgroup_size(1) fn c() {}", { nope: 1 })).toBe(
            "pipeline constant 'nope' is not an override declared by the module",
        );
    });

    it("validates the override-sized arrays", () => {
        const code =
            "override n: i32 = 4; var<workgroup> a: array<f32, n>; @compute @workgroup_size(1) fn c() { _ = a[0]; }";
        expect(compute(code)).toBeUndefined();
        expect(compute(code, { n: 0 })).toBe("array count (0) must be greater than 0");
    });

    it("validates the override-expressions of the runtime expressions", () => {
        const code =
            "override d: i32 = 1; @compute @workgroup_size(1) fn c() { var x = 4; x = x / d; }";
        expect(compute(code)).toBeUndefined();
        expect(compute(code, { d: 0 })).toBe("integer division by zero is invalid");
    });

    it("validates the buffer views with the override offsets", () => {
        const code =
            "@group(0) @binding(0) var<uniform> v: buffer<24>; override offset: u32; @compute @workgroup_size(1) fn c() { let p = bufferView<vec4u>(&v, offset); }";
        expect(compute(code, { offset: 0 })).toBeUndefined();
        expect(compute(code, { offset: 16 })).toBe(
            "the offset argument of bufferView plus the minimum size of the return type must be less than or equal to the buffer size",
        );
    });

    it("finds the entry point of the stage", () => {
        const sem = analyze("@compute @workgroup_size(1) fn c() {}");
        expect(
            validatePipeline(sem, { stage: "compute", entryPoint: "x", constants: {}, limits: {} }),
        ).toBe("entry point 'x' not found");
    });
});
