import * as vscode from "vscode";
import { extractTemplates, type Template } from "../embed.ts";
import type { Options as AnalyzerOptions } from "../semantic/check.ts";
import { Document, type DocumentOptions } from "../service/document.ts";
import type { Range } from "../service/navigation.ts";
import { matches } from "./glob.ts";

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
     * Validation levels by globs relative to the workspace folder, as in
     * {@link DocumentOptions.validate}; the most specific matching glob applies, and the JS/TS files
     * matched by a glob other than `off` are validated even when closed.
     */
    readonly validate?: Readonly<Record<string, NonNullable<DocumentOptions["validate"]>>>;
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
const leniency = { full: 0, partial: 1, off: 2 };

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
    private readonly cache = new Map<string, { version: number; regions: Region[] }>();
    /** Prelude file texts by file URI, by workspace folder URI. */
    private readonly preludes = new Map<string, Map<string, string>>();

    constructor(readonly optionsOf: (folder: vscode.WorkspaceFolder | undefined) => Options) {}

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
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const options = this.optionsOf(folder);
        const { extensions, features } = options;
        const prelude = this.preludeOf(uri, folder, options.prelude);
        const validate = this.levelOf(uri, folder);
        if (wgsl) {
            const doc = new Document(text, { prelude, extensions, features, validate });
            return [{ doc, shift: -doc.base, start: 0, end: text.length }];
        }
        return extractTemplates(text, options.tags ?? ["wgsl"]).map(template => {
            const { placeholders } = template;
            const doc = new Document(template.text, {
                prelude,
                extensions,
                features,
                validate,
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

    /** Returns the validation level of the most specific glob matching the file. */
    levelOf(
        uri: vscode.Uri,
        folder: vscode.WorkspaceFolder | undefined,
    ): DocumentOptions["validate"] {
        const levels = folder && this.optionsOf(folder).validate;
        if (!levels) return undefined;
        const path = vscode.workspace.asRelativePath(uri, false);
        let result: DocumentOptions["validate"];
        let specificity = -1;
        for (const [glob, level] of Object.entries(levels)) {
            const literals = glob.replace(/[*?{},]/g, "").length;
            if (literals < specificity || !matches(glob, path)) continue;
            if (literals > specificity || leniency[level] > leniency[result!]) {
                specificity = literals;
                result = level;
            }
        }
        return result;
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

    /** Reloads the preludes and the analyses on changes of the prelude files, folders and settings. */
    watchSettings(reloaded: () => void): vscode.Disposable[] {
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
                event => event.affectsConfiguration("wgsl") && reload(),
            ),
        ];
    }

    /** Returns the prelude of the document: of the option and the folder's files except itself. */
    private preludeOf(
        uri: vscode.Uri,
        folder: vscode.WorkspaceFolder | undefined,
        prelude: string | undefined,
    ): string | undefined {
        const files = folder ? this.preludes.get(folder.uri.toString()) : undefined;
        const key = uri.toString();
        const parts = [prelude ?? ""];
        for (const [uri, text] of files ?? []) if (uri !== key) parts.push(text);
        return parts.join("\n").trim() || undefined;
    }
}
