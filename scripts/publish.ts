// Builds the package and publishes it to npm and the VS Code Marketplace.
// Usage: bun run publish; requires `npm login` and `bunx vsce login elringus`.

import { $ } from "bun";

const { version } = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version: string;
};

await $`bun run vsce`;
// Attached to the terminal for npm to prompt for the one-time password;
// ignore-scripts, as otherwise npm reruns this script as hook.
const npm = Bun.spawnSync(["npm", "publish", "--ignore-scripts"], {
    stdio: ["inherit", "inherit", "inherit"],
});
if (npm.exitCode !== 0) process.exit(npm.exitCode);
await $`bunx vsce publish --packagePath dist/wgsl-linter-${version}.vsix`;
