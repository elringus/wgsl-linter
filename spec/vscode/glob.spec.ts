import { describe, expect, it } from "vite-plus/test";
import { matches } from "../../src/vscode/glob.ts";

describe("glob", () => {
    it("matches the names within a directory with the single wildcards", () => {
        expect(matches("*.wgsl", "a.wgsl")).toBe(true);
        expect(matches("*.wgsl", "lib/a.wgsl")).toBe(false);
        expect(matches("?.wgsl", "a.wgsl")).toBe(true);
        expect(matches("?.wgsl", "ab.wgsl")).toBe(false);
    });

    it("matches any directories with the double wildcards", () => {
        expect(matches("**/*.wgsl", "a.wgsl")).toBe(true);
        expect(matches("**/*.wgsl", "lib/chunks/a.wgsl")).toBe(true);
        expect(matches("lib/**", "lib/chunks/a.wgsl")).toBe(true);
        expect(matches("lib/**", "src/lib/a.wgsl")).toBe(false);
    });

    it("matches the character classes and their negations within a name", () => {
        expect(matches("shaders/[ab]*.wgsl", "shaders/b1.wgsl")).toBe(true);
        expect(matches("shaders/[ab]*.wgsl", "shaders/c1.wgsl")).toBe(false);
        expect(matches("v[0-9].wgsl", "v7.wgsl")).toBe(true);
        expect(matches("a[!0-9].wgsl", "ax.wgsl")).toBe(true);
        expect(matches("a[!0-9].wgsl", "a1.wgsl")).toBe(false);
        expect(matches("a[!0-9]b", "a/b")).toBe(false);
        expect(matches("a[b.wgsl", "a[b.wgsl")).toBe(true);
        expect(matches("[]].wgsl", "].wgsl")).toBe(true);
        expect(matches("[!-a].wgsl", "0.wgsl")).toBe(true);
        expect(matches("[!-a].wgsl", "-.wgsl")).toBe(false);
        expect(matches("[!a-].wgsl", "-.wgsl")).toBe(false);
    });

    it("matches the alternatives in braces and the other characters literally", () => {
        expect(matches("{lib,vendor}/*.wgsl", "vendor/a.wgsl")).toBe(true);
        expect(matches("{lib,vendor}/*.wgsl", "src/a.wgsl")).toBe(false);
        expect(matches("a.wgsl", "abwgsl")).toBe(false);
        expect(matches("a,b(1).wgsl", "a,b(1).wgsl")).toBe(true);
    });
});
