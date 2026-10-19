// Builds the package and publishes it to npm and the VS Code Marketplace.
// Usage: bun run publish.

import { $ } from "bun";

const { version, publisher } = (await Bun.file(
    new URL("../package.json", import.meta.url),
).json()) as { version: string; publisher: string };

// Attached to the terminal for the logins and npm's one-time password prompts.
function run(...command: string[]): number {
    return Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] }).exitCode;
}

function ensure(...command: string[]): void {
    const code = run(...command);
    if (code !== 0) process.exit(code);
}

if (Bun.spawnSync(["npm", "whoami"]).exitCode !== 0) ensure("npm", "login");
if (run("bunx", "vsce", "verify-pat", publisher) !== 0) {
    run("bunx", "vsce", "logout", publisher);
    ensure("bunx", "vsce", "login", publisher);
}
await $`bun run vsce`;
// ignore-scripts, as otherwise npm reruns this script as hook.
ensure("npm", "publish", "--ignore-scripts");
await $`bunx vsce publish --packagePath dist/wgsl-linter-${version}.vsix`;
