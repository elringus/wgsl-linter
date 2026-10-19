import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

const dir = mkdtempSync(join(tmpdir(), "wgsl-lint-"));
const cli = join(import.meta.dirname, "../src/cli.ts");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]): { code: number; output: string } {
    const result = spawnSync("bun", [cli, ...args], { cwd: dir, encoding: "utf8" });
    return { code: result.status ?? -1, output: result.stdout.replaceAll("\\", "/") };
}

describe("wgsl-lint", () => {
    writeFileSync(join(dir, "ok.wgsl"), "fn f() -> f32 { return 1.0; }\n");
    writeFileSync(join(dir, "bad.wgsl"), "fn f() -> i32 {\n  let x: f32 = 1;\n  return x;\n}\n");
    writeFileSync(
        join(dir, "shader.ts"),
        "export const s = wgsl`\nfn g() -> f32 { return 1u; }\n`;\n",
    );
    writeFileSync(
        join(dir, "substituted.ts"),
        "export const s = wgsl`${common}\nfn g() -> f32 { return 1u; }`;\n",
    );

    writeFileSync(join(dir, "common.inc"), "struct Light { c: f32 }\n");
    writeFileSync(
        join(dir, "lit.wgsl"),
        "enable f16;\nvar<private> l: Light;\nconst x: u32 = -1;\n",
    );

    it("reports the diagnostics with their positions and fails on errors", () => {
        const { code, output } = run("bad.wgsl");
        expect(code).toBe(1);
        expect(output).toBe(
            "bad.wgsl:3:10: error: return statement type must match its function return type, returned 'f32', expected 'i32'\n1 error(s), 0 warning(s)\n",
        );
    });

    it("succeeds silently without errors", () => {
        expect(run("ok.wgsl")).toEqual({ code: 0, output: "" });
    });

    it("lints the templates of the JS/TS files with the tags", () => {
        const { code, output } = run("--tag", "wgsl", "shader.ts");
        expect(code).toBe(1);
        expect(output).toContain("shader.ts:2:24: error: return statement type must match");
    });

    it("skips the templates with substitutions", () => {
        expect(run("--tag", "wgsl", "substituted.ts")).toEqual({ code: 0, output: "" });
    });

    it("splices the prelude after the directives of the shaders", () => {
        expect(run("--prelude", "common.inc", "lit.wgsl").output).toBe(
            "lit.wgsl:3:16: error: value -1 cannot be represented as 'u32'\n1 error(s), 0 warning(s)\n",
        );
    });

    it("searches the directories", () => {
        const { output } = run("--tag", "wgsl", ".");
        expect(output).toContain("bad.wgsl:3:10");
        expect(output).toContain("shader.ts:2:24");
    });

    it("rejects the unknown options", () => {
        expect(run("--nope").code).toBe(2);
    });
});
