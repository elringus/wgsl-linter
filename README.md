<p align="center"><img src="assets/logo-mark.png" width="128" alt="WGSL Linter"></p>
<br/>
<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Elringus.wgsl-linter"><img src="https://vsmarketplacebadges.dev/version/Elringus.wgsl-linter.svg?label=vscode" alt="vscode"></a>
  <a href="https://www.npmjs.com/package/wgsl-linter"><img src="https://img.shields.io/npm/v/wgsl-linter" alt="npm"></a>
  <a href="https://codefactor.io/repository/github/elringus/wgsl-linter/overview/main"><img src="https://codefactor.io/repository/github/elringus/wgsl-linter/badge/main" alt="codefactor"></a>
  <a href="https://github.com/elringus/wgsl-linter/actions/workflows/codeql.yml"><img src="https://github.com/elringus/wgsl-linter/actions/workflows/codeql.yml/badge.svg" alt="codeql"></a>
</p>
<br/>

# WGSL Linter

WGSL language support for `.wgsl` files and WGSL templates embedded in JS/TS: a VS Code extension, the `wgsl-lint` command-line tool and a dependency-free analyzer library. Shaders are validated the way Chrome does, with all the errors reported at once.

## Features

- Diagnostics including const-evaluation, uniformity analysis, memory layout and entry-point IO.
- Hover with types, values, memory layout and spec descriptions of the builtins.
- Completion of names in scope, members, swizzles, builtins, attributes and enumerants, with signature help.
- Inlay hints with the inferred types.
- Go to definition, references, rename, symbols, highlights and folding.
- Formatting that keeps the source's line breaks.
- Semantic highlighting.

All but semantic highlighting also work in JS/TS template literals tagged `wgsl`:

```ts
const shader = wgsl`
    ${common}
    @compute @workgroup_size(${size}) fn main() {}
`;
```

Diagnostics depending on the `${}` substitutions are suppressed. Templates are formatted with the "Format WGSL template" code action.

## Command Line

```bash
wgsl-lint [--tag <name>]... [--prelude <file>] <file or directory>...
```

Reports the diagnostics of the `.wgsl` files and, with `--tag`, of the tagged templates in JS/TS files; exits with 1 on errors.

## Library

```ts
import { Document, hover, lint } from "wgsl-linter";

const diagnostics = lint(source);
const info = hover(new Document(source), offset);
```

Positions are UTF-16 offsets.

## Embedding in VS Code Extensions

```ts
import { register } from "wgsl-linter/vscode";

export function activate(context: vscode.ExtensionContext) {
    register(context, { tags: ["wgsl", "shader"], prelude: engineDeclarations });
}
```

- `tags`: tags of the template literals holding WGSL; `wgsl` by default.
- `prelude`: WGSL declarations available to all the shaders, such as engine-provided structs.
- `extensions`, `features`: the enable-extensions and language features the target supports; Chrome's by default.

For highlighting, contribute the `wgsl` language with the configuration and grammars in `syntaxes`, as this repository's `package.json` does.

## Development

- `bun run lint`, `bun run test`, `bun run build`; `bun run vsce` packages the extension.
- `bun run publish` publishes the package to npm and the extension to the VS Code Marketplace.
- `bun run cts [query...]` runs the WebGPU conformance tests against the analyzer.
- `bun scripts/builtins.ts` and `bun scripts/docs.ts` regenerate the builtin tables from Tint and the hover descriptions from the spec.
