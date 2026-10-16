import type { Diagnostic } from "./diagnostic.ts";
import { scanNumber, scannedEnd, scannedError } from "./literal.ts";
import { keywords, Tok } from "./token.ts";

/** Tokens of a source text stored in flat arrays, terminated with an {@link Tok.EOF} token. */
export interface Tokens {
    readonly count: number;
    readonly kinds: Uint8Array;
    readonly starts: Uint32Array;
    readonly ends: Uint32Array;
    /** Start and end offsets of the comments, in pairs. */
    readonly comments: readonly number[];
}

const xidStart = /\p{XID_Start}/u;
const xidContinue = /\p{XID_Continue}/u;

/**
 * Splits the text into tokens, discovering the template lists on the way:
 * the delimiting `<` and `>` are reported as {@link Tok.TemplateStart} and {@link Tok.TemplateEnd}.
 */
export function lex(text: string, diagnostics: Diagnostic[]): Tokens {
    const length = text.length;
    let capacity = (length >> 2) + 16;
    let kinds = new Uint8Array(capacity);
    let starts = new Uint32Array(capacity);
    let ends = new Uint32Array(capacity);
    let count = 0;
    const comments: number[] = [];
    const pending: number[] = [];
    let depth = 0;
    let pos = 0;

    const push = (kind: Tok, start: number, end: number): void => {
        if (count === capacity) {
            capacity *= 2;
            kinds = grow(kinds, new Uint8Array(capacity));
            starts = grow(starts, new Uint32Array(capacity));
            ends = grow(ends, new Uint32Array(capacity));
        }
        kinds[count] = kind;
        starts[count] = start;
        ends[count++] = end;
    };
    const error = (start: number, end: number, message: string): void => {
        diagnostics.push({ start, end, severity: "error", message });
    };
    const popPending = (): void => {
        while (pending.length > 0 && pending[pending.length - 1]! === depth) pending.length -= 2;
    };

    while (true) {
        pos = skipTrivia(text, pos, comments, error);
        if (pos >= length) break;
        const start = pos;
        const c = text.charCodeAt(pos);
        const n = text.charCodeAt(pos + 1);
        if ((c >= 48 && c <= 57) || (c === 46 && n >= 48 && n <= 57)) {
            const kind = scanNumber(text, pos);
            pos = scannedEnd;
            if (scannedError) error(start, pos, scannedError);
            push(kind, start, pos);
            continue;
        }
        if (isIdentStart(c, text, pos)) {
            pos = skipIdent(text, pos);
            if (pos === start + 1 && c === 95) {
                push(Tok.Underscore, start, pos);
                continue;
            }
            const word = text.slice(start, pos);
            if (c === 95 && n === 95)
                error(start, pos, "identifiers must not start with two underscores");
            push(keywords.get(word) ?? Tok.Ident, start, pos);
            continue;
        }
        let kind: Tok;
        switch (c) {
            case 64:
                kind = Tok.At;
                break;
            case 40:
                depth++;
                kind = Tok.ParenLeft;
                break;
            case 41:
                popPending();
                if (depth > 0) depth--;
                kind = Tok.ParenRight;
                break;
            case 91:
                depth++;
                kind = Tok.BracketLeft;
                break;
            case 93:
                popPending();
                if (depth > 0) depth--;
                kind = Tok.BracketRight;
                break;
            case 123:
                depth = pending.length = 0;
                kind = Tok.BraceLeft;
                break;
            case 125:
                kind = Tok.BraceRight;
                break;
            case 38:
                if (n === 38) {
                    popPending();
                    kind = Tok.AndAnd;
                    pos++;
                } else if (n === 61) {
                    kind = Tok.AndEqual;
                    pos++;
                } else kind = Tok.And;
                break;
            case 47:
                if (n === 61) {
                    kind = Tok.SlashEqual;
                    pos++;
                } else kind = Tok.Slash;
                break;
            case 33:
                if (n === 61) {
                    kind = Tok.NotEqual;
                    pos++;
                } else kind = Tok.Bang;
                break;
            case 58:
                depth = pending.length = 0;
                kind = Tok.Colon;
                break;
            case 44:
                kind = Tok.Comma;
                break;
            case 61:
                if (n === 61) {
                    kind = Tok.EqualEqual;
                    pos++;
                } else {
                    depth = pending.length = 0;
                    kind = Tok.Equal;
                }
                break;
            case 62:
                if (pending.length > 0 && pending[pending.length - 1] === depth) {
                    kinds[pending[pending.length - 2]!] = Tok.TemplateStart;
                    pending.length -= 2;
                    kind = Tok.TemplateEnd;
                } else if (n === 61) {
                    kind = Tok.GreaterEqual;
                    pos++;
                } else if (n === 62) {
                    if (text.charCodeAt(pos + 2) === 61) {
                        kind = Tok.ShiftRightEqual;
                        pos += 2;
                    } else {
                        kind = Tok.ShiftRight;
                        pos++;
                    }
                } else kind = Tok.Greater;
                break;
            case 60:
                if (n === 61) {
                    kind = Tok.LessEqual;
                    pos++;
                } else if (n === 60) {
                    if (text.charCodeAt(pos + 2) === 61) {
                        kind = Tok.ShiftLeftEqual;
                        pos += 2;
                    } else {
                        kind = Tok.ShiftLeft;
                        pos++;
                    }
                } else {
                    const prev = count > 0 ? kinds[count - 1] : Tok.EOF;
                    if (prev === Tok.Ident || prev === Tok.Var) pending.push(count, depth);
                    kind = Tok.Less;
                }
                break;
            case 37:
                if (n === 61) {
                    kind = Tok.PercentEqual;
                    pos++;
                } else kind = Tok.Percent;
                break;
            case 45:
                if (n === 62) {
                    kind = Tok.Arrow;
                    pos++;
                } else if (n === 45) {
                    kind = Tok.MinusMinus;
                    pos++;
                } else if (n === 61) {
                    kind = Tok.MinusEqual;
                    pos++;
                } else kind = Tok.Minus;
                break;
            case 46:
                kind = Tok.Period;
                break;
            case 43:
                if (n === 43) {
                    kind = Tok.PlusPlus;
                    pos++;
                } else if (n === 61) {
                    kind = Tok.PlusEqual;
                    pos++;
                } else kind = Tok.Plus;
                break;
            case 124:
                if (n === 124) {
                    popPending();
                    kind = Tok.OrOr;
                    pos++;
                } else if (n === 61) {
                    kind = Tok.OrEqual;
                    pos++;
                } else kind = Tok.Or;
                break;
            case 59:
                depth = pending.length = 0;
                kind = Tok.Semicolon;
                break;
            case 42:
                if (n === 61) {
                    kind = Tok.StarEqual;
                    pos++;
                } else kind = Tok.Star;
                break;
            case 126:
                kind = Tok.Tilde;
                break;
            case 94:
                if (n === 61) {
                    kind = Tok.XorEqual;
                    pos++;
                } else kind = Tok.Xor;
                break;
            default: {
                const code = text.codePointAt(pos)!;
                pos += code > 0xffff ? 1 : 0;
                error(
                    start,
                    pos + 1,
                    code === 0 ? "null character found" : "invalid character found",
                );
                kind = Tok.Invalid;
            }
        }
        push(kind, start, ++pos);
    }
    push(Tok.EOF, length, length);
    return { count, kinds, starts, ends, comments };
}

function grow<T extends Uint8Array | Uint32Array>(from: T, to: T): T {
    to.set(from);
    return to;
}

function skipTrivia(
    text: string,
    pos: number,
    comments: number[],
    error: (start: number, end: number, message: string) => void,
): number {
    const length = text.length;
    while (pos < length) {
        const c = text.charCodeAt(pos);
        if (isBlank(c)) {
            pos++;
            continue;
        }
        if (c !== 47) return pos;
        const n = text.charCodeAt(pos + 1);
        if (n === 47) {
            const start = pos;
            pos += 2;
            for (
                let c = text.charCodeAt(pos);
                pos < length && !isLineBreak(c);
                c = text.charCodeAt(++pos)
            )
                if (c === 0) error(pos, pos + 1, "null character found");
            comments.push(start, pos);
            continue;
        }
        if (n !== 42) return pos;
        const start = pos;
        let nesting = 1;
        pos += 2;
        while (pos < length && nesting > 0) {
            const a = text.charCodeAt(pos);
            const b = text.charCodeAt(pos + 1);
            if (a === 47 && b === 42) {
                nesting++;
                pos += 2;
            } else if (a === 42 && b === 47) {
                nesting--;
                pos += 2;
            } else {
                if (a === 0) error(pos, pos + 1, "null character found");
                pos++;
            }
        }
        comments.push(start, pos);
        if (nesting > 0) error(start, start + 2, "unterminated block comment");
    }
    return pos;
}

/** Whether the character is a blankspace (Unicode Pattern_White_Space). */
export function isBlank(c: number): boolean {
    return (
        c === 32 ||
        (c >= 9 && c <= 13) ||
        c === 0x85 ||
        c === 0x200e ||
        c === 0x200f ||
        c === 0x2028 ||
        c === 0x2029
    );
}

/** Whether the character is a line break. */
export function isLineBreak(c: number): boolean {
    return (c >= 10 && c <= 13) || c === 0x85 || c === 0x2028 || c === 0x2029;
}

function isIdentStart(c: number, text: string, pos: number): boolean {
    if (c < 128) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
    return xidStart.test(String.fromCodePoint(text.codePointAt(pos)!));
}

function skipIdent(text: string, pos: number): number {
    const length = text.length;
    pos += text.codePointAt(pos)! > 0xffff ? 2 : 1;
    while (pos < length) {
        const c = text.charCodeAt(pos);
        if (c < 128) {
            if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95)
                pos++;
            else break;
            continue;
        }
        const code = text.codePointAt(pos)!;
        if (!xidContinue.test(String.fromCodePoint(code))) break;
        pos += code > 0xffff ? 2 : 1;
    }
    return pos;
}
