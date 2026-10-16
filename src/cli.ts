#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { extractTemplates } from "./embed.ts";
import { Document } from "./service/document.ts";
import type { Diagnostic } from "./syntax/diagnostic.ts";

const usage = `usage: wgsl-lint [options] <file or directory>...

Reports the diagnostics of the WGSL files and the WGSL templates in JS/TS files;
directories are searched for the .wgsl files and, with --tag, the JS/TS files.

options:
  --tag <name>      tag of the JS/TS template literals holding WGSL, as in wgsl\`...\`; repeatable
  --prelude <file>  WGSL declarations available to all the shaders
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
            console.log(`${file}:${line}:${column}: ${kind}: ${message}`);
        };
        for (const [diagnostics, shift] of analyze(file, text, tags, prelude))
            for (const d of diagnostics) {
                if (d.severity === "error") errors++;
                else if (d.severity === "warning") warnings++;
                report(d.start + shift, d.severity, d.message);
                for (const note of d.notes ?? []) report(note.start + shift, "note", note.message);
            }
    }
    if (errors + warnings > 0) console.log(`${errors} error(s), ${warnings} warning(s)`);
    return errors > 0 ? 1 : 0;
}

function fail(message: string): number {
    console.error(`wgsl-lint: ${message}\n\n${usage}`);
    return 2;
}

/** Returns the diagnostics of the file's shaders with the shifts of their offsets in the file. */
function analyze(
    file: string,
    text: string,
    tags: readonly string[],
    prelude: string | undefined,
): [Diagnostic[], number][] {
    if (!scripts.has(extname(file))) {
        const doc = new Document(text, { prelude });
        return [[doc.diagnostics(), -doc.base]];
    }
    return extractTemplates(text, tags.length > 0 ? tags : ["wgsl"]).map(template => {
        const { placeholders } = template;
        const doc = new Document(template.text, { prelude, placeholders });
        return [doc.diagnostics(), template.start - doc.base];
    });
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

function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
}

/** Returns the 1-based line and column of the offset. */
function position(lines: readonly number[], offset: number): [number, number] {
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lines[mid]! <= offset) low = mid;
        else high = mid - 1;
    }
    return [low + 1, offset - lines[low]! + 1];
}
