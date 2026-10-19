import * as vscode from "vscode";
import type { Layout } from "../service/describe.ts";
import { hover } from "../service/hover.ts";
import type { Regions } from "./regions.ts";

export function provideHover(
    regions: Regions,
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.Hover | undefined {
    const at = regions.at(document, position);
    const result = at && hover(at[0].doc, at[1]);
    if (!result) return undefined;
    const contents = new vscode.MarkdownString();
    if (result.code) contents.appendCodeblock(result.code, "wgsl");
    const sections: string[] = [];
    if (result.documentation) sections.push(result.documentation);
    if (result.layout) sections.push(layoutLine(result.layout));
    if (result.link) sections.push(`[Specification](${result.link})`);
    if (sections.length > 0)
        contents.appendMarkdown(`${result.code ? "\n\n---\n\n" : ""}${sections.join("\n\n")}`);
    return new vscode.Hover(contents, regions.range(document, at[0], result));
}

/** Formats the memory layout of a type, struct member or buffer variable as a Markdown line. */
function layoutLine({ offset, size, align }: Layout): string {
    const where = offset === undefined ? "" : `**Offset** ${offset} · `;
    return `${where}**Size** ${size} · **Align** ${align}`;
}
