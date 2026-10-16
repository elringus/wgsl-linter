import * as vscode from "vscode";
import { type Template, extractTemplates } from "../embed.ts";
import type { Options as AnalyzerOptions } from "../semantic/check.ts";
import { completion, CompletionKind } from "../service/completion.ts";
import type { Layout } from "../service/describe.ts";
import { Document } from "../service/document.ts";
import { format } from "../service/format.ts";
import { inlayHints } from "../service/hints.ts";
import { hover } from "../service/hover.ts";
import {
    definition,
    isValidName,
    prepareRename,
    type Range,
    references,
    rename,
} from "../service/navigation.ts";
import { signatureHelp } from "../service/signature.ts";
import {
    documentSymbols,
    type DocumentSymbol,
    foldingRanges,
    SymbolKind,
} from "../service/symbols.ts";
import { semanticTokens, tokenModifiers, tokenTypes } from "../service/tokens.ts";
import type { Severity } from "../syntax/diagnostic.ts";

/** Options of the WGSL language features. */
export interface Options extends AnalyzerOptions {
    /** Tags of the JS/TS template literals holding WGSL, as in wgsl`...`; `wgsl` by default. */
    readonly tags?: readonly string[];
    /**
     * WGSL declarations available to all the shaders, such as the structs and functions an
     * engine provides; analyzed as if prepended to each shader.
     */
    readonly prelude?: string;
}

const wgsl: vscode.DocumentSelector = { language: "wgsl" };
const scripts: vscode.DocumentSelector = [
    { language: "javascript" },
    { language: "typescript" },
    { language: "javascriptreact" },
    { language: "typescriptreact" },
];
const all: vscode.DocumentSelector = [wgsl, ...(scripts as vscode.DocumentFilter[])];

/**
 * A WGSL source within a VS Code document: a whole `.wgsl` document or a template literal;
 * the offsets of the document in the host are the analyzed offsets plus the shift.
 */
interface Region {
    readonly doc: Document;
    readonly shift: number;
    /** Range of the region in the host document. */
    readonly start: number;
    readonly end: number;
    readonly template?: Template;
}

/**
 * Registers the WGSL language features: for the `.wgsl` documents and the WGSL templates
 * embedded in the JS/TS documents.
 */
export function register(
    context: vscode.ExtensionContext,
    options: Options = {},
): vscode.Disposable {
    const features = new Features(options);
    const disposable = vscode.Disposable.from(...features.register());
    context.subscriptions.push(disposable);
    return disposable;
}

export { register as activate };

class Features {
    private readonly tags: readonly string[];
    private readonly cache = new Map<string, { version: number; regions: Region[] }>();
    private readonly diagnostics = vscode.languages.createDiagnosticCollection("wgsl");

    constructor(private readonly options: Options) {
        this.tags = options.tags ?? ["wgsl"];
    }

    register(): vscode.Disposable[] {
        const { languages, workspace } = vscode;
        const legend = new vscode.SemanticTokensLegend([...tokenTypes], [...tokenModifiers]);
        for (const document of workspace.textDocuments) this.lint(document);
        return [
            this.diagnostics,
            workspace.onDidOpenTextDocument(document => this.lint(document)),
            workspace.onDidChangeTextDocument(event => this.lint(event.document)),
            workspace.onDidCloseTextDocument(document => {
                this.cache.delete(document.uri.toString());
                this.diagnostics.delete(document.uri);
            }),
            languages.registerDocumentSemanticTokensProvider(
                wgsl,
                { provideDocumentSemanticTokens: d => this.semanticTokens(d, legend) },
                legend,
            ),
            languages.registerHoverProvider(all, { provideHover: (d, p) => this.hover(d, p) }),
            languages.registerInlayHintsProvider(all, {
                provideInlayHints: (d, r) => this.inlayHints(d, r),
            }),
            languages.registerCompletionItemProvider(
                all,
                { provideCompletionItems: (d, p) => this.completion(d, p) },
                ".",
                "@",
                "<",
                ":",
            ),
            languages.registerSignatureHelpProvider(
                all,
                { provideSignatureHelp: (d, p) => this.signatureHelp(d, p) },
                "(",
                ",",
            ),
            languages.registerDefinitionProvider(all, {
                provideDefinition: (d, p) => this.definition(d, p),
            }),
            languages.registerReferenceProvider(all, {
                provideReferences: (d, p, c) => this.references(d, p, c.includeDeclaration),
            }),
            languages.registerDocumentHighlightProvider(all, {
                provideDocumentHighlights: (d, p) => this.highlights(d, p),
            }),
            languages.registerRenameProvider(all, {
                prepareRename: (d, p) => this.prepareRename(d, p),
                provideRenameEdits: (d, p, name) => this.rename(d, p, name),
            }),
            languages.registerDocumentSymbolProvider(all, {
                provideDocumentSymbols: d => this.symbols(d),
            }),
            languages.registerFoldingRangeProvider(all, {
                provideFoldingRanges: d => this.folding(d),
            }),
            languages.registerDocumentFormattingEditProvider(wgsl, {
                provideDocumentFormattingEdits: (d, o) => this.format(d, o),
            }),
            languages.registerCodeActionsProvider(
                scripts,
                { provideCodeActions: (d, r) => this.formatTemplateAction(d, r) },
                { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
            ),
        ];
    }

    // ---- regions ----

    private regions(document: vscode.TextDocument): Region[] {
        const key = document.uri.toString();
        const cached = this.cache.get(key);
        if (cached?.version === document.version) return cached.regions;
        const text = document.getText();
        const { prelude, extensions, features } = this.options;
        let regions: Region[];
        if (document.languageId === "wgsl") {
            const doc = new Document(text, { prelude, extensions, features });
            regions = [{ doc, shift: -doc.base, start: 0, end: text.length }];
        } else
            regions = extractTemplates(text, this.tags).map(template => {
                const { placeholders } = template;
                const doc = new Document(template.text, {
                    prelude,
                    extensions,
                    features,
                    placeholders,
                });
                const shift = template.start - doc.base;
                return { doc, shift, start: template.start, end: template.end, template };
            });
        this.cache.set(key, { version: document.version, regions });
        return regions;
    }

    /** Returns the region at the position and the analyzed offset of the position. */
    private at(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): [Region, number] | undefined {
        const offset = document.offsetAt(position);
        const region = this.regions(document).find(r => r.start <= offset && offset <= r.end);
        return region && [region, offset - region.shift];
    }

    private isRelevant(document: vscode.TextDocument): boolean {
        return vscode.languages.match(all, document) > 0;
    }

    /** Converts the analyzed range to the host document's range, unless it's in the prelude. */
    private range(
        document: vscode.TextDocument,
        region: Region,
        range: Range,
    ): vscode.Range | undefined {
        if (range.start < region.doc.base) return undefined;
        return new vscode.Range(
            document.positionAt(range.start + region.shift),
            document.positionAt(range.end + region.shift),
        );
    }

    // ---- features ----

    private lint(document: vscode.TextDocument): void {
        if (!this.isRelevant(document)) return;
        const diagnostics: vscode.Diagnostic[] = [];
        for (const region of this.regions(document))
            for (const d of region.doc.diagnostics()) {
                const range = this.range(document, region, d)!;
                const diagnostic = new vscode.Diagnostic(range, d.message, severity(d.severity));
                diagnostic.source = "wgsl";
                diagnostic.relatedInformation = d.notes?.flatMap(note => {
                    const at = this.range(document, region, note);
                    return at
                        ? [
                              new vscode.DiagnosticRelatedInformation(
                                  new vscode.Location(document.uri, at),
                                  note.message,
                              ),
                          ]
                        : [];
                });
                diagnostics.push(diagnostic);
            }
        this.diagnostics.set(document.uri, diagnostics);
    }

    private semanticTokens(
        document: vscode.TextDocument,
        legend: vscode.SemanticTokensLegend,
    ): vscode.SemanticTokens {
        const builder = new vscode.SemanticTokensBuilder(legend);
        const [region] = this.regions(document);
        const data = semanticTokens(region!.doc);
        for (let i = 0; i < data.length; i += 4) {
            const position = document.positionAt(data[i]! + region!.shift);
            builder.push(
                position.line,
                position.character,
                data[i + 1]!,
                data[i + 2]!,
                data[i + 3]!,
            );
        }
        return builder.build();
    }

    private hover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Hover | undefined {
        const at = this.at(document, position);
        const result = at && hover(at[0].doc, at[1]);
        if (!result) return undefined;
        const contents = new vscode.MarkdownString().appendCodeblock(result.code, "wgsl");
        const sections: string[] = [];
        if (result.documentation) sections.push(result.documentation);
        if (result.layout) sections.push(layoutLine(result.layout));
        if (result.link) sections.push(`[Specification](${result.link})`);
        if (sections.length > 0) contents.appendMarkdown(`\n\n---\n\n${sections.join("\n\n")}`);
        return new vscode.Hover(contents, this.range(document, at[0], result));
    }

    private inlayHints(document: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
        const start = document.offsetAt(range.start);
        const end = document.offsetAt(range.end);
        const hints: vscode.InlayHint[] = [];
        for (const region of this.regions(document)) {
            if (region.end < start || region.start > end) continue;
            for (const hint of inlayHints(region.doc, start - region.shift, end - region.shift)) {
                const position = document.positionAt(hint.offset + region.shift);
                hints.push(new vscode.InlayHint(position, hint.label, vscode.InlayHintKind.Type));
            }
        }
        return hints;
    }

    private completion(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] | undefined {
        const at = this.at(document, position);
        const result = at && completion(at[0].doc, at[1]);
        if (!result) return undefined;
        const range = this.range(document, at[0], result);
        return result.items.map(item => {
            const completion = new vscode.CompletionItem(item.label, completionKinds[item.kind]);
            completion.detail = item.detail;
            completion.range = range;
            return completion;
        });
    }

    private signatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.SignatureHelp | undefined {
        const at = this.at(document, position);
        const result = at && signatureHelp(at[0].doc, at[1]);
        if (!result) return undefined;
        const help = new vscode.SignatureHelp();
        help.signatures = result.signatures.map(s => {
            const info = new vscode.SignatureInformation(s.label);
            info.parameters = s.parameters.map(
                ([start, end]) => new vscode.ParameterInformation([start, end]),
            );
            return info;
        });
        help.activeSignature = result.active;
        help.activeParameter = result.parameter;
        return help;
    }

    private definition(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Location | undefined {
        const at = this.at(document, position);
        const result = at && definition(at[0].doc, at[1]);
        const range = result && this.range(document, at[0], result);
        return range && new vscode.Location(document.uri, range);
    }

    private occurrences(
        document: vscode.TextDocument,
        position: vscode.Position,
        includeDeclaration: boolean,
    ): vscode.Range[] | undefined {
        const at = this.at(document, position);
        const result = at && references(at[0].doc, at[1], includeDeclaration);
        return result?.flatMap(r => this.range(document, at![0], r) ?? []);
    }

    private references(
        document: vscode.TextDocument,
        position: vscode.Position,
        includeDeclaration: boolean,
    ): vscode.Location[] | undefined {
        return this.occurrences(document, position, includeDeclaration)?.map(
            range => new vscode.Location(document.uri, range),
        );
    }

    private highlights(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.DocumentHighlight[] | undefined {
        return this.occurrences(document, position, true)?.map(
            range => new vscode.DocumentHighlight(range),
        );
    }

    private prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Range | undefined {
        const at = this.at(document, position);
        const result = at && prepareRename(at[0].doc, at[1]);
        if (result) return this.range(document, at[0], result);
        if (document.languageId === "wgsl")
            throw new Error("Only user declarations can be renamed.");
        return undefined;
    }

    private rename(
        document: vscode.TextDocument,
        position: vscode.Position,
        name: string,
    ): vscode.WorkspaceEdit | undefined {
        const at = this.at(document, position);
        const result = at && rename(at[0].doc, at[1]);
        if (!result) return undefined;
        if (!isValidName(name)) throw new Error(`'${name}' is not a valid WGSL identifier.`);
        const edit = new vscode.WorkspaceEdit();
        for (const r of result) {
            const range = this.range(document, at[0], r);
            if (range) edit.replace(document.uri, range, name);
        }
        return edit;
    }

    private symbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
        const convert = (region: Region, symbol: DocumentSymbol): vscode.DocumentSymbol => {
            const result = new vscode.DocumentSymbol(
                symbol.name,
                symbol.detail,
                symbolKinds[symbol.kind],
                this.range(document, region, symbol.range)!,
                this.range(document, region, symbol.selection)!,
            );
            result.children = symbol.children.map(child => convert(region, child));
            return result;
        };
        return this.regions(document).flatMap(region =>
            documentSymbols(region.doc).map(s => convert(region, s)),
        );
    }

    private folding(document: vscode.TextDocument): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        for (const region of this.regions(document))
            for (const range of foldingRanges(region.doc)) {
                const start = document.positionAt(range.start + region.shift).line;
                const end =
                    document.positionAt(range.end + region.shift).line - (range.comment ? 0 : 1);
                if (end > start)
                    ranges.push(
                        new vscode.FoldingRange(
                            start,
                            end,
                            range.comment ? vscode.FoldingRangeKind.Comment : undefined,
                        ),
                    );
            }
        return ranges;
    }

    private format(
        document: vscode.TextDocument,
        options: vscode.FormattingOptions,
    ): vscode.TextEdit[] {
        const text = document.getText();
        const formatted = format(text, { indent: indentOf(options) });
        if (formatted === text) return [];
        const all = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
        return [vscode.TextEdit.replace(all, formatted)];
    }

    private formatTemplateAction(
        document: vscode.TextDocument,
        range: vscode.Range,
    ): vscode.CodeAction[] {
        const offset = document.offsetAt(range.start);
        const region = this.regions(document).find(r => r.start <= offset && offset <= r.end);
        const template = region?.template;
        if (!template) return [];
        const text = document.getText();
        const editor = vscode.window.activeTextEditor;
        const indent =
            editor?.document === document
                ? indentOf(editor.options as vscode.FormattingOptions)
                : "    ";
        const formatted = formatTemplate(text, template, indent);
        if (formatted === text.slice(template.start, template.end)) return [];
        const action = new vscode.CodeAction(
            "Format WGSL template",
            vscode.CodeActionKind.RefactorRewrite,
        );
        action.edit = new vscode.WorkspaceEdit();
        const target = new vscode.Range(
            document.positionAt(template.start),
            document.positionAt(template.end),
        );
        action.edit.replace(document.uri, target, formatted);
        return [action];
    }
}

/** Formats the memory layout of a type, struct member or buffer variable as a Markdown line. */
function layoutLine({ offset, size, align }: Layout): string {
    const where = offset === undefined ? "" : `**Offset** ${offset} · `;
    return `${where}**Size** ${size} · **Align** ${align}`;
}

/** Formats the template's content, indenting the lines one level deeper than the template's line. */
function formatTemplate(text: string, template: Template, indent: string): string {
    const content = text.slice(template.start, template.end);
    const formatted = format(template.text, { indent, source: content }).trimEnd();
    if (!content.includes("\n")) return formatted;
    const lineStart = text.lastIndexOf("\n", template.start - 1) + 1;
    const base = /^[ \t]*/.exec(text.slice(lineStart))![0];
    const lines = formatted.split(/\r?\n/).map(line => (line ? base + indent + line : line));
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    return newline + lines.join(newline) + newline + base;
}

function indentOf(options: vscode.FormattingOptions): string {
    return options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
}

function severity(severity: Severity): vscode.DiagnosticSeverity {
    return severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
}

const completionKinds: Record<CompletionKind, vscode.CompletionItemKind> = {
    [CompletionKind.Keyword]: vscode.CompletionItemKind.Keyword,
    [CompletionKind.Function]: vscode.CompletionItemKind.Function,
    [CompletionKind.Variable]: vscode.CompletionItemKind.Variable,
    [CompletionKind.Constant]: vscode.CompletionItemKind.Constant,
    [CompletionKind.Parameter]: vscode.CompletionItemKind.Variable,
    [CompletionKind.Field]: vscode.CompletionItemKind.Field,
    [CompletionKind.Struct]: vscode.CompletionItemKind.Struct,
    [CompletionKind.Type]: vscode.CompletionItemKind.TypeParameter,
    [CompletionKind.EnumMember]: vscode.CompletionItemKind.EnumMember,
    [CompletionKind.Property]: vscode.CompletionItemKind.Property,
};

const symbolKinds: Record<SymbolKind, vscode.SymbolKind> = {
    [SymbolKind.Function]: vscode.SymbolKind.Function,
    [SymbolKind.Struct]: vscode.SymbolKind.Struct,
    [SymbolKind.Field]: vscode.SymbolKind.Field,
    [SymbolKind.Variable]: vscode.SymbolKind.Variable,
    [SymbolKind.Constant]: vscode.SymbolKind.Constant,
    [SymbolKind.TypeAlias]: vscode.SymbolKind.TypeParameter,
};
