import { describe, expect, it } from "vite-plus/test";
import { resolve } from "../../src/semantic/resolve.ts";
import { parse } from "../../src/syntax/parser.ts";
import { nameOf, Node, tokenText } from "../../src/syntax/tree.ts";

/** Returns the names of the declarations the identifiers refer to, in source order. */
function references(code: string): string[] {
    const { tree, refs } = resolve(parse(code));
    const out: string[] = [];
    for (let node = 1; node < tree.count; node++)
        if (tree.kinds[node] === Node.Ident) {
            const decl = refs[node]!;
            const kind = decl ? Node[tree.kinds[decl]!] : "predeclared";
            out.push(`${tokenText(tree, node)}->${kind}${decl ? `:${nameOf(tree, decl)}` : ""}`);
        }
    return out;
}

describe("name resolution", () => {
    it("resolves the module-scope names regardless of the declaration order", () => {
        expect(
            references("fn f() -> S { return S(c); } struct S { a: f32 } const c = 1.0;"),
        ).toEqual(["S->Struct:S", "S->Struct:S", "c->Const:c", "f32->predeclared"]);
    });

    it("resolves the function-scope names lexically, with shadowing", () => {
        expect(
            references("const x = 1; fn f(x: i32) { let a = x; { let x = 2; let b = x; } }"),
        ).toEqual(["i32->predeclared", "x->Param:x", "x->Let:x"]);
    });

    it("doesn't let a declaration refer to itself in its initializer", () => {
        expect(references("const x = 1; fn f() { let x = x; }")).toEqual(["x->Const:x"]);
    });

    it("orders the module-scope declarations by their dependencies", () => {
        const { tree, order } = resolve(parse("const b = a + 1; const a = 1; fn f() { _ = b; }"));
        expect(order.map(decl => nameOf(tree, decl))).toEqual(["a", "b", "f"]);
    });

    it("reports the redeclarations", () => {
        expect(resolve(parse("const a = 1; const a = 2;")).diagnostics.map(d => d.message)).toEqual(
            ["redeclaration of 'a'"],
        );
    });
});
