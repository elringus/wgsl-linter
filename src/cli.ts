#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { extractTemplates } from "./embed.ts";
import { lineStarts, position } from "./lines.ts";
import { Document } from "./service/document.ts";

const usage = `usage: wgsl-lint [options] <file or directory>...

Reports the diagnostics of the WGSL files and the WGSL templates in JS/TS files;
directories are searched for the .wgsl files and, with --tag, the JS/TS files.

options:
  --tag <name>      tag of the JS/TS template literals holding WGSL, as in wgsl\`...\`; repeatable
  --prelude <file>  WGSL code spliced after the directives of all the shaders
  --help            show this message`;

const scripts = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

process.exitCode = main(process.argv.slice(2));

function main(args: readonly string[]): number {
    const tags: string[] = [];
    const paths: string[] = [];
    let prelude: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--help") {
            console.log(usage);
            return 0;
        }
        if (arg === "--tag" || arg === "--prelude") {
            const value = args[++i];
            if (value === undefined) return fail(`missing value of ${arg}`);
            if (arg === "--tag") tags.push(value);
            else prelude = readFileSync(value, "utf8");
        } else if (arg.startsWith("--")) return fail(`unknown option ${arg}`);
        else paths.push(arg);
    }
    if (paths.length === 0) return fail("no files given");
    let errors = 0;
    let warnings = 0;
    for (const file of files(paths, tags.length > 0)) {
        const text = readFileSync(file, "utf8");
        const lines = lineStarts(text);
        const report = (offset: number, kind: string, message: string): void => {
            const [line, column] = position(lines, offset);
            console.log(`${file}:${line + 1}:${column + 1}: ${kind}: ${message}`);
        };
        for (const [doc, shift] of shaders(file, text, tags, prelude))
            for (const d of doc.diagnostics()) {
                if (d.severity === "error") errors++;
                else if (d.severity === "warning") warnings++;
                report(doc.textOffset(d.start) + shift, d.severity, d.message);
                for (const note of d.notes ?? [])
                    if (!doc.inPrelude(note.start, note.end))
                        report(doc.textOffset(note.start) + shift, "note", note.message);
            }
    }
    if (errors + warnings > 0) console.log(`${errors} error(s), ${warnings} warning(s)`);
    return errors > 0 ? 1 : 0;
}

function fail(message: string): number {
    console.error(`wgsl-lint: ${message}\n\n${usage}`);
    return 2;
}

/** Returns the documents of the file's shaders with the offsets of their texts in the file. */
function shaders(
    file: string,
    text: string,
    tags: readonly string[],
    prelude: string | undefined,
): [Document, number][] {
    if (!scripts.has(extname(file))) return [[new Document(text, { prelude }), 0]];
    return extractTemplates(text, tags.length > 0 ? tags : ["wgsl"]).map(template => [
        new Document(template.text, { prelude }),
        template.start,
    ]);
}

/** Expands the directories to the WGSL files and, when searching templates, the JS/TS files. */
function* files(paths: readonly string[], templates: boolean): Generator<string> {
    for (const path of paths) {
        if (!statSync(path).isDirectory()) {
            yield path;
            continue;
        }
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const child = join(path, entry.name);
            const ext = extname(entry.name);
            if (entry.isDirectory()) yield* files([child], templates);
            else if (ext === ".wgsl" || (templates && scripts.has(ext))) yield child;
        }
    }
}
