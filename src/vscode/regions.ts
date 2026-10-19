import * as vscode from "vscode";
import { extractTemplates, type Template } from "../embed.ts";
import type { Options as AnalyzerOptions } from "../semantic/check.ts";
import { Document } from "../service/document.ts";
import type { Range } from "../service/navigation.ts";

/** Options of the WGSL language features. */
export interface Options extends AnalyzerOptions {
    /** Tags of the JS/TS template literals holding WGSL, as in wgsl`...`; `wgsl` by default. */
    readonly tags?: readonly string[];
    /**
     * WGSL declarations available to all the shaders, such as the structs and functions an
     * engine provides; analyzed as if prepended to each shader.
     */
    readonly prelude?: string;
    /**
     * Documents to lint besides the open ones: the workspace's `.wgsl` files (`files`, default),
     * also its JS/TS templates (`all`) or none (`open`).
     */
    readonly lint?: "open" | "files" | "all";
}

export const wgsl: vscode.DocumentSelector = { language: "wgsl" };
export const scripts: vscode.DocumentSelector = [
    { language: "javascript" },
    { language: "typescript" },
    { language: "javascriptreact" },
    { language: "typescriptreact" },
];
export const all: vscode.DocumentSelector = [wgsl, ...(scripts as vscode.DocumentFilter[])];

const decoder = new TextDecoder();

/**
 * A WGSL source within a VS Code document: a whole `.wgsl` document or a template literal;
 * the offsets of the document in the host are the analyzed offsets plus the shift.
 */
export interface Region {
    readonly doc: Document;
    readonly shift: number;
    /** Range of the region in the host document. */
    readonly start: number;
    readonly end: number;
    readonly template?: Template;
}

/** The analyzed WGSL regions of the VS Code documents. */
export class Regions {
    readonly tags: readonly string[];
    private readonly cache = new Map<string, { version: number; regions: Region[] }>();
    /** Prelude file texts by file URI, by workspace folder URI. */
    private readonly preludes = new Map<string, Map<string, string>>();

    constructor(private readonly options: Options) {
        this.tags = options.tags ?? ["wgsl"];
    }

    of(document: vscode.TextDocument): Region[] {
        const key = document.uri.toString();
        const cached = this.cache.get(key);
        if (cached?.version === document.version) return cached.regions;
        const regions = this.analyze(
            document.uri,
            document.getText(),
            document.languageId === "wgsl",
        );
        this.cache.set(key, { version: document.version, regions });
        return regions;
    }

    /** Analyzes the WGSL text or the templates of the JS/TS text, without caching. */
    analyze(uri: vscode.Uri, text: string, wgsl: boolean): Region[] {
        const { extensions, features } = this.options;
        const prelude = this.preludeOf(uri);
        if (wgsl) {
            const doc = new Document(text, { prelude, extensions, features });
            return [{ doc, shift: -doc.base, start: 0, end: text.length }];
        }
        return extractTemplates(text, this.tags).map(template => {
            const { placeholders } = template;
            const doc = new Document(template.text, {
                prelude,
                extensions,
                features,
                placeholders,
            });
            const shift = template.start - doc.base;
            return { doc, shift, start: template.start, end: template.end, template };
        });
    }

    /** Returns the region at the position and the analyzed offset of the position. */
    at(document: vscode.TextDocument, position: vscode.Position): [Region, number] | undefined {
        const offset = document.offsetAt(position);
        const region = this.of(document).find(r => r.start <= offset && offset <= r.end);
        return region && [region, offset - region.shift];
    }

    /** Converts the analyzed range to the host document's range, unless it's in the prelude. */
    range(
        document: Pick<vscode.TextDocument, "positionAt">,
        region: Region,
        range: Range,
    ): vscode.Range | undefined {
        if (range.start < region.doc.base) return undefined;
        return new vscode.Range(
            document.positionAt(range.start + region.shift),
            document.positionAt(range.end + region.shift),
        );
    }

    forget(document: vscode.TextDocument): void {
        this.cache.delete(document.uri.toString());
    }

    /** Loads the files of the `wgsl.prelude` setting. */
    async loadPreludes(): Promise<void> {
        const { workspace } = vscode;
        this.preludes.clear();
        for (const folder of workspace.workspaceFolders ?? []) {
            const files = new Map<string, string>();
            const globs = workspace.getConfiguration("wgsl", folder).get<string[]>("prelude", []);
            for (const glob of globs)
                for (const uri of await workspace.findFiles(
                    new vscode.RelativePattern(folder, glob),
                ))
                    if (uri.path.endsWith(".wgsl"))
                        files.set(uri.toString(), decoder.decode(await workspace.fs.readFile(uri)));
            this.preludes.set(folder.uri.toString(), files);
        }
    }

    /** Reloads the preludes on changes. */
    watchPreludes(reloaded: () => void): vscode.Disposable[] {
        const { workspace } = vscode;
        const reload = async (): Promise<void> => {
            await this.loadPreludes();
            this.cache.clear();
            reloaded();
        };
        const isPrelude = (uri: vscode.Uri): boolean =>
            [...this.preludes.values()].some(files => files.has(uri.toString()));
        const watcher = workspace.createFileSystemWatcher("**/*.wgsl");
        return [
            watcher,
            watcher.onDidCreate(reload),
            watcher.onDidDelete(reload),
            watcher.onDidChange(uri => isPrelude(uri) && reload()),
            workspace.onDidChangeWorkspaceFolders(reload),
            workspace.onDidChangeConfiguration(
                event => event.affectsConfiguration("wgsl.prelude") && reload(),
            ),
        ];
    }

    /** Returns the prelude of the document, excluding itself. */
    private preludeOf(uri: vscode.Uri): string | undefined {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const files = folder ? this.preludes.get(folder.uri.toString()) : undefined;
        const key = uri.toString();
        const parts = [this.options.prelude ?? ""];
        for (const [uri, text] of files ?? []) if (uri !== key) parts.push(text);
        return parts.join("\n").trim() || undefined;
    }
}
