import { defineConfig } from "vite-plus";

export default defineConfig({
    pack: [
        {
            entry: { index: "src/index.ts", vscode: "src/vscode/index.ts", cli: "src/cli.ts" },
            dts: { generator: "oxc" },
            fixedExtension: false,
            deps: { neverBundle: ["vscode"] },
        },
        {
            entry: { vscode: "src/vscode/index.ts" },
            format: "cjs",
            clean: false,
            deps: { neverBundle: ["vscode"] },
        },
    ],
    test: { clearMocks: true, include: ["spec/**/*.spec.ts", "cts/*.spec.ts"] },
    fmt: { arrowParens: "avoid" },
    lint: {
        plugins: ["eslint", "typescript", "unicorn", "oxc", "import"],
        rules: { "import/no-cycle": "error", "unicorn/no-new-array": "off" },
        overrides: [{ files: ["**/*.spec.*"], rules: { "typescript/unbound-method": "off" } }],
        options: { typeAware: true, typeCheck: true },
    },
});
