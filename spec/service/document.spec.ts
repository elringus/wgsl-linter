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

    it("suppresses the diagnostics at the placeholders", () => {
        const text = "const x: u32 = _p___;";
        const doc = new Document(text, { placeholders: [15, 20] });
        expect(doc.diagnostics()).toEqual([]);
    });

    it("suppresses the unresolved names when a placeholder may declare them", () => {
        const text = "_p______\nvar<private> l: Light;\nconst x: u32 = -1;";
        const doc = new Document(text, { placeholders: [0, 8] });
        expect(doc.diagnostics().map(d => d.message)).toEqual([
            "value -1 cannot be represented as 'u32'",
        ]);
        expect(doc.uncheckedNames()).toEqual(["Light"]);
        expect(doc.declaringPlaceholders()).toEqual([[0, 8]]);
    });

    it("leaves no names unchecked when they all resolve", () => {
        const text = "_p______\nconst x = 1;";
        const doc = new Document(text, { placeholders: [0, 8] });
        expect(doc.uncheckedNames()).toEqual([]);
    });

    it("keeps the unresolved names when the placeholders are expressions", () => {
        const text = "var<private> l: Light = _p___;";
        const doc = new Document(text, { placeholders: [24, 29] });
        expect(doc.diagnostics().map(d => d.message)).toEqual(["unresolved identifier 'Light'"]);
        expect(doc.declaringPlaceholders()).toEqual([]);
    });
});
