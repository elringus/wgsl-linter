import * as vscode from "vscode";
import type { Severity } from "../syntax/diagnostic.ts";
import { all, type Region, type Regions } from "./regions.ts";

/** Publishes the diagnostics of the WGSL documents and templates. */
export class Diagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection("wgsl");

    constructor(private readonly regions: Regions) {}

    lint(document: vscode.TextDocument): void {
        if (vscode.languages.match(all, document) === 0) return;
        const { regions } = this;
        const diagnostics: vscode.Diagnostic[] = [];
        for (const region of regions.of(document)) {
            diagnostics.push(...this.uncheckedMarkers(document, region));
            for (const d of region.doc.diagnostics()) {
                const range = regions.range(document, region, d)!;
                const diagnostic = new vscode.Diagnostic(range, d.message, severity(d.severity));
                diagnostic.source = "wgsl";
                diagnostic.relatedInformation = d.notes?.flatMap(note => {
                    const at = regions.range(document, region, note);
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
        }
        this.collection.set(document.uri, diagnostics);
    }

    lintAll(): void {
        for (const document of vscode.workspace.textDocuments) this.lint(document);
    }

    delete(document: vscode.TextDocument): void {
        this.collection.delete(document.uri);
    }

    dispose(): void {
        this.collection.dispose();
    }

    /** Marks the substitutions that may declare the names left unchecked, to hover for details. */
    private uncheckedMarkers(document: vscode.TextDocument, region: Region): vscode.Diagnostic[] {
        if (region.doc.uncheckedNames().length === 0) return [];
        return region.doc.declaringPlaceholders().map(([start, end]) => {
            const range = this.regions.range(document, region, { start, end })!;
            const marker = new vscode.Diagnostic(
                range,
                "some names in this template aren't checked",
                vscode.DiagnosticSeverity.Hint,
            );
            marker.source = "wgsl";
            return marker;
        });
    }
}

function severity(severity: Severity): vscode.DiagnosticSeverity {
    return severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
}
