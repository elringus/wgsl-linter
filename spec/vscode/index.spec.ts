import { describe, expect, it, vi } from "vite-plus/test";

/** A minimal model of the VS Code API the adapter uses, capturing the registered providers. */
const vscode = vi.hoisted(() => {
    class Position {
        constructor(
            readonly line: number,
            readonly character: number,
        ) {}
    }
    class Range {
        constructor(
            readonly start: Position,
            readonly end: Position,
        ) {}
    }
    class Plain {
        constructor(...args: unknown[]) {
            Object.assign(this, { args });
        }
    }
    class MarkdownString {
        value = "";
        appendCodeblock(code: string, language: string): this {
            this.value += `\`\`\`${language}\n${code}\n\`\`\``;
            return this;
        }
        appendMarkdown(text: string): this {
            this.value += text;
            return this;
        }
    }
    class WorkspaceEdit {
        readonly edits: [Range, string][] = [];
        replace(_: unknown, range: Range, text: string): void {
            this.edits.push([range, text]);
        }
    }
    class SemanticTokensBuilder {
        readonly data: number[] = [];
        push(...values: number[]): void {
            this.data.push(...values);
        }
        build(): { data: number[] } {
            return { data: this.data };
        }
    }
    const providers = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
    const diagnostics = new Map<string, unknown[]>();
    const register =
        (name: string) =>
        (_: unknown, provider: Record<string, (...args: unknown[]) => unknown>) => {
            providers.set(name, provider);
            return { dispose() {} };
        };
    const event = () => ({ dispose() {} });
    return {
        providers,
        diagnostics,
        Position,
        Range,
        MarkdownString,
        WorkspaceEdit,
        SemanticTokensBuilder,
        Location: Plain,
        Diagnostic: class extends Plain {
            source?: string;
            relatedInformation?: unknown[];
        },
        DiagnosticRelatedInformation: Plain,
        Hover: class {
            constructor(
                readonly contents: MarkdownString,
                readonly range: Range,
            ) {}
        },
        InlayHint: class {
            constructor(
                readonly position: Position,
                readonly label: string,
            ) {}
        },
        CompletionItem: class {
            detail?: string;
            range?: Range;
            constructor(readonly label: string) {}
        },
        SignatureHelp: class {
            signatures: { label: string }[] = [];
            activeSignature = 0;
            activeParameter = 0;
        },
        SignatureInformation: class {
            parameters: unknown[] = [];
            constructor(readonly label: string) {}
        },
        ParameterInformation: Plain,
        DocumentHighlight: class {
            constructor(readonly range: Range) {}
        },
        DocumentSymbol: class {
            children: unknown[] = [];
            constructor(readonly name: string) {}
        },
        FoldingRange: class {
            constructor(
                readonly start: number,
                readonly end: number,
            ) {}
        },
        TextEdit: { replace: (range: Range, text: string) => ({ range, text }) },
        CodeAction: class {
            edit?: WorkspaceEdit;
            constructor(readonly title: string) {}
        },
        CodeActionKind: { RefactorRewrite: "refactor.rewrite" },
        SemanticTokensLegend: Plain,
        Disposable: { from: () => ({ dispose() {} }) },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
        InlayHintKind: { Type: 1 },
        CompletionItemKind: new Proxy({}, { get: () => 0 }),
        SymbolKind: new Proxy({}, { get: () => 0 }),
        FoldingRangeKind: { Comment: 1 },
        languages: {
            createDiagnosticCollection: () => ({
                set: (uri: { toString(): string }, list: unknown[]) =>
                    diagnostics.set(uri.toString(), list),
                delete: () => {},
                dispose() {},
            }),
            match: (_: unknown, doc: { languageId: string }) =>
                ["wgsl", "typescript"].includes(doc.languageId) ? 10 : 0,
            registerDocumentSemanticTokensProvider: register("tokens"),
            registerHoverProvider: register("hover"),
            registerInlayHintsProvider: register("hints"),
            registerCompletionItemProvider: register("completion"),
            registerSignatureHelpProvider: register("signature"),
            registerDefinitionProvider: register("definition"),
            registerReferenceProvider: register("references"),
            registerDocumentHighlightProvider: register("highlights"),
            registerRenameProvider: register("rename"),
            registerDocumentSymbolProvider: register("symbols"),
            registerFoldingRangeProvider: register("folding"),
            registerDocumentFormattingEditProvider: register("format"),
            registerCodeActionsProvider: register("actions"),
        },
        workspace: {
            textDocuments: [] as unknown[],
            onDidOpenTextDocument: event,
            onDidChangeTextDocument: event,
            onDidCloseTextDocument: event,
        },
        window: { activeTextEditor: undefined },
    };
});

vi.mock("vscode", () => vscode);

const { register } = await import("../../src/vscode/index.ts");

/** A text document of the VS Code API over the text. */
function document(text: string, languageId: string, uri = `file:///${languageId}`) {
    const lines = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") lines.push(i + 1);
    return {
        uri: { toString: () => uri },
        languageId,
        version: 1,
        getText: () => text,
        offsetAt: (p: { line: number; character: number }) => lines[p.line]! + p.character,
        positionAt: (offset: number) => {
            let line = lines.length - 1;
            while (lines[line]! > offset) line--;
            return new vscode.Position(line, offset - lines[line]!);
        },
    };
}

const shader =
    "struct Light { color: vec3f }\nvar<private> light: Light;\nfn f() -> f32 { return light.color.x; }\n";
const wgsl = document(shader, "wgsl");
const script = document(
    `const n = 4;\nexport const s = wgsl\`\n\${common}\nfn g() -> u32 { let k = 1u; return k; }\n\`;\n`,
    "typescript",
);
vscode.workspace.textDocuments.push(wgsl, script);
register({ subscriptions: [] } as never, { prelude: "struct Common { a: f32 }" });

const call = (provider: string, method: string, ...args: unknown[]) =>
    vscode.providers.get(provider)![method]!(...args) as never;

describe("vscode adapter", () => {
    it("publishes the diagnostics of the documents", () => {
        expect(vscode.diagnostics.get("file:///wgsl")).toEqual([]);
        expect(vscode.diagnostics.get("file:///typescript")).toEqual([]);
    });

    it("hovers the names in the wgsl documents and the templates", () => {
        const hover = call("hover", "provideHover", wgsl, new vscode.Position(1, 15)) as {
            contents: { value: string };
        };
        expect(hover.contents.value).toBe("```wgsl\nvar<private> light: Light\n```");
        const inTemplate = call("hover", "provideHover", script, new vscode.Position(3, 36)) as {
            contents: { value: string };
        };
        expect(inTemplate.contents.value).toBe("```wgsl\nlet k: u32\n```");
        expect(call("hover", "provideHover", script, new vscode.Position(0, 7))).toBeUndefined();
    });

    it("shows the layout of the types in buffers under the code", () => {
        const doc = document(
            "struct L { c: vec3f }\n@group(0) @binding(0) var<uniform> u: L;\n",
            "wgsl",
            "file:///uniform",
        );
        const hover = call("hover", "provideHover", doc, new vscode.Position(0, 7)) as {
            contents: { value: string };
        };
        expect(hover.contents.value).toBe(
            "```wgsl\nstruct L {\n    c: vec3<f32>,\n}\n```\n\n---\n\n**Size** 16 · **Align** 16",
        );
        const member = call("hover", "provideHover", doc, new vscode.Position(0, 11)) as {
            contents: { value: string };
        };
        expect(member.contents.value).toContain("**Offset** 0 · **Size** 12 · **Align** 16");
    });

    it("maps the definitions back to the host document", () => {
        const location = call(
            "definition",
            "provideDefinition",
            wgsl,
            new vscode.Position(2, 26),
        ) as {
            args: [unknown, { start: { line: number; character: number } }];
        };
        expect(location.args[1].start).toEqual(new vscode.Position(1, 13));
    });

    it("renames within the template, falling through to TS outside of it", () => {
        const edit = call(
            "rename",
            "provideRenameEdits",
            script,
            new vscode.Position(3, 36),
            "m",
        ) as {
            edits: [unknown, string][];
        };
        expect(edit.edits.map(e => e[1])).toEqual(["m", "m"]);
        expect(call("rename", "prepareRename", script, new vscode.Position(0, 7))).toBeUndefined();
    });

    it("provides the semantic tokens, symbols, folding and formatting of the wgsl documents", () => {
        const tokens = call("tokens", "provideDocumentSemanticTokens", wgsl) as { data: number[] };
        expect(tokens.data.length % 5).toBe(0);
        expect(tokens.data.length).toBeGreaterThan(0);
        const symbols = call("symbols", "provideDocumentSymbols", wgsl) as { name: string }[];
        expect(symbols.map(s => s.name)).toEqual(["Light", "light", "f"]);
        expect(call("folding", "provideFoldingRanges", wgsl)).toEqual([]);
        expect(
            call("format", "provideDocumentFormattingEdits", wgsl, {
                insertSpaces: true,
                tabSize: 4,
            }),
        ).toEqual([]);
    });

    it("completes the struct members and offers formatting of the templates", () => {
        const items = call(
            "completion",
            "provideCompletionItems",
            wgsl,
            new vscode.Position(2, 31),
        ) as {
            label: string;
        }[];
        expect(items.map(i => i.label)).toEqual(["color"]);
        const actions = call(
            "actions",
            "provideCodeActions",
            script,
            new vscode.Range(new vscode.Position(3, 0), new vscode.Position(3, 0)),
        ) as {
            title: string;
        }[];
        expect(actions.map(a => a.title)).toEqual(["Format WGSL template"]);
    });
});
