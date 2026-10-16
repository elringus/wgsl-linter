import { describe, expect, it } from "vite-plus/test";
import { extractTemplates } from "../src/embed.ts";

describe("template extraction", () => {
    it("extracts the tagged templates with the substitutions as same-length placeholders", () => {
        const source = "const s = wgsl`const n = ${count};`;";
        const [template, ...rest] = extractTemplates(source, ["wgsl"]);
        expect(rest).toEqual([]);
        expect(template?.text).toBe("const n = _p______;");
        expect(template?.text.length).toBe(source.slice(template!.start, template!.end).length);
        expect(template?.placeholders).toEqual([10, 18]);
        expect(source.slice(template!.start + 10, template!.start + 18)).toBe("${count}");
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
        const source = "wgsl`a ${f({ x: `}` })} b`";
        const [template] = extractTemplates(source, ["wgsl"]);
        expect(template?.text.startsWith("a _p")).toBe(true);
        expect(template?.text.endsWith(" b")).toBe(true);
    });

    it("finds the templates nested in the substitutions of other templates", () => {
        const source = "html`<p>${wgsl`fn f() {}`}</p>`";
        expect(extractTemplates(source, ["wgsl"]).map(t => t.text)).toEqual(["fn f() {}"]);
    });

    it("supports the custom tags", () => {
        expect(extractTemplates("shader`x`; wgsl`y`", ["shader"]).map(t => t.text)).toEqual(["x"]);
    });
});
