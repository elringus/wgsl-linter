import * as vscode from "vscode";
import {
    definition,
    isValidName,
    prepareRename,
    references,
    rename,
} from "../service/navigation.ts";
import type { Regions } from "./regions.ts";

export function provideDefinition(
    regions: Regions,
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.Location | undefined {
    const at = regions.at(document, position);
    const result = at && definition(at[0].doc, at[1]);
    const range = result && regions.range(document, at[0], result);
    return range && new vscode.Location(document.uri, range);
}

export function provideReferences(
    regions: Regions,
    document: vscode.TextDocument,
    position: vscode.Position,
    includeDeclaration: boolean,
): vscode.Location[] | undefined {
    return occurrences(regions, document, position, includeDeclaration)?.map(
        range => new vscode.Location(document.uri, range),
    );
}

export function provideHighlights(
    regions: Regions,
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.DocumentHighlight[] | undefined {
    return occurrences(regions, document, position, true)?.map(
        range => new vscode.DocumentHighlight(range),
    );
}

export function provideRenameRange(
    regions: Regions,
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.Range | undefined {
    const at = regions.at(document, position);
    const result = at && prepareRename(at[0].doc, at[1]);
    if (result) return regions.range(document, at[0], result);
    if (document.languageId === "wgsl") throw new Error("Only user declarations can be renamed.");
    return undefined;
}

export function provideRenameEdits(
    regions: Regions,
    document: vscode.TextDocument,
    position: vscode.Position,
    name: string,
): vscode.WorkspaceEdit | undefined {
    const at = regions.at(document, position);
    const result = at && rename(at[0].doc, at[1]);
    if (!result) return undefined;
    if (!isValidName(name)) throw new Error(`'${name}' is not a valid WGSL identifier.`);
    const edit = new vscode.WorkspaceEdit();
    for (const r of result) {
        const range = regions.range(document, at[0], r);
        if (range) edit.replace(document.uri, range, name);
    }
    return edit;
}

function occurrences(
    regions: Regions,
    document: vscode.TextDocument,
    position: vscode.Position,
    includeDeclaration: boolean,
): vscode.Range[] | undefined {
    const at = regions.at(document, position);
    const result = at && references(at[0].doc, at[1], includeDeclaration);
    return result?.flatMap(r => regions.range(document, at![0], r) ?? []);
}
