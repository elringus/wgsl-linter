import { describe, expect, it } from "vite-plus/test";
import { completion, CompletionKind } from "../../src/service/completion.ts";
import { Document } from "../../src/service/document.ts";
import { inlayHints } from "../../src/service/hints.ts";
import { hover } from "../../src/service/hover.ts";
import {
    definition,
    isValidName,
    prepareRename,
    references,
    rename,
} from "../../src/service/navigation.ts";
import { signatureHelp } from "../../src/service/signature.ts";
import { documentSymbols, foldingRanges, SymbolKind } from "../../src/service/symbols.ts";
import { semanticTokens, TokenModifier, TokenType } from "../../src/service/tokens.ts";

const shader = `// Light parameters.
struct Light {
    color: vec3f,
    intensity: f32,
}
@group(0) @binding(0) var<uniform> light: Light;
const scale = 2.0;
fn shade(n: vec3f) -> vec3f {
    let k = max(dot(n, vec3f(0, 1, 0)), 0.0);
    var c = light.color * k * scale;
    return c.xyz;
}
`;

const doc = new Document(shader);

/** Returns the offset of the needle in the shader, moved by the delta. */
function at(needle: string, delta = 0): number {
    const index = shader.indexOf(needle);
    if (index < 0) throw new Error(`'${needle}' not found`);
    return index + delta;
}

function text(range: { start: number; end: number } | undefined): string | undefined {
    return range && shader.slice(range.start, range.end);
}

describe("hover", () => {
    it("describes the variables with their address space and type", () => {
        expect(hover(doc, at("light.color", 2))?.code).toBe("var<uniform> light: Light");
    });

    it("shows the structures in buffers with their layout and the preceding comments", () => {
        expect(hover(doc, at("Light {", 1))).toEqual({
            start: at("Light {"),
            end: at("Light {", 5),
            code: "struct Light {\n    color: vec3<f32>,\n    intensity: f32,\n}",
            layout: { size: 16, align: 16 },
            documentation: "Light parameters.",
        });
    });

    it("shows the layout only for the types in buffers", () => {
        const code = "struct Out { @builtin(position) p: vec4f, @location(0) c: vec4f }";
        const result = hover(new Document(code), code.indexOf("Out"));
        expect(result?.code).toBe(
            "struct Out {\n    @builtin(position) p: vec4<f32>,\n    @location(0) c: vec4<f32>,\n}",
        );
        expect(result?.layout).toBeUndefined();
    });

    it("shows the layout of the buffer variables", () => {
        expect(hover(doc, at("light: ", 1))?.layout).toEqual({ size: 16, align: 16 });
    });

    it("shows the struct members with their layout", () => {
        const result = hover(doc, at("color *", 1));
        expect(result?.code).toBe("Light.color: vec3<f32>");
        expect(result?.layout).toEqual({ offset: 0, size: 12, align: 16 });
    });

    it("shows the builtin overload selected for the call", () => {
        expect(hover(doc, at("max(", 1))?.code).toBe("fn max(f32, f32) -> f32");
    });

    it("shows the predeclared type aliases with their layout", () => {
        const result = hover(doc, at("vec3f(0", 1));
        expect(result?.code).toBe("alias vec3f = vec3<f32>");
        expect(result?.layout).toEqual({ size: 12, align: 16 });
    });

    it("shows the constants with their values", () => {
        expect(hover(doc, at("scale;", 1))?.code).toBe("const scale: abstract-float = 2.0");
    });

    it("works with the cursor right after the name", () => {
        expect(hover(doc, at("light.color", 5))?.code).toBe("var<uniform> light: Light");
    });

    it("describes the builtin functions with links to the specification", () => {
        expect(hover(doc, at("dot(", 1))).toEqual({
            start: at("dot("),
            end: at("dot(", 3),
            code: "fn dot(vec3<f32>, vec3<f32>) -> f32",
            documentation: "Returns the dot product of `e1` and `e2`.",
            link: "https://www.w3.org/TR/WGSL/#dot-builtin",
        });
    });

    it("describes the builtin function overloads described differently by their parameters", () => {
        const code = `var<workgroup> a: atomic<u32>;
var<workgroup> v: u32;
fn f(b: vec2<bool>) {
    _ = extractBits(1u, 0, 1);
    _ = extractBits(vec2i(1), 0, 1);
    _ = select(vec2i(1), vec2i(2), b);
    _ = mix(vec2f(), vec2f(), 0.5);
    _ = workgroupUniformLoad(&a);
    _ = workgroupUniformLoad(&v);
}`;
        const describe = (call: string): string | undefined =>
            hover(new Document(code), code.indexOf(call) + 1)?.documentation;
        expect(describe("extractBits(1u")).toBe(
            "Reads bits from an integer, without sign extension.",
        );
        expect(hover(new Document(code), code.indexOf("extractBits(1u") + 1)?.link).toBe(
            "https://www.w3.org/TR/WGSL/#extractBits-unsigned-builtin",
        );
        expect(describe("extractBits(vec2i")).toBe(
            "Reads bits from an integer, with sign extension.",
        );
        expect(describe("select")).toMatch(/^Component-wise selection\./);
        expect(describe("mix")).toMatch(/using scalar blending factor/);
        expect(describe("workgroupUniformLoad(&a")).toMatch(/^Atomically loads/);
        expect(describe("workgroupUniformLoad(&v")).toMatch(/^Returns the value pointed to/);
    });

    it("describes the predeclared types and type generators", () => {
        expect(hover(doc, at("f32,", 1))?.link).toBe("https://www.w3.org/TR/WGSL/#f32");
        expect(hover(doc, at("vec3f(0", 1))?.documentation).toBe(
            "A vector is a grouped sequence of 2, 3, or 4 scalar components.",
        );
        const code = "var<private> a: array<f32, 2>;";
        const array = hover(new Document(code), code.indexOf("array"));
        expect(array?.code).toBe("array<f32, 2>");
        expect(array?.link).toBe("https://www.w3.org/TR/WGSL/#array");
    });

    it("describes the constructors inferring their types", () => {
        const code = "const a = array(vec2f(0, 1), vec2f(1, 0));";
        const result = hover(new Document(code), code.indexOf("array"));
        expect(result?.code).toBe("array<vec2<f32>, 2>");
        expect(result?.link).toBe("https://www.w3.org/TR/WGSL/#array");
    });

    it("describes the enumerants by their enums", () => {
        const result = hover(doc, at("uniform>", 1));
        expect(result?.code).toBe("address space uniform");
        expect(result?.link).toBe("https://www.w3.org/TR/WGSL/#address-spaces");
    });

    it("describes the attributes", () => {
        const code = "@compute @workgroup_size(64, 1) fn main() {}";
        expect(hover(new Document(code), code.indexOf("workgroup_size"))).toEqual({
            start: code.indexOf("workgroup_size"),
            end: code.indexOf("("),
            code: "@workgroup_size(64, 1)",
            documentation:
                "Specifies the x, y, and z dimensions of the workgroup grid for the compute shader.",
            link: "https://www.w3.org/TR/WGSL/#workgroup-size-attr",
        });
        expect(hover(new Document("@unknown fn f() {}"), 1)).toBeUndefined();
    });

    it("describes the builtin values by their stages and directions", () => {
        const code = "@fragment fn main(@builtin(position) p: vec4f) {}";
        expect(hover(new Document(code), code.indexOf("position"))).toEqual({
            start: code.indexOf("position"),
            end: code.indexOf(") p"),
            code: "builtin position: vec4<f32>",
            documentation:
                "Vertex output: The clip position of the current vertex, in clip space coordinates.\n\n" +
                "Fragment input: Input position of the current fragment rasterization point.",
            link: "https://www.w3.org/TR/WGSL/#built-in-values-position",
        });
    });
});

describe("navigation", () => {
    it("goes to the declaration of the name", () => {
        expect(definition(doc, at("light.color", 1))).toEqual({
            start: at("light: "),
            end: at("light: ", 5),
        });
        expect(definition(doc, at("color *", 1))).toEqual({
            start: at("color:"),
            end: at("color:", 5),
        });
    });

    it("finds the references, including the declaration", () => {
        expect(references(doc, at("Light {", 1))?.map(text)).toEqual(["Light", "Light"]);
        expect(references(doc, at("k *", 0))?.map(r => r.start)).toEqual([at("k ="), at("k *")]);
        expect(references(doc, at("k *", 0), false)?.map(r => r.start)).toEqual([at("k *")]);
    });

    it("renames the user declarations only", () => {
        expect(text(prepareRename(doc, at("scale;", 1)))).toBe("scale");
        expect(rename(doc, at("scale;", 1))?.length).toBe(2);
        expect(prepareRename(doc, at("max(", 1))).toBeUndefined();
        expect(isValidName("light2")).toBe(true);
        expect(isValidName("2light")).toBe(false);
        expect(isValidName("fn")).toBe(false);
        expect(isValidName("__x")).toBe(false);
    });

    it("doesn't rename the declarations of the prelude", () => {
        const preluded = new Document("fn f() -> f32 { return g(); }", {
            prelude: "fn g() -> f32 { return 1.0; }",
        });
        const offset = preluded.sourceOffset(preluded.text.indexOf("g("));
        expect(prepareRename(preluded, offset)).toBeUndefined();
        expect(rename(preluded, offset)).toBeUndefined();
    });
});

describe("prelude", () => {
    it("reports the symbols, folding, tokens and hints of the text only", () => {
        const text = "enable f16;\nconst a = 1;\n";
        const plain = new Document(text);
        const preluded = new Document(text, {
            prelude: "// Shared\n// lines.\nstruct P {\n    x: f32,\n}\nconst b = 2;",
        });
        const offset = (doc: Document) => (value: number, i: number) =>
            i % 4 === 0 ? doc.textOffset(value) : value;
        expect(documentSymbols(preluded).map(s => s.name)).toEqual(["a"]);
        expect(foldingRanges(preluded)).toEqual([]);
        expect(semanticTokens(preluded).map(offset(preluded))).toEqual(semanticTokens(plain));
        expect(
            inlayHints(preluded, 0, preluded.source.length).map(hint => ({
                ...hint,
                offset: preluded.textOffset(hint.offset),
            })),
        ).toEqual(inlayHints(plain, 0, text.length));
    });
});

describe("completion", () => {
    const labels = (offset: number, kind?: CompletionKind) =>
        completion(doc, offset)
            ?.items.filter(item => kind === undefined || item.kind === kind)
            .map(item => item.label);

    it("completes the struct members after a period", () => {
        expect(labels(at("color *"))).toEqual(["color", "intensity"]);
    });

    it("completes the swizzles of the vectors", () => {
        expect(labels(at("xyz;"))).toContain("xyz");
        expect(labels(at("xyz;"))).toContain("rgb");
    });

    it("completes the names in scope, the builtins and the keywords", () => {
        const offset = at("return c", 7);
        expect(labels(offset, CompletionKind.Variable)).toEqual(["k", "c", "light"]);
        expect(labels(offset, CompletionKind.Parameter)).toEqual(["n"]);
        expect(labels(offset, CompletionKind.Function)).toContain("textureSample");
        expect(labels(offset, CompletionKind.Keyword)).toContain("return");
    });

    it("completes the address spaces in the template list of var", () => {
        const code = new Document("var<");
        expect(completion(code, 4)?.items.map(i => i.label)).toContain("workgroup");
    });

    it("completes the attribute names after @", () => {
        const code = new Document("@");
        expect(completion(code, 1)?.items.map(i => i.label)).toContain("workgroup_size");
    });

    it("doesn't complete in the comments", () => {
        expect(completion(doc, at("Light param"))).toBeUndefined();
    });
});

describe("signature help", () => {
    it("shows the overloads of the builtin and the active argument", () => {
        const help = signatureHelp(doc, at("0.0)"));
        expect(help?.signatures[0]?.label).toBe("max(T, T) -> T");
        expect(help?.parameter).toBe(1);
    });

    it("shows the signature of the user function", () => {
        const code = "fn f(a: i32, b: f32) -> f32 { return b; } fn g() { _ = f(1, ";
        const help = signatureHelp(new Document(code), code.length);
        expect(help?.signatures).toEqual([
            {
                label: "f(a: i32, b: f32) -> f32",
                parameters: [
                    [2, 8],
                    [10, 16],
                ],
            },
        ]);
        expect(help?.parameter).toBe(1);
    });
});

describe("outline", () => {
    it("lists the module-scope declarations and the struct members", () => {
        const symbols = documentSymbols(doc).map(s => [
            s.name,
            SymbolKind[s.kind],
            s.children.map(c => c.name),
        ]);
        expect(symbols).toEqual([
            ["Light", "Struct", ["color", "intensity"]],
            ["light", "Variable", []],
            ["scale", "Constant", []],
            ["shade", "Function", []],
        ]);
    });

    it("folds the multiline blocks and comments", () => {
        const code = new Document("// a\n// b\nfn f() {\n}\nfn g() {}");
        expect(foldingRanges(code)).toEqual([
            { start: 0, end: 9, comment: true },
            { start: 17, end: 19, comment: false },
        ]);
    });
});

describe("semantic tokens", () => {
    it("tells the struct constructors from the builtin functions", () => {
        const code = "struct S { a: f32 } fn f() { let s = S(max(1.0, 2.0)); }";
        const data = semanticTokens(new Document(code));
        const tokens: [string, TokenType, number][] = [];
        for (let i = 0; i < data.length; i += 4)
            tokens.push([
                code.slice(data[i]!, data[i]! + data[i + 1]!),
                data[i + 2]!,
                data[i + 3]!,
            ]);
        expect(tokens).toEqual([
            ["S", TokenType.Struct, TokenModifier.Declaration],
            ["a", TokenType.Property, TokenModifier.Declaration],
            ["f32", TokenType.Type, TokenModifier.DefaultLibrary],
            ["f", TokenType.Function, TokenModifier.Declaration],
            ["s", TokenType.Variable, TokenModifier.Declaration | TokenModifier.Readonly],
            ["S", TokenType.Struct, TokenModifier.None],
            ["max", TokenType.Function, TokenModifier.DefaultLibrary],
        ]);
    });
});

describe("inlay hints", () => {
    it("shows the inferred types of the declarations without types", () => {
        expect(inlayHints(doc, 0, shader.length)).toEqual([
            { offset: at("scale", 5), label: ": abstract-float" },
            { offset: at("k =", 1), label: ": f32" },
            { offset: at("c =", 1), label: ": vec3<f32>" },
        ]);
    });
});
