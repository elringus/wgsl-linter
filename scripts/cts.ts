/// <reference types="bun" />
// Runs the WebGPU conformance test suite against the analyzer.
// Usage: bun scripts/cts.ts [query...]; a query is a CTS query of the validation tests, or
// `accuracy` for checking the const-evaluation against the const cases of the execution tests;
// defaults to all the WGSL validation tests and the accuracy check.
// The suite is fetched into cts/suite at the pinned commit on the first run.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const commit = "e325d0bcc2cb785c4eab1d908339019215bd9462";
const root = fileURLToPath(new URL("..", import.meta.url));
const suite = fileURLToPath(new URL("../cts/suite", import.meta.url));
const provider = fileURLToPath(new URL("../cts/gpu.ts", import.meta.url));

await fetchSuite();
const args = process.argv.slice(2);
const queries = args.length > 0 ? args : ["webgpu:shader,validation,*", "accuracy"];
const validation = queries.filter(query => query !== "accuracy");
let failed = false;
if (validation.length > 0) {
    const cmdline = ["bun", "src/common/runtime/cmdline.ts", "--gpu-provider", provider];
    failed = (await run([...cmdline, ...validation], suite)) !== 0;
}
if (queries.includes("accuracy"))
    failed = (await run(["bun", "run", "test", "cts/accuracy.spec.ts"], root)) !== 0 || failed;
process.exitCode = failed ? 1 : 0;

async function run(cmd: string[], cwd: string): Promise<number> {
    const env = { ...process.env, CTS: "1" };
    return Bun.spawn(cmd, { cwd, env, stdout: "inherit", stderr: "inherit" }).exited;
}

async function fetchSuite(): Promise<void> {
    if (existsSync(`${suite}/src/common/runtime/cmdline.ts`)) return;
    const git = async (...args: string[]): Promise<void> => {
        const code = await Bun.spawn(["git", ...args], {
            cwd: suite,
            stdout: "ignore",
            stderr: "inherit",
        }).exited;
        if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
    };
    await Bun.$`mkdir -p ${suite}`;
    await git("init", "--quiet");
    await git("remote", "add", "origin", "https://github.com/gpuweb/cts.git");
    await git("fetch", "--depth", "1", "origin", commit);
    await git("checkout", "--quiet", "FETCH_HEAD");
}
