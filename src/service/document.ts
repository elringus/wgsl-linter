import { check, type Options, Sem, type Semantics } from "../semantic/check.ts";
import { type Resolution, resolve } from "../semantic/resolve.ts";
import type { Diagnostic } from "../syntax/diagnostic.ts";
import { skipTrivia } from "../syntax/lexer.ts";
import { parse } from "../syntax/parser.ts";
import { Node, type Tree } from "../syntax/tree.ts";
import { nodeAt } from "./query.ts";

/** Options of a document analysis. */
export interface DocumentOptions extends Options {
    /**
     * WGSL code shared with the text, such as the structs and functions an engine composes into
     * its shaders; spliced after the text's directives.
     */
    readonly prelude?: string;
    /**
     * Validation level, unless a leading `// wgsl: <level>` comment sets it: all the diagnostics
     * (`full`, default), all but those of the names declared elsewhere (`partial`) or none (`off`).
     */
    readonly validate?: "full" | "partial" | "off";
}

/**
 * A WGSL source analyzed lazily in layers: the syntax tree, the resolution and the semantics
 * are computed on first use, so the features only pay for the layers they need.
 * The analyzed source is the text with the prelude spliced after its directives; the offsets of
 * the features are in the source, converted to the text with {@link textOffset}.
 */
export class Document {
    /** The analyzed source: the text with the prelude spliced after its directives. */
    readonly source: string;
    private readonly preludeStart: number;
    /** Length of the prelude in the source, with the line breaks around it. */
    private readonly preludeLength: number;
    private parsed: Tree | undefined;
    private resolved: Resolution | undefined;
    private checked: Semantics | undefined;

    constructor(
        readonly text: string,
        readonly options: DocumentOptions = {},
    ) {
        const at = options.prelude ? spliceOffset(text) : -1;
        const prelude = at < 0 ? "" : `\n${options.prelude}\n`;
        this.preludeStart = Math.max(at, 0);
        this.preludeLength = prelude.length;
        this.source = prelude ? text.slice(0, at) + prelude + text.slice(at) : text;
    }

    get tree(): Tree {
        return (this.parsed ??= parse(this.source));
    }

    get resolution(): Resolution {
        return (this.resolved ??= resolve(this.tree));
    }

    get semantics(): Semantics {
        return (this.checked ??= check(this.resolution, this.options));
    }

    /** Returns the offset in the text of the source offset, or -1 when it's inside the prelude. */
    textOffset(offset: number): number {
        const { preludeStart, preludeLength } = this;
        if (offset <= preludeStart) return offset;
        return offset >= preludeStart + preludeLength ? offset - preludeLength : -1;
    }

    /** Returns the offset in the source of the text offset. */
    sourceOffset(offset: number): number {
        return offset < this.preludeStart ? offset : offset + this.preludeLength;
    }

    /** Whether the source range is in the prelude rather than the text. */
    inPrelude(start: number, end: number): boolean {
        return this.textOffset(start) < 0 || this.textOffset(end) < 0;
    }

    /** Returns the diagnostics of the text sorted by position, except those the level skips. */
    diagnostics(): Diagnostic[] {
        const level = leadingLevel(this.text) ?? this.options.validate;
        if (level === "off") return [];
        const { tree, resolution, semantics } = this;
        return [...tree.diagnostics, ...resolution.diagnostics, ...semantics.diagnostics]
            .filter(
                d =>
                    !this.inPrelude(d.start, d.end) &&
                    (level !== "partial" || !this.isUnresolved(d)),
            )
            .sort((a, b) => a.start - b.start);
    }

    /** Whether the diagnostic is reported at a name that doesn't resolve to a declaration. */
    private isUnresolved(diagnostic: Diagnostic): boolean {
        const { tree } = this;
        const node = nodeAt(tree, diagnostic.start);
        return (
            tree.kinds[node] === Node.Ident &&
            tree.starts[node] === diagnostic.start &&
            tree.ends[node] === diagnostic.end &&
            this.resolution.refs[node] === 0 &&
            this.semantics.sems[node] === Sem.Error
        );
    }
}

const directive = /(?:enable|requires|diagnostic)(?!\p{XID_Continue})/uy;
const directiveChar = /[\p{XID_Continue},.()]/u;

/** Returns the offset to splice the prelude at, or -1 when it can't be spliced. */
function spliceOffset(text: string): number {
    let end = 0;
    for (let pos = skip(text, 0); ; pos = skip(text, end)) {
        directive.lastIndex = pos;
        if (!directive.test(text)) return end;
        for (pos = skip(text, directive.lastIndex); text[pos] !== ";"; pos = skip(text, pos + 1))
            if (pos === text.length) return -1;
            else if (!directiveChar.test(text[pos]!)) return text.length;
        end = pos + 1;
    }
}

/** Returns the offset after the blankspace and comments at the offset. */
function skip(text: string, pos: number): number {
    return skipTrivia(text, pos, [], ignore);
}

function ignore(): void {}

/** Returns the level of the `// wgsl: <level>` comment among the leading comments. */
function leadingLevel(text: string): DocumentOptions["validate"] {
    const comment = /\s*(?:\/\/([^\n]*)|\/\*([\s\S]*?)\*\/)/y;
    for (let match; (match = comment.exec(text));) {
        const level = /^\s*wgsl:\s*(full|partial|off)\s*$/.exec(match[1] ?? match[2]!)?.[1];
        if (level) return level as DocumentOptions["validate"];
    }
    return undefined;
}
