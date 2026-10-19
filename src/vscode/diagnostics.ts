import * as vscode from "vscode";
import { lineStarts, position } from "../lines.ts";
import type { Severity } from "../syntax/diagnostic.ts";
import { all, type Options, type Region, type Regions } from "./regions.ts";

type Scope = (folder: vscode.WorkspaceFolder) => Options["lint"];

/** Extensions of the workspace files to lint by the lint option. */
const extensions: Record<NonNullable<Options["lint"]>, readonly string[]> = {
    open: [],
    files: ["wgsl"],
    all: ["wgsl", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"],
};

const decoder = new TextDecoder();

/** Publishes the diagnostics of the WGSL documents and templates. */
export class Diagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection("wgsl");
    /** Number of the latest workspace scan, stopping the previous ones. */
    private scan = 0;

    constructor(
        private readonly regions: Regions,
        private readonly scope: Scope,
    ) {}

    lint(document: vscode.TextDocument): void {
        if (vscode.languages.match(all, document) === 0) return;
        this.publish(document.uri, document, this.regions.of(document));
    }

    /** Lints the open documents and the workspace files, clearing the diagnostics out of the scope. */
    async lintAll(): Promise<void> {
        const scan = ++this.scan;
        const stale = new Map<string, vscode.Uri>();
        this.collection.forEach(uri => stale.set(uri.toString(), uri));
        for (const document of vscode.workspace.textDocuments) {
            stale.delete(document.uri.toString());
            this.lint(document);
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const types = this.extensionsOf(folder);
            if (types.length === 0) continue;
            const glob = new vscode.RelativePattern(folder, `**/*.{${types.join(",")}}`);
            for (const uri of await vscode.workspace.findFiles(glob, "**/node_modules/**")) {
                if (scan !== this.scan) return;
                stale.delete(uri.toString());
                await this.lintFile(uri);
            }
        }
        if (scan === this.scan) for (const uri of stale.values()) this.collection.delete(uri);
    }

    /** Lints the files in the scope on their changes on disk. */
    watch(): vscode.Disposable[] {
        const watcher = vscode.workspace.createFileSystemWatcher(
            `**/*.{${extensions.all.join(",")}}`,
        );
        const changed = (uri: vscode.Uri): void => {
            if (this.inScope(uri)) void this.lintFile(uri);
        };
        return [
            watcher,
            watcher.onDidCreate(changed),
            watcher.onDidChange(changed),
            watcher.onDidDelete(uri => {
                if (!isOpen(uri)) this.collection.delete(uri);
            }),
        ];
    }

    /** Lints the closed document from disk when it's in the scope, as its changes may be discarded. */
    close(document: vscode.TextDocument): void {
        if (this.inScope(document.uri)) void this.lintFile(document.uri);
        else this.collection.delete(document.uri);
    }

    dispose(): void {
        this.collection.dispose();
    }

    /** Lints the file from disk, unless it's open and so linted from the editor. */
    private async lintFile(uri: vscode.Uri): Promise<void> {
        if (isOpen(uri)) return;
        const text = await vscode.workspace.fs.readFile(uri).then(
            data => decoder.decode(data),
            () => undefined,
        );
        if (text === undefined) this.collection.delete(uri);
        else {
            const regions = this.regions.analyze(uri, text, uri.path.endsWith(".wgsl"));
            if (regions.length > 0 || this.collection.has(uri))
                this.publish(uri, new Lines(text), regions);
        }
    }

    private publish(
        uri: vscode.Uri,
        document: Pick<vscode.TextDocument, "positionAt">,
        regions: readonly Region[],
    ): void {
        const diagnostics: vscode.Diagnostic[] = [];
        for (const region of regions) {
            diagnostics.push(...this.uncheckedMarkers(document, region));
            for (const d of region.doc.diagnostics()) {
                const range = this.regions.range(document, region, d)!;
                const diagnostic = new vscode.Diagnostic(range, d.message, severity(d.severity));
                diagnostic.source = "wgsl";
                diagnostic.relatedInformation = d.notes?.flatMap(note => {
                    const at = this.regions.range(document, region, note);
                    return at
                        ? [
                              new vscode.DiagnosticRelatedInformation(
                                  new vscode.Location(uri, at),
                                  note.message,
                              ),
                          ]
                        : [];
                });
                diagnostics.push(diagnostic);
            }
        }
        this.collection.set(uri, diagnostics);
    }

    /** Marks the substitutions that may declare the names left unchecked, to hover for details. */
    private uncheckedMarkers(
        document: Pick<vscode.TextDocument, "positionAt">,
        region: Region,
    ): vscode.Diagnostic[] {
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

    private inScope(uri: vscode.Uri): boolean {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const { path } = uri;
        return (
            folder !== undefined &&
            !path.includes("/node_modules/") &&
            this.extensionsOf(folder).includes(path.slice(path.lastIndexOf(".") + 1))
        );
    }

    private extensionsOf(folder: vscode.WorkspaceFolder): readonly string[] {
        return extensions[this.scope(folder) ?? "files"];
    }
}

/** Converts the offsets of a text read from disk to positions, as a text document does. */
class Lines {
    private starts?: number[];

    constructor(private readonly text: string) {}

    positionAt(offset: number): vscode.Position {
        const [line, character] = position((this.starts ??= lineStarts(this.text)), offset);
        return new vscode.Position(line, character);
    }
}

function isOpen(uri: vscode.Uri): boolean {
    const key = uri.toString();
    return vscode.workspace.textDocuments.some(document => document.uri.toString() === key);
}

function severity(severity: Severity): vscode.DiagnosticSeverity {
    return severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
}
