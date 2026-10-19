import { describe, expect, it } from "vite-plus/test";
import { Document } from "../../src/service/document.ts";

describe("document", () => {
    it("analyzes the layers lazily and caches them", () => {
        const doc = new Document("const x = 1;");
        expect(doc.tree).toBe(doc.tree);
        expect(doc.resolution).toBe(doc.resolution);
        expect(doc.semantics).toBe(doc.semantics);
    });

    it("makes the prelude declarations available to the text, offsetting it", () => {
        const doc = new Document("var<private> l: Light;", {
            prelude: "struct Light { color: vec3f }",
        });
        expect(doc.base).toBe("struct Light { color: vec3f }\n".length);
        expect(doc.diagnostics()).toEqual([]);
    });

    it("excludes the diagnostics of the prelude", () => {
        const doc = new Document("const x = 1;", { prelude: "const y: u32 = -1;" });
        expect(doc.diagnostics()).toEqual([]);
    });

    it("skips the diagnostics of the names declared elsewhere in the partial documents", () => {
        const text =
            "var<private> l: Light;\nfn f() -> f32 { return l.color.x * scale(); }\nconst x: u32 = -1;";
        const messages = (validate: "full" | "partial" | "off") =>
            new Document(text, { validate }).diagnostics().map(d => d.message);
        expect(messages("full")).toEqual([
            "unresolved identifier 'Light'",
            "unresolved identifier 'scale'",
            "value -1 cannot be represented as 'u32'",
        ]);
        expect(messages("partial")).toEqual(["value -1 cannot be represented as 'u32'"]);
        expect(messages("off")).toEqual([]);
    });

    it("takes the validation level from a leading comment over the option", () => {
        const text = "var<private> l: Light;\nconst x: u32 = -1;";
        const count = (head: string) =>
            new Document(head + text, { validate: "full" }).diagnostics().length;
        expect(count("// wgsl: partial\n")).toBe(1);
        expect(count("// license\n\n/* wgsl: off */\n")).toBe(0);
        expect(count("const c = 1;\n// wgsl: off\n")).toBe(2);
        expect(count("// wgsl: unknown\n")).toBe(2);
    });
});
