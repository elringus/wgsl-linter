# WGSL Linter

Full WGSL language support: semantic highlighting, diagnostics, completion, hover, navigation, rename and formatting — both in `.wgsl` files and in WGSL templates embedded in JS/TS sources.

Ships as a VS Code extension, the `wgsl-lint` command-line tool and a dependency-free analyzer library. The analyzer validates shaders the way Chrome does, reporting all the errors at once.

## Features

- Diagnostics: syntax, name resolution, type checking with the abstract numerics and overload resolution, const-evaluation of all the builtins (f16 included), uniformity analysis with the `diagnostic` filters, behavior analysis, memory layout, entry-point IO and resource bindings, address spaces and access modes, alias analysis, `enable` and `requires` directives.
- Hover with the types, values and memory layout; inlay hints with the inferred types; completion of the names in scope, members, swizzles, builtins, attributes and enumerants; signature help.
- Go to definition, references, rename, document symbols, highlights and folding.
- Formatting that keeps the line breaks of the source.
- Semantic highlighting telling the struct constructors from the function calls and the builtins from the user declarations.

All but semantic highlighting also work in the template literals tagged `wgsl` (or the configured tags) in JS/TS sources, as in:

```ts
const shader = wgsl`
    ${common}
    @group(0) @binding(0) var<uniform> light: Light;
    @compute @workgroup_size(${size}) fn main() {}
`;
```

The `${}` substitutions are opaque placeholders: the diagnostics depending on them are suppressed, including the unresolved names when a substitution may declare them. The templates are formatted with the "Format WGSL template" code action, as the document formatting belongs to the TS formatter.

## Command Line

```bash
wgsl-lint [--tag <name>]... [--prelude <file>] <file or directory>...
```

Reports the diagnostics of the `.wgsl` files and, with `--tag`, of the tagged templates in the JS/TS files, as `file:line:column: severity: message`; exits with 1 when there are errors.

## Library

```ts
import { Document, hover, lint } from "wgsl-linter";

const diagnostics = lint(source);
const doc = new Document(source, { prelude });
const info = hover(doc, offset);
```

The positions are UTF-16 offsets. A `Document` analyzes its source lazily in layers (syntax tree, resolution, semantics) and caches them; the features ask for the layers they need.

## VS Code

The extension registers the features in-process with the VS Code API. To embed them in another extension, call `register` from `dist/vscode.js`:

```ts
import { register } from "./wgsl";

export function activate(context: vscode.ExtensionContext) {
    register(context, { tags: ["wgsl", "shader"], prelude: engineDeclarations });
}
```

Options:

- `tags`: tags of the JS/TS template literals holding WGSL; `wgsl` by default.
- `prelude`: WGSL declarations available to all the shaders, such as engine-provided structs and functions.
- `extensions`, `features`: the enable-extensions and language features the target supports; Chrome's by default.

The highlighting comes from the TextMate grammars in `syntaxes`: the hosting extension contributes them along with the `wgsl` language, as in this repository's `package.json`.

## Development

- `bun run lint` lints and formats the sources.
- `bun run test` runs the specs in `spec`; the differential specs compare the analyzer with Tint run by Dawn's node bindings (`scripts/tint.ts`), also on the `.wgsl` files of the `WGSL_CORPUS` directory.
- `bun run build` builds `dist`; `bun run vsce` packages the extension.
- `bun run cts [query...]` runs the WebGPU conformance test suite against the analyzer, fetching the suite into `cts/suite` first. A query is a CTS query of the validation tests, as in `"webgpu:shader,validation,uniformity,*"`, or `accuracy` for checking the const-evaluation against the const cases of the execution tests; without queries, it runs all the WGSL validation tests and the accuracy check.
- `bun scripts/builtins.ts` regenerates `src/semantic/builtins.ts` from Tint's builtin definitions.
