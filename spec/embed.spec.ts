import { describe, expect, it } from "vite-plus/test";
import { extractTemplates } from "../src/embed.ts";
import { lint } from "../src/index.ts";

describe("template extraction", () => {
    it("skips the templates with substitutions", () => {
        const source = "const s = wgsl`const n = ${count};`; const t = wgsl`const m = 1;`;";
        const [template, ...rest] = extractTemplates(source, ["wgsl"]);
        expect(rest).toEqual([]);
        expect(template?.text).toBe("const m = 1;");
        expect(source.slice(template!.start, template!.end)).toBe("const m = 1;");
    });

    it("replaces the escape sequences by the characters they stand for, keeping the length", () => {
        const source = "wgsl`fn f() {}\\n\\t\\u0041\\u{42}\\x43\\`\\\\\\\n`";
        const [template] = extractTemplates(source, ["wgsl"]);
        expect(template?.text).toBe("fn f() {} \n \t     A     B   C ` \\  ");
        expect(template?.text.length).toBe(template!.end - template!.start);
    });

    it("lints the code after the escaped line breaks", () => {
        const source = "wgsl`// helpers\\nfn one() -> u32 { return -1; }\\n`";
        const [template] = extractTemplates(source, ["wgsl"]);
        expect(lint(template!.text).map(d => d.message)).toEqual([
            "value -1 cannot be represented as 'u32'",
        ]);
    });

    it("recognizes the tags of the comments before the templates", () => {
        expect(extractTemplates("const s = /* wgsl */ `fn f() {}`;", ["wgsl"])[0]?.text).toBe(
            "fn f() {}",
        );
    });

    it("ignores the untagged templates, strings, comments and regular expressions", () => {
        const source = [
            "const a = `wgsl`;",
            "const b = 'wgsl`x`';",
            "// wgsl`x`",
            "const r = /wgsl`x`/g;",
            "const c = other`x`;",
        ].join("\n");
        expect(extractTemplates(source, ["wgsl"])).toEqual([]);
    });

    it("skips the nested templates and braces in the substitutions", () => {
        const source = "wgsl`a ${f({ x: `}` })} b`; wgsl`c`";
        expect(extractTemplates(source, ["wgsl"]).map(t => t.text)).toEqual(["c"]);
    });

    it("finds the templates nested in the substitutions of other templates", () => {
        const source = "wgsl`<p>${wgsl`fn f() {}`}</p>`";
        expect(extractTemplates(source, ["wgsl"]).map(t => t.text)).toEqual(["fn f() {}"]);
    });

    it("supports the custom tags", () => {
        expect(extractTemplates("shader`x`; wgsl`y`", ["shader"]).map(t => t.text)).toEqual(["x"]);
    });
});
