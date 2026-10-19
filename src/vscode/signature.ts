import * as vscode from "vscode";
import { signatureHelp } from "../service/signature.ts";
import type { Regions } from "./regions.ts";

export function provideSignatureHelp(
    regions: Regions,
    document: vscode.TextDocument,
    position: vscode.Position,
): vscode.SignatureHelp | undefined {
    const at = regions.at(document, position);
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
