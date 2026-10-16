import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { lint } from "../src/index.ts";

/**
 * Compares the analyzer with Tint, the WGSL compiler of Chrome, run by Dawn's node bindings
 * (the webgpu dev dependency) in scripts/tint.ts: both must agree on whether each shader is
 * valid and on the line of the first error. The shaders are the corpus below and, when the
 * WGSL_CORPUS environment variable names a directory, its .wgsl files.
 */

const corpus: readonly string[] = [
    "fn f() -> i32 { let x: f32 = 1; return x; }",
    "fn f() { let x: u32 = -1; }",
    "const x = 1 / 0;",
    "const x = 1.0 / 0.0;",
    "const x: i32 = 2147483648;",
    "const x = -(-9223372036854775807 - 1);",
    "const x = i32(4294967040.0f);",
    "fn f() { var a: array<f32, 4>; _ = a[4]; }",
    "fn f() { let v = vec3f(1, 2, 3); let s = v.xw; }",
    "fn f() { var v = vec4f(); v.zyx = vec3f(1); v.xy.y = 2; }",
    "fn f() { var v = vec4f(); v.xx = vec2f(); }",
    "fn f() { let x = max(1, 2.5); let y = clamp(1, 2u, 3); }",
    "struct S { a: f32 } fn f() { let s = S(1, 2); }",
    "fn f() -> i32 { }",
    "fn f() { loop { } }",
    "fn f() { loop { continuing { break if true; } } }",
    "fn f() { var i = 0; for (; i < 4; i++) { if i == 2 { continue; } } }",
    "fn f(x: i32) { switch x { case 1, 2: {} case 1: {} default: {} } }",
    "alias T = U; alias U = T;",
    "fn f() { g(); } fn g() { f(); }",
    "@group(0) @binding(0) var<storage> s: f16;",
    "enable f16; @group(0) @binding(0) var<storage> s: f16;",
    "@group(0) @binding(0) var<uniform> u: array<f32, 4>;",
    "struct S { a: vec3f, b: f32 } @group(0) @binding(0) var<uniform> u: S;",
    "@group(0) @binding(0) var<storage> s: u32; fn f() { s = 1u; }",
    "@group(0) @binding(0) var<storage, read_write> b: array<u32>; fn f() { let n = arrayLength(&b); }",
    "@vertex fn v() -> vec4f { return vec4f(); }",
    "@vertex fn v() -> @builtin(position) vec4f { return vec4f(); }",
    "@fragment fn f(@builtin(position) p: vec4f, @builtin(position) q: vec4f) {}",
    "@fragment fn f(@location(0) @interpolate(flat) x: f32) -> @location(0) vec4f { return vec4f(x); }",
    "@compute @workgroup_size(0) fn c() {}",
    "@compute @workgroup_size(8, 8) fn c(@builtin(local_invocation_id) id: vec3u) {}",
    "@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(0) var s: sampler; @fragment fn f() { _ = t; _ = s; }",
    "@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;\n@fragment fn f(@location(0) uv: vec2f) -> @location(0) vec4f {\n  if uv.x > 0.5 { return textureSample(t, s, uv); }\n  return vec4f();\n}",
    "diagnostic(off, derivative_uniformity);\n@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(1) var s: sampler;\n@fragment fn f(@location(0) uv: vec2f) -> @location(0) vec4f {\n  if uv.x > 0.5 { return textureSample(t, s, uv); }\n  return vec4f();\n}",
    "@group(0) @binding(0) var<storage, read_write> b: u32;\nfn g() { if b > 0u { workgroupBarrier(); } }\n@compute @workgroup_size(1) fn c() { g(); }",
    "fn g(p: ptr<function, i32>, q: ptr<function, i32>) { *p = *q; }\nfn h() { var x: i32; g(&x, &x); }",
    "var<private> v: i32; fn g(p: ptr<private, i32>) { v = *p; } fn h() { g(&v); }",
    "@group(0) @binding(0) var<storage> v: buffer<8>;\nfn f() { let p = bufferView<vec4u>(&v, 0); }",
    "@group(0) @binding(0) var<storage> v: buffer;\nfn f() { let p = bufferArrayView<array<u32>>(&v, 0, 64); }",
    "@must_use fn f() -> u32 { return 0; } fn g() { f(); }",
    "fn f() { let x = undefined_name; }",
    "requires unknown_feature;",
    "enable unknown;",
    "const_assert 1 > 2;",
    "fn f() { const c = 1; c = 2; }",
    "fn f() { let p = &vec4f().x; }",
    "override o: i32; var<workgroup> a: array<f32, o>; @compute @workgroup_size(1) fn c() { _ = a[0]; }",
    "fn f() { let x = 0x1p129f; }",
    "fn f() { let x = 1e39f; let y = 65520.0h; }",
];

const directory = process.env.WGSL_CORPUS;
const shaders = [
    ...corpus,
    ...(directory ? files(directory).map(f => readFileSync(f, "utf8")) : []),
];
const tint = compile(shaders);

describe.skipIf(!tint)("differential testing against Tint", () => {
    const { extensions, features, results } = tint!;
    const options = { extensions: new Set(extensions), features: new Set(features) };
    it.each(shaders.map((code, i) => [code, results[i]?.line ?? 0] as const))(
        "agrees on %s",
        (code, line) => {
            const [error] = lint(code, options).filter(d => d.severity === "error");
            const ours = error ? code.slice(0, error.start).split("\n").length : 0;
            expect(ours).toBe(line);
        },
    );
});

interface Compilation {
    readonly extensions: readonly string[];
    readonly features: readonly string[];
    readonly results: readonly ({ line: number } | null)[];
}

/** Compiles the shaders with Tint; returns undefined when the bindings are unavailable. */
function compile(codes: readonly string[]): Compilation | undefined {
    const script = join(import.meta.dirname, "../scripts/tint.ts");
    if (!existsSync(join(import.meta.dirname, "../node_modules/webgpu"))) return undefined;
    const result = spawnSync("node", [script], { input: JSON.stringify(codes), encoding: "utf8" });
    return result.status === 0 ? (JSON.parse(result.stdout) as Compilation) : undefined;
}

function files(path: string): string[] {
    if (!statSync(path).isDirectory()) return path.endsWith(".wgsl") ? [path] : [];
    return readdirSync(path).flatMap(entry => files(join(path, entry)));
}
