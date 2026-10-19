import * as vscode from "vscode";
import { tokenModifiers, tokenTypes } from "../service/tokens.ts";
import { provideCompletion } from "./completion.ts";
import { Diagnostics } from "./diagnostics.ts";
import { provideFormatTemplateAction, provideFormatting } from "./format.ts";
import { provideInlayHints } from "./hints.ts";
import { provideHover } from "./hover.ts";
import {
    provideDefinition,
    provideHighlights,
    provideReferences,
    provideRenameEdits,
    provideRenameRange,
} from "./navigation.ts";
import { all, type Options, Regions, scripts, wgsl } from "./regions.ts";
import { provideSignatureHelp } from "./signature.ts";
import { provideFoldingRanges, provideSymbols } from "./symbols.ts";
import { provideSemanticTokens } from "./tokens.ts";

/**
 * Registers the WGSL language features: for the `.wgsl` documents and the WGSL templates
 * embedded in the JS/TS documents.
 */
export function register(
    context: vscode.ExtensionContext,
    options: Options = {},
): vscode.Disposable {
    const regions = new Regions(options);
    const diagnostics = new Diagnostics(regions, () => options.lint);
    const disposable = vscode.Disposable.from(...features(regions, diagnostics));
    context.subscriptions.push(disposable);
    return disposable;
}

/** Registers the language features over the regions. */
export function features(regions: Regions, diagnostics: Diagnostics): vscode.Disposable[] {
    const { languages, workspace } = vscode;
    const legend = new vscode.SemanticTokensLegend([...tokenTypes], [...tokenModifiers]);
    void diagnostics.lintAll();
    return [
        diagnostics,
        ...diagnostics.watch(),
        workspace.onDidOpenTextDocument(document => diagnostics.lint(document)),
        workspace.onDidChangeTextDocument(event => diagnostics.lint(event.document)),
        workspace.onDidCloseTextDocument(document => {
            regions.forget(document);
            diagnostics.close(document);
        }),
        workspace.onDidChangeWorkspaceFolders(() => diagnostics.lintAll()),
        languages.registerDocumentSemanticTokensProvider(
            wgsl,
            { provideDocumentSemanticTokens: d => provideSemanticTokens(regions, d, legend) },
            legend,
        ),
        languages.registerHoverProvider(all, {
            provideHover: (d, p) => provideHover(regions, d, p),
        }),
        languages.registerInlayHintsProvider(all, {
            provideInlayHints: (d, r) => provideInlayHints(regions, d, r),
        }),
        languages.registerCompletionItemProvider(
            all,
            { provideCompletionItems: (d, p) => provideCompletion(regions, d, p) },
            ".",
            "@",
            "<",
            ":",
        ),
        languages.registerSignatureHelpProvider(
            all,
            { provideSignatureHelp: (d, p) => provideSignatureHelp(regions, d, p) },
            "(",
            ",",
        ),
        languages.registerDefinitionProvider(all, {
            provideDefinition: (d, p) => provideDefinition(regions, d, p),
        }),
        languages.registerReferenceProvider(all, {
            provideReferences: (d, p, c) => provideReferences(regions, d, p, c.includeDeclaration),
        }),
        languages.registerDocumentHighlightProvider(all, {
            provideDocumentHighlights: (d, p) => provideHighlights(regions, d, p),
        }),
        languages.registerRenameProvider(all, {
            prepareRename: (d, p) => provideRenameRange(regions, d, p),
            provideRenameEdits: (d, p, name) => provideRenameEdits(regions, d, p, name),
        }),
        languages.registerDocumentSymbolProvider(all, {
            provideDocumentSymbols: d => provideSymbols(regions, d),
        }),
        languages.registerFoldingRangeProvider(all, {
            provideFoldingRanges: d => provideFoldingRanges(regions, d),
        }),
        languages.registerDocumentFormattingEditProvider(wgsl, {
            provideDocumentFormattingEdits: (d, o) => provideFormatting(d, o),
        }),
        languages.registerCodeActionsProvider(
            scripts,
            { provideCodeActions: (d, r) => provideFormatTemplateAction(regions, d, r) },
            { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] },
        ),
    ];
}
