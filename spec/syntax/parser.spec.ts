import { describe, expect, it } from "vite-plus/test";
import { parse } from "../../src/syntax/parser.ts";
import { Node, type Tree } from "../../src/syntax/tree.ts";

/** Returns the subtree as nested arrays of the node kinds, for comparing the structure. */
function shape(tree: Tree, node = 0): unknown {
    const children: unknown[] = [];
    for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!)
        children.push(shape(tree, child));
    const kind = Node[tree.kinds[node]!]!;
    return children.length > 0 ? [kind, ...children] : kind;
}

function errors(text: string): string[] {
    return parse(text).diagnostics.map(d => d.message);
}

describe("declarations", () => {
    it("parses a function with attributes, parameters and a result", () => {
        const tree = parse(
            "@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f { return vec4f(uv, 0, 1); }",
        );
        expect(tree.diagnostics).toEqual([]);
        expect(shape(tree)).toEqual([
            "Module",
            [
                "Function",
                "Attribute",
                "Name",
                ["Param", ["Attribute", "Literal"], "Name", ["Type", "Ident"]],
                ["Result", ["Attribute", "Literal"], "Ident"],
                ["Block", ["Return", ["Call", "Ident", "Ident", "Literal", "Literal"]]],
            ],
        ]);
    });

    it("parses a module-scope var with a template list", () => {
        const tree = parse("@group(0) @binding(1) var<storage, read_write> data: array<u32>;");
        expect(tree.diagnostics).toEqual([]);
        expect(shape(tree)).toEqual([
            "Module",
            [
                "Var",
                ["Attribute", "Literal"],
                ["Attribute", "Literal"],
                ["Template", "Ident", "Ident"],
                "Name",
                ["Type", ["Ident", "Ident"]],
            ],
        ]);
    });

    it("parses the structures, aliases, constants and directives", () => {
        const tree = parse(
            "enable f16; diagnostic(off, derivative_uniformity); struct S { a: f32, @size(16) b: u32 } alias A = S; const c = 1; override o: u32; const_assert c > 0;",
        );
        expect(tree.diagnostics).toEqual([]);
        expect((shape(tree) as unknown[]).slice(1).map(s => (Array.isArray(s) ? s[0] : s))).toEqual(
            ["Enable", "Directive", "Struct", "Alias", "Const", "Override", "ConstAssert"],
        );
    });
});

describe("statements", () => {
    it("parses a loop with a continuing block ending with break-if", () => {
        const tree = parse("fn f() { var i = 0; loop { i++; continuing { break if i > 3; } } }");
        expect(tree.diagnostics).toEqual([]);
        const block = (shape(tree) as unknown[][])[1]![2] as unknown[];
        expect(block[2]).toEqual([
            "Loop",
            [
                "Block",
                ["IncDec", "Ident"],
                ["Continuing", ["Block", ["BreakIf", ["Binary", "Ident", "Literal"]]]],
            ],
        ]);
    });

    it("parses the for-loop header with absent clauses as empty nodes", () => {
        const tree = parse("fn f() { for (;;) { break; } }");
        expect(tree.diagnostics).toEqual([]);
        const block = (shape(tree) as unknown[][])[1]![2] as unknown[];
        expect(block[1]).toEqual(["For", "Empty", "Empty", "Empty", ["Block", "Break"]]);
    });

    it("parses the switch with case selectors and the default", () => {
        const tree = parse("fn f(x: i32) { switch x { case 1, 2: {} default: {} } }");
        expect(tree.diagnostics).toEqual([]);
    });
});

describe("expressions", () => {
    it("respects the operator precedence", () => {
        const tree = parse("const x = 1 + 2 * -3;");
        expect((shape(tree) as unknown[][])[1]![2]).toEqual([
            "Binary",
            "Literal",
            ["Binary", "Literal", ["Unary", "Literal"]],
        ]);
    });

    it("rejects the mixing of operators the grammar doesn't relate", () => {
        expect(errors("const x = 1 & 2 | 3;")).not.toEqual([]);
        expect(errors("const x = a < b < c;")).not.toEqual([]);
    });

    it("parses the postfix accessors", () => {
        const tree = parse("const x = a.b[0].c;");
        expect((shape(tree) as unknown[][])[1]![2]).toEqual([
            "Member",
            ["Index", ["Member", "Ident"], "Literal"],
        ]);
    });
});

describe("error recovery", () => {
    it("reports a missing expression and continues with the next statement", () => {
        const tree = parse("fn f() { let x = ; let y = 1; }");
        expect(tree.diagnostics.map(d => d.message)).toEqual(["expected expression"]);
        const block = (shape(tree) as unknown[][])[1]![2] as unknown[];
        expect(block.length).toBe(3);
    });

    it("recovers at the next declaration after a malformed one", () => {
        const tree = parse("fn f( { } struct S { a: f32 }");
        expect(tree.diagnostics.length).toBeGreaterThan(0);
        expect((shape(tree) as unknown[]).some(s => Array.isArray(s) && s[0] === "Struct")).toBe(
            true,
        );
    });

    it("reports an empty template list", () => {
        expect(errors("alias T = buffer<>;")).toEqual(["expected expression"]);
    });
});
