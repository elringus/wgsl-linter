import { defineConfig } from "vite-plus";

const entries = { index: "src/index.ts", vscode: "src/vscode/index.ts", cli: "src/cli.ts" };

export default defineConfig({
    pack: Object.entries(entries).map(([name, source]) => ({
        entry: { [name]: source },
        dts: name === "vscode" && { generator: "oxc" },
        clean: false,
        fixedExtension: false,
        deps: { neverBundle: ["vscode"] },
        banner: "/* eslint-disable */",
    })),
    test: { clearMocks: true, include: ["spec/**/*.spec.ts", "cts/*.spec.ts"] },
    fmt: { arrowParens: "avoid" },
    lint: {
        plugins: ["eslint", "typescript", "unicorn", "oxc", "import"],
        rules: { "import/no-cycle": "error", "unicorn/no-new-array": "off" },
        overrides: [{ files: ["**/*.spec.*"], rules: { "typescript/unbound-method": "off" } }],
        options: { typeAware: true, typeCheck: true },
    },
});
