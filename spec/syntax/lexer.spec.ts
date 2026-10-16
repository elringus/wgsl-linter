import { describe, expect, it } from "vite-plus/test";
import type { Diagnostic } from "../../src/syntax/diagnostic.ts";
import { lex } from "../../src/syntax/lexer.ts";
import { Tok } from "../../src/syntax/token.ts";

function tokens(text: string): string[] {
    const { kinds, count } = lex(text, []);
    return Array.from(kinds.subarray(0, count - 1), kind => Tok[kind]!);
}

function errors(text: string): string[] {
    const diagnostics: Diagnostic[] = [];
    lex(text, diagnostics);
    return diagnostics.map(d => d.message);
}

describe("template list discovery", () => {
    it("marks the delimiters of nested template lists", () => {
        expect(tokens("array<vec4<f32>, 2>")).toEqual([
            "Ident",
            "TemplateStart",
            "Ident",
            "TemplateStart",
            "Ident",
            "TemplateEnd",
            "Comma",
            "Int",
            "TemplateEnd",
        ]);
    });

    it("splits the closing >> of nested template lists", () => {
        expect(tokens("array<vec2<f32>>").slice(-2)).toEqual(["TemplateEnd", "TemplateEnd"]);
    });

    it("keeps the comparisons that can't close a template list", () => {
        expect(tokens("a < b || c > d")).toEqual([
            "Ident",
            "Less",
            "Ident",
            "OrOr",
            "Ident",
            "Greater",
            "Ident",
        ]);
    });

    it("treats a balanced < > after a name as a template list, as the spec does", () => {
        expect(tokens("a<b>c")).toEqual([
            "Ident",
            "TemplateStart",
            "Ident",
            "TemplateEnd",
            "Ident",
        ]);
    });
});

describe("literals", () => {
    it("tells the number literal kinds by their form and suffix", () => {
        expect(tokens("1 1i 1u 1.5 1.5f 1h 0x1p4 1e3 0x10 .5")).toEqual([
            "Int",
            "IntI",
            "IntU",
            "Float",
            "FloatF",
            "FloatH",
            "Float",
            "Float",
            "Int",
            "Float",
        ]);
    });

    it("lexes keywords and identifiers", () => {
        expect(tokens("fn main let x _ __x")).toEqual([
            "Fn",
            "Ident",
            "Let",
            "Ident",
            "Underscore",
            "Ident",
        ]);
    });
});

describe("comments", () => {
    it("records the line comments and the nested block comments", () => {
        const { comments } = lex("/* a /* b */ c */ x // y", []);
        expect(comments).toEqual([0, 17, 20, 24]);
    });

    it("reports an unterminated block comment", () => {
        expect(errors("/* a")).toEqual(["unterminated block comment"]);
    });

    it("reports the null characters anywhere, including the comments", () => {
        expect(errors("a\u0000b")).toEqual(["null character found"]);
        expect(errors("// \u0000")).toEqual(["null character found"]);
        expect(errors("/* \u0000 */")).toEqual(["null character found"]);
    });

    it("reports the characters that can't start a token", () => {
        expect(errors("a $ b")).toEqual(["invalid character found"]);
    });
});
