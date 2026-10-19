import { check, type Options, Sem, type Semantics } from "../semantic/check.ts";
import { type Resolution, resolve } from "../semantic/resolve.ts";
import type { Diagnostic } from "../syntax/diagnostic.ts";
import { parse } from "../syntax/parser.ts";
import { Node, type Tree } from "../syntax/tree.ts";
import { nodeAt } from "./query.ts";

/** Options of a document analysis. */
export interface DocumentOptions extends Options {
    /**
     * WGSL declarations available to the document, such as the structs and functions an engine
     * provides; analyzed as if prepended to the text.
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
 * The analyzed source is the prelude followed by the text; the offsets of the features are
 * the offsets in the analyzed source, the text starting at {@link base}.
 */
export class Document {
    /** The analyzed source: the prelude and the text. */
    readonly source: string;
    /** Offset of the text in the analyzed source. */
    readonly base: number;
    private parsed: Tree | undefined;
    private resolved: Resolution | undefined;
    private checked: Semantics | undefined;

    constructor(
        readonly text: string,
        readonly options: DocumentOptions = {},
    ) {
        const prelude = options.prelude ? `${options.prelude}\n` : "";
        this.source = prelude + text;
        this.base = prelude.length;
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

    /** Returns the diagnostics of the text sorted by position, except those the level skips. */
    diagnostics(): Diagnostic[] {
        const level = leadingLevel(this.source, this.base) ?? this.options.validate;
        if (level === "off") return [];
        const { tree, resolution, semantics, base } = this;
        const reported: Diagnostic[] = [];
        for (const list of [tree.diagnostics, resolution.diagnostics, semantics.diagnostics])
            for (const d of list)
                if (d.start >= base && (level !== "partial" || !this.isUnresolved(d)))
                    reported.push(d);
        return reported.sort((a, b) => a.start - b.start);
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

/** Returns the level of the `// wgsl: <level>` comment among the comments leading the offset. */
function leadingLevel(source: string, offset: number): DocumentOptions["validate"] {
    const comment = /\s*(?:\/\/([^\n]*)|\/\*([\s\S]*?)\*\/)/y;
    comment.lastIndex = offset;
    for (let match; (match = comment.exec(source));) {
        const level = /^\s*wgsl:\s*(full|partial|off)\s*$/.exec(match[1] ?? match[2]!)?.[1];
        if (level) return level as DocumentOptions["validate"];
    }
    return undefined;
}
