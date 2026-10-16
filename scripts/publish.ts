// Builds the package and publishes it to npm and the VS Code Marketplace.
// Usage: bun run publish; requires `npm login` and `bunx vsce login elringus`.

import { $ } from "bun";

const { version } = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version: string;
};

await $`bun run vsce`;
await $`npm publish --ignore-scripts`; // ignore-scripts, as otherwise npm reruns this script as hook
await $`bunx vsce publish --packagePath dist/wgsl-linter-${version}.vsix`;
