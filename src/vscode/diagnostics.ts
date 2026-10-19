import * as vscode from "vscode";
import { lineStarts, position } from "../lines.ts";
import type { Severity } from "../syntax/diagnostic.ts";
import { all, type Region, type Regions } from "./regions.ts";

const scripts = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);
const decoder = new TextDecoder();

/** Publishes the diagnostics of the WGSL documents and templates. */
export class Diagnostics implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection("wgsl");
    /** Number of the latest workspace scan, stopping the previous ones. */
    private scan = 0;

    constructor(private readonly regions: Regions) {}

    lint(document: vscode.TextDocument): void {
        if (vscode.languages.match(all, document) === 0) return;
        this.publish(document.uri, document, this.regions.of(document));
    }

    /** Lints the open documents and the closed files in the scope, clearing the others. */
    async lintAll(): Promise<void> {
        const scan = ++this.scan;
        const stale = new Map<string, vscode.Uri>();
        this.collection.forEach(uri => stale.set(uri.toString(), uri));
        for (const document of vscode.workspace.textDocuments) {
            stale.delete(document.uri.toString());
            this.lint(document);
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const levels = Object.entries(this.regions.optionsOf(folder).validate ?? {});
            const globs = [
                "**/*.wgsl",
                ...levels.flatMap(([glob, l]) => (l === "off" ? [] : glob)),
            ];
            const files = new Map<string, vscode.Uri>();
            for (const glob of globs)
                for (const uri of await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, glob),
                    "**/node_modules/**",
                ))
                    files.set(uri.toString(), uri);
            for (const [key, uri] of files) {
                if (scan !== this.scan) return;
                if (!this.inScope(uri)) continue;
                stale.delete(key);
                await this.lintFile(uri);
            }
        }
        if (scan === this.scan) for (const uri of stale.values()) this.collection.delete(uri);
    }

    /** Lints the files in the scope on their changes on disk. */
    watch(): vscode.Disposable[] {
        const watcher = vscode.workspace.createFileSystemWatcher(
            `**/*.{wgsl,${[...scripts].join(",")}}`,
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
        for (const region of regions)
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
        this.collection.set(uri, diagnostics);
    }

    /** Whether the closed file is validated: a `.wgsl` file or a JS/TS file of a glob, unless `off`. */
    private inScope(uri: vscode.Uri): boolean {
        const { path } = uri;
        const extension = path.slice(path.lastIndexOf(".") + 1);
        const wgsl = extension === "wgsl";
        if (path.includes("/node_modules/") || (!wgsl && !scripts.has(extension))) return false;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder) return false;
        const level = this.regions.levelOf(uri, folder);
        return level === undefined ? wgsl : level !== "off";
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
