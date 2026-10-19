/** A WGSL template literal embedded in a JS or TS source. */
export interface Template {
    /** Offset of the template content in the host source: right after the opening backtick. */
    readonly start: number;
    /** Offset of the closing backtick in the host source, or the source length when missing. */
    readonly end: number;
    /** The WGSL text: the content with the substitutions and escapes replaced at the same length. */
    readonly text: string;
    /** Start and end offsets of the placeholders in the text, in pairs. */
    readonly placeholders: readonly number[];
}

/**
 * Extracts the WGSL templates from the JS or TS source: the template literals tagged with
 * one of the tags, as in wgsl`...`, or preceded by a comment of a tag, as in `/* wgsl *\/ \`...\``.
 */
export function extractTemplates(source: string, tags: readonly string[]): Template[] {
    if (!tags.some(tag => source.includes(tag))) return [];
    return new Scanner(source, new Set(tags)).run();
}

const regexPrecedents = new Set("(,=:[!&|?{};+-*%<>~^");

class Scanner {
    private readonly templates: Template[] = [];
    /** The last significant character outside the comments, for telling regex literals from divisions. */
    private last = "";

    constructor(
        private readonly source: string,
        private readonly tags: ReadonlySet<string>,
    ) {}

    run(): Template[] {
        this.code(0, false);
        return this.templates.sort((a, b) => a.start - b.start);
    }

    /** Scans the code from the offset; returns the offset of the closing brace of a substitution. */
    private code(i: number, substitution: boolean): number {
        const { source } = this;
        const length = source.length;
        let depth = 0;
        while (i < length) {
            const c = source[i]!;
            if (c === "/" && source[i + 1] === "/") {
                const end = source.indexOf("\n", i);
                i = end < 0 ? length : end;
                continue;
            }
            if (c === "/" && source[i + 1] === "*") {
                const end = source.indexOf("*/", i + 2);
                i = end < 0 ? length : end + 2;
                continue;
            }
            if (c === "'" || c === '"') {
                i = this.string(i, c);
                this.last = c;
                continue;
            }
            if (c === "`") {
                i = this.template(i, this.isTagged(i));
                this.last = "`";
                continue;
            }
            if (c === "/" && (this.last === "" || regexPrecedents.has(this.last))) {
                i = this.regex(i);
                this.last = "/";
                continue;
            }
            if (c === "{") depth++;
            else if (c === "}") {
                if (substitution && depth === 0) return i;
                depth--;
            }
            if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") this.last = c;
            i++;
        }
        return length;
    }

    private string(i: number, quote: string): number {
        const { source } = this;
        for (i++; i < source.length; i++) {
            const c = source[i];
            if (c === "\\") i++;
            else if (c === quote || c === "\n") return i + 1;
        }
        return source.length;
    }

    private regex(i: number): number {
        const { source } = this;
        let inClass = false;
        for (i++; i < source.length; i++) {
            const c = source[i];
            if (c === "\\") i++;
            else if (c === "[") inClass = true;
            else if (c === "]") inClass = false;
            else if (c === "\n") return i;
            else if (c === "/" && !inClass) {
                i++;
                while (i < source.length && /\w/.test(source[i]!)) i++;
                return i;
            }
        }
        return source.length;
    }

    /** Scans the template literal at the backtick; returns the offset after its end. */
    private template(i: number, tagged: boolean): number {
        const { source } = this;
        const start = i + 1;
        const placeholders: number[] = [];
        for (i = start; i < source.length; i++) {
            const c = source[i];
            if (c === "\\") i++;
            else if (c === "`") break;
            else if (c === "$" && source[i + 1] === "{") {
                const close = this.code(i + 2, true);
                placeholders.push(i - start, Math.min(close + 1, source.length) - start);
                i = close;
            }
        }
        const end = Math.min(i, source.length);
        if (tagged) {
            let text = "";
            let at = start;
            for (let p = 0; p < placeholders.length; p += 2) {
                const from = placeholders[p]! + start;
                const to = placeholders[p + 1]! + start;
                text += cooked(source.slice(at, from)) + placeholder(to - from);
                at = to;
            }
            text += cooked(source.slice(at, end));
            this.templates.push({ start, end, text, placeholders });
        }
        return end + 1;
    }

    /** Whether the backtick at the offset is preceded by a tag or a comment of a tag. */
    private isTagged(backtick: number): boolean {
        const { source } = this;
        let i = backtick - 1;
        while (i >= 0 && /\s/.test(source[i]!)) i--;
        if (source[i] === "/" && source[i - 1] === "*") {
            const open = source.lastIndexOf("/*", i - 2);
            return open >= 0 && this.tags.has(source.slice(open + 2, i - 1).trim());
        }
        const end = i + 1;
        while (i >= 0 && /[\w$]/.test(source[i]!)) i--;
        return this.tags.has(source.slice(i + 1, end));
    }
}

const escapes: Readonly<Record<string, string>> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    v: "\v",
    "0": "\0",
    "\n": "",
    "\r": "",
    "\r\n": "",
    " ": "",
    " ": "",
};

/** Replaces the escape sequences of the template literal content as the cooked string does. */
function cooked(raw: string): string {
    return raw.replace(
        /\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g,
        (escape, code: string) => {
            const hex = /^[ux]\{?([\da-fA-F]+)/.exec(code)?.[1];
            const value = hex ? String.fromCodePoint(parseInt(hex, 16)) : (escapes[code] ?? code);
            return value.padStart(escape.length, " ");
        },
    );
}

/** Returns a WGSL identifier of the length standing for a substitution. */
function placeholder(length: number): string {
    return length === 1 ? "p" : `_p${"_".repeat(length - 2)}`;
}
