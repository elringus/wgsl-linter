import * as vscode from "vscode";
import { semanticTokens } from "../service/tokens.ts";
import type { Regions } from "./regions.ts";

export function provideSemanticTokens(
    regions: Regions,
    document: vscode.TextDocument,
    legend: vscode.SemanticTokensLegend,
): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(legend);
    const { doc, start } = regions.of(document)[0]!;
    const data = semanticTokens(doc);
    for (let i = 0; i < data.length; i += 4) {
        const position = document.positionAt(doc.textOffset(data[i]!) + start);
        builder.push(position.line, position.character, data[i + 1]!, data[i + 2]!, data[i + 3]!);
    }
    return builder.build();
}
