import { describe, expect, it } from "vite-plus/test";
import { Document } from "../../src/service/document.ts";

describe("document", () => {
    it("analyzes the layers lazily and caches them", () => {
        const doc = new Document("const x = 1;");
        expect(doc.tree).toBe(doc.tree);
        expect(doc.resolution).toBe(doc.resolution);
        expect(doc.semantics).toBe(doc.semantics);
    });

    it("splices the prelude after the directives, mapping the offsets to the text", () => {
        const text = "enable f16;\nvar<private> l: Light;\nconst x: u32 = -1;";
        const doc = new Document(text, { prelude: "struct Light { c: f16 }\nconst y: u32 = -1;" });
        const [error, ...rest] = doc.diagnostics();
        expect(rest).toEqual([]);
        expect(doc.textOffset(error!.start)).toBe(text.indexOf("-1"));
        expect(doc.sourceOffset(text.indexOf("Light"))).toBe(doc.source.indexOf("Light;"));
        const light = doc.source.indexOf("Light");
        expect(doc.inPrelude(light, light + 5)).toBe(true);
    });

    it("finds the directives past the comments, in linear time", () => {
        const prelude = "struct Light { c: f16 }";
        const lit = (head: string) =>
            new Document(`${head}\nvar<private> l: Light;`, { prelude }).diagnostics();
        expect(lit("enable /* ; */ f16;")).toEqual([]);
        expect(lit("/* outer /* inner */ requires x; */ enable f16;")).toEqual([]);
        expect(lit(`${"/* comment */\n".repeat(64)}enable f16;`)).toEqual([]);
        const text = "diagnostic(off, chromium.unreachable_code);\nconst x = 2;";
        const doc = new Document(text, { prelude: "const x = 1;" });
        expect(doc.diagnostics().map(d => [doc.textOffset(d.start), d.message])).toEqual([
            [text.indexOf("x"), "redeclaration of 'x'"],
        ]);
    });

    it("keeps the error of an unterminated directive where the text reports it", () => {
        const error = (text: string) => {
            const doc = new Document(text, { prelude: "alias P = f32;" });
            return doc.diagnostics().map(d => [doc.textOffset(d.start), d.message]);
        };
        expect(error("enable f16")).toEqual([[10, "expected ';'"]]);
        expect(error("enable f16\nfn f() -> P { return P(); }")).toEqual([[11, "expected ';'"]]);
    });

    it("takes the validation level from the text's leading comment despite the prelude", () => {
        const doc = new Document("// wgsl: off\nconst x: u32 = -1;", { prelude: "const y = 1;" });
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
