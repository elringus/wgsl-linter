import * as vscode from "vscode";
import { completion, CompletionKind } from "../service/completion.ts";
import type { Regions } from "./regions.ts";

export function provideCompletion(
    regions: Regions,
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.CompletionItem[] | undefined {
    const at = regions.at(document, position);
    const result = at && completion(at[0].doc, at[1]);
    if (!result) return undefined;
    const range = regions.range(document, at[0], result);
    return result.items.map(item => {
        const completion = new vscode.CompletionItem(item.label, kinds[item.kind]);
        completion.detail = item.detail;
        completion.range = range;
        return completion;
    });
}

const kinds: Record<CompletionKind, vscode.CompletionItemKind> = {
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
