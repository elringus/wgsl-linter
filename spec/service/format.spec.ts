import { describe, expect, it } from "vite-plus/test";
import { format } from "../../src/service/format.ts";

describe("format", () => {
    it("normalizes the spacing and indentation, keeping the line breaks", () => {
        const input =
            "struct   S{a:f32,b : vec2<f32>}\nfn f( x:f32 )->f32{\nlet y=-x*2.0+x;\nif(y>0){return y;}\n  else{\n  return -y ;}\n}\n";
        expect(format(input)).toBe(
            "struct S { a: f32, b: vec2<f32> }\nfn f(x: f32) -> f32 {\n    let y = -x * 2.0 + x;\n    if (y > 0) { return y; }\n    else {\n        return -y; }\n}\n",
        );
    });

    it("formats the attributes, template lists and accessors", () => {
        expect(format("@group( 0 ) @binding(0) var<storage,read_write> a : array< u32 > ;")).toBe(
            "@group(0) @binding(0) var<storage, read_write> a: array<u32>;\n",
        );
        expect(format("fn f(){ let x = a . b [ 0 ] ; i ++ ; }")).toBe(
            "fn f() { let x = a.b[0]; i++; }\n",
        );
    });

    it("keeps the comments and at most one blank line", () => {
        expect(format("const a = 1;   // one\n\n\n\n/* two */ const b = 2;")).toBe(
            "const a = 1; // one\n\n/* two */ const b = 2;\n",
        );
    });

    it("indents the continuation lines within the brackets", () => {
        expect(format("fn f() {\nlet x = max(\n1,\n2\n);\n}")).toBe(
            "fn f() {\n    let x = max(\n        1,\n        2\n    );\n}\n",
        );
    });

    it("uses the indentation and line breaks of the options and the text", () => {
        expect(format("fn f() {\r\nreturn;\r\n}", { indent: "\t" })).toBe(
            "fn f() {\r\n\treturn;\r\n}\r\n",
        );
    });

    it("emits the tokens from the source text when given", () => {
        expect(format("const x =_p______;", { source: "const x =${a + b};" })).toBe(
            "const x = ${a + b};\n",
        );
    });
});
