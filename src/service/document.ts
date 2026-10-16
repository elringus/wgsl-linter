import { check, type Options, Sem, type Semantics } from "../semantic/check.ts";
import { type Resolution, resolve } from "../semantic/resolve.ts";
import type { Diagnostic } from "../syntax/diagnostic.ts";
import { parse } from "../syntax/parser.ts";
import { Node, type Tree } from "../syntax/tree.ts";
import { nodeAt, tokenIndex } from "./query.ts";

/** Options of a document analysis. */
export interface DocumentOptions extends Options {
    /**
     * WGSL declarations available to the document, such as the structs and functions an engine
     * provides; analyzed as if prepended to the text.
     */
    readonly prelude?: string;
    /**
     * Start and end offsets in the text of the opaque placeholders, in pairs: the identifiers
     * standing for the substitutions of an embedding template.
     */
    readonly placeholders?: readonly number[];
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

    /**
     * Returns the diagnostics of the text sorted by position, except the uncertain ones:
     * those at the placeholders, and the unresolved names when a placeholder may declare them.
     */
    diagnostics(): Diagnostic[] {
        const { tree, resolution, semantics, base } = this;
        const placeholders = this.options.placeholders ?? [];
        const opaque = this.declaresOpaquely(placeholders);
        const certain = (d: Diagnostic): boolean => {
            if (d.start < base) return false;
            for (let i = 0; i < placeholders.length; i += 2)
                if (d.start <= placeholders[i + 1]! + base && d.end >= placeholders[i]! + base)
                    return false;
            return !opaque || !this.isUnresolved(d);
        };
        return [...tree.diagnostics, ...resolution.diagnostics, ...semantics.diagnostics]
            .filter(certain)
            .sort((a, b) => a.start - b.start);
    }

    /**
     * Whether any placeholder stands for declarations or statements rather than an expression,
     * which shows as a syntax error at it or at the token after it.
     */
    private declaresOpaquely(placeholders: readonly number[]): boolean {
        const { tree, base } = this;
        const { tokens } = tree;
        for (let i = 0; i < placeholders.length; i += 2) {
            const start = placeholders[i]! + base;
            const next = Math.min(tokenIndex(tokens, start) + 1, tokens.count - 1);
            const end = tokens.ends[next]!;
            if (tree.diagnostics.some(d => d.start >= start && d.start <= end)) return true;
        }
        return false;
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
