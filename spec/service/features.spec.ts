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
