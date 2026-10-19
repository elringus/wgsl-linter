import * as vscode from "vscode";
import { inlayHints } from "../service/hints.ts";
import type { Regions } from "./regions.ts";

export function provideInlayHints(
    regions: Regions,
    document: vscode.TextDocument,
    range: vscode.Range,
): vscode.InlayHint[] {
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    const hints: vscode.InlayHint[] = [];
    for (const region of regions.of(document)) {
        if (region.end < start || region.start > end) continue;
        const { doc } = region;
        const from = doc.sourceOffset(start - region.start);
        for (const hint of inlayHints(doc, from, doc.sourceOffset(end - region.start))) {
            const position = document.positionAt(doc.textOffset(hint.offset) + region.start);
            hints.push(new vscode.InlayHint(position, hint.label, vscode.InlayHintKind.Type));
        }
    }
    return hints;
}
