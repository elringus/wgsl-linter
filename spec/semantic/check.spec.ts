import { describe, expect, it } from "vite-plus/test";
import { analyze, lint } from "../../src/index.ts";
import { typeName } from "../../src/semantic/types.ts";
import { Node } from "../../src/syntax/tree.ts";

function errors(code: string): string[] {
    return lint(code).map(d => d.message);
}

/** Returns the type of the declaration named in the code. */
function typeOf(code: string, name: string): string | undefined {
    const sem = analyze(code);
    const { tree } = sem;
    for (let node = 1; node < tree.count; node++)
        if (
            tree.kinds[node] === Node.Name &&
            tree.text.slice(tree.starts[node], tree.ends[node]) === name
        ) {
            const type = sem.types[tree.parents[node]!];
            return type && typeName(type);
        }
    return undefined;
}

describe("valid modules", () => {
    it.each([
        "fn f() { let x = max(1, 2u); }",
        "fn f() { let x = max(1, 2.5); }",
        "fn f() { if true { return; } else { return; } let x = 1; }",
        "fn f(p: ptr<function, f32>) {} fn g() { var x: f32; f(&x); }",
        "@group(0) @binding(0) var<storage, read_write> b: array<u32>; fn f() { let n = arrayLength(&b); }",
        "enable f16; @group(0) @binding(0) var<storage> s: f16;",
        "struct S { a: vec3f, b: f32 } @group(0) @binding(0) var<uniform> u: S;",
        "fn f() { var v = vec4f(); v.zyx = vec3f(1); v.xy.y = 2; }",
        "override n = 4u; var<workgroup> a: array<f32, n>; fn f() { let p: ptr<workgroup, array<f32, n>> = &a; }",
        "@group(0) @binding(0) var<storage, read_write> v: buffer<64>; fn f() { let p = bufferView<vec4u>(&v, 16); }",
    ])("accepts %s", code => {
        expect(errors(code)).toEqual([]);
    });
});

describe("type checking", () => {
    it.each([
        ["fn f() { let x: u32 = -1; }", "value -1 cannot be represented as 'u32'"],
        ["fn f() { let v = vec3f(1, 2, 3); let s = v.xw; }", "invalid vector swizzle 'xw'"],
        [
            "struct S { a: f32 } fn f() { let s = S(1, 2); }",
            "structure constructor has too many inputs: expected 1, found 2",
        ],
        [
            "const x = vec2(1, 2) + vec3(1, 2, 3);",
            "no matching overload for operator + (vec2<abstract-int>, vec3<abstract-int>)",
        ],
        ["fn f() { let x = 1; x = 2; }", "cannot assign to value expression"],
        [
            "@group(0) @binding(0) var<storage> s: u32; fn f() { s = 1u; }",
            "cannot store into a read-only memory view",
        ],
        ["fn f() { let x = undefined_name; }", "unresolved identifier 'undefined_name'"],
        [
            "fn f() { var v = vec4f(); v.xx = vec2f(); }",
            "cannot assign to vector swizzle with duplicate target components",
        ],
    ])("reports %s", (code, message) => {
        expect(errors(code)).toEqual([message]);
    });

    it("infers the concrete types of the declarations", () => {
        const code =
            "const a = 1; fn f() { let b = 1; let c = 1.5; var d = vec2(1, 2); let e = a * 2u; }";
        expect(typeOf(code, "a")).toBe("abstract-int");
        expect(typeOf(code, "b")).toBe("i32");
        expect(typeOf(code, "c")).toBe("f32");
        expect(typeOf(code, "d")).toBe("ref<function, vec2<i32>, read_write>");
        expect(typeOf(code, "e")).toBe("u32");
    });
});

describe("const-evaluation", () => {
    it.each([
        ["const x: i32 = 3000000000;", "value 3000000000 cannot be represented as 'i32'"],
        ["const x = 1 / 0;", "'1 / 0' cannot be represented as 'abstract-int'"],
        ["const x = sqrt(-1.0);", "sqrt must be called with a value >= 0"],
        ["const_assert 1 > 2;", "const assertion failed"],
        ["fn f() { var a: array<f32, 4>; _ = a[4]; }", "index 4 out of bounds [0..3]"],
    ])("reports %s", (code, message) => {
        expect(errors(code)).toEqual([message]);
    });

    it("evaluates the declarations' values", () => {
        const sem = analyze(
            "enable f16; const a = 2.5h * 2; const b = vec2(1, 2).yx; const c = i32(-2.9);",
        );
        const values = sem.resolution.order.map(decl => sem.values[decl]);
        expect(values).toEqual([5, [2n, 1n], -2]);
    });

    it("doesn't evaluate the right-hand side of a short-circuited expression", () => {
        expect(errors("const x = false && (1 / 0 == 0);")).toEqual([]);
    });
});

describe("validation", () => {
    it.each([
        ["fn f() -> i32 { }", "missing return at end of function"],
        ["fn f() { loop { } }", "loop does not exit"],
        [
            "@group(0) @binding(0) var<storage> s: f16;",
            "f16 type used without 'f16' extension enabled",
        ],
        [
            "@fragment fn f(@builtin(position) p: vec4f, @builtin(position) q: vec4f) {}",
            "@builtin(position) appears multiple times as pipeline input",
        ],
        [
            "fn f() { var<private> x: f32; }",
            "function-scope 'var' declaration must use 'function' address space",
        ],
        ["requires unknown_feature;", "feature 'unknown_feature' is not supported"],
        ["enable unknown;", "unknown extension 'unknown'"],
        ["alias T = U; alias U = T;", "cyclic dependency found: 'T' -> 'U' -> 'T'"],
        ["@compute @workgroup_size(0) fn c() {}", "workgroup_size argument must be at least 1"],
        ["fn f() { let h = 1h; }", "f16 literal used without 'f16' extension enabled"],
        ["@must_use() fn f() -> u32 { return 0; }", "@must_use does not take arguments"],
        [
            "@group(0) @binding(0) var<storage, read_write> b: u32; @vertex fn v() -> @builtin(position) vec4f { b = 1u; return vec4f(); }",
            "cannot be used in a vertex entry point",
        ],
    ])("reports %s", (code, message) => {
        expect(errors(code)).toContain(message);
    });

    it("reports all the errors at once", () => {
        expect(errors("fn f() { let a: u32 = -1; let b = c; loop {} }")).toEqual([
            "value -1 cannot be represented as 'u32'",
            "unresolved identifier 'c'",
            "loop does not exit",
        ]);
    });

    it("reports the conflicting resource bindings of an entry point", () => {
        const code =
            "@group(0) @binding(0) var t: texture_2d<f32>; @group(0) @binding(0) var s: sampler; @fragment fn f() { _ = t; _ = s; }";
        expect(errors(code)).toEqual([
            "entry point 'f' references multiple variables that use the same resource binding @group(0), @binding(0)",
        ]);
    });
});

describe("alias analysis", () => {
    it("reports the aliased pointer arguments of a function writing through them", () => {
        const code =
            "fn g(p: ptr<function, i32>, q: ptr<function, i32>) { *p = *q; } fn h() { var x: i32; g(&x, &x); }";
        const [diagnostic] = lint(code);
        expect(diagnostic?.message).toBe("invalid aliased pointer argument");
        expect(diagnostic?.notes?.map(n => n.message)).toEqual([
            "aliases with another argument passed here",
        ]);
    });

    it("accepts the aliased pointers only read from", () => {
        expect(
            errors(
                "fn g(p: ptr<function, i32>, q: ptr<function, i32>) -> i32 { return *p + *q; } fn h() { var x: i32; _ = g(&x, &x); }",
            ),
        ).toEqual([]);
    });

    it("reports a pointer argument aliasing a module-scope variable the callee writes", () => {
        const code =
            "var<private> v: i32; fn g(p: ptr<private, i32>) { v = *p; } fn h() { g(&v); }";
        expect(errors(code)).toEqual(["invalid aliased pointer argument"]);
    });
});

describe("buffer views", () => {
    it.each([
        [
            "@group(0) @binding(0) var<storage> v: buffer<8>; fn f() { let p = bufferView<vec4u>(&v, 0); }",
            "the offset argument of bufferView plus the minimum size of the return type must be less than or equal to the buffer size",
        ],
        [
            "@group(0) @binding(0) var<uniform> v: buffer<128>; fn f() { let p = bufferView<vec4u>(&v, 12); }",
            "the offset argument of bufferView must evenly divide the alignment of the return type (16)",
        ],
        [
            "@group(0) @binding(0) var<storage> v: buffer; fn f() { let p = bufferArrayView<f32>(&v, 0, 128); }",
            "return type of bufferArrayView cannot have a fixed footprint",
        ],
        [
            "@group(0) @binding(0) var<uniform> v: buffer<28>; fn g(p: ptr<uniform, buffer>) { let q = bufferView<vec4u>(p, 16); } fn f() { g(&v); }",
            "buffer size (28 bytes) is smaller than the minimum view size (32 bytes)",
        ],
    ])("reports %s", (code, message) => {
        expect(errors(code)).toEqual([message]);
    });
});
