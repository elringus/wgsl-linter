import { lex } from "../syntax/lexer.ts";
import { Tok } from "../syntax/token.ts";

export interface FormatOptions {
    /** The text of one indentation level; four spaces by default. */
    readonly indent?: string;
    /**
     * The text to emit the tokens and comments from instead of the formatted one; of the same
     * length, such as the original template content with the substitutions in place of the
     * placeholders.
     */
    readonly source?: string;
}

const noSpaceBefore = new Set([
    Tok.ParenRight,
    Tok.BracketRight,
    Tok.BracketLeft,
    Tok.Comma,
    Tok.Semicolon,
    Tok.Period,
    Tok.Colon,
    Tok.TemplateStart,
    Tok.TemplateEnd,
    Tok.PlusPlus,
    Tok.MinusMinus,
]);

const noSpaceAfter = new Set([
    Tok.ParenLeft,
    Tok.BracketLeft,
    Tok.Period,
    Tok.At,
    Tok.TemplateStart,
]);

/**
 * Formats the WGSL text: indents the lines by the nesting of the brackets, normalizes the
 * spacing between the tokens and the blank lines, keeping the line breaks of the text.
 */
export function format(text: string, options: FormatOptions = {}): string {
    const indent = options.indent ?? "    ";
    const source = options.source ?? text;
    const { count, kinds, starts, ends, comments } = lex(text, []);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    let out = "";
    /** Indentation levels of the lines that opened the unclosed brackets. */
    const brackets: number[] = [];
    let level = 0;
    let lineLevel = 0;
    let previous = Tok.EOF;
    let unary = false;
    let afterComment = false;
    let at = 0;
    const emit = (start: number, end: number, kind: Tok | undefined): void => {
        let lines = 0;
        for (let i = at; i < start; i++) if (text.charCodeAt(i) === 10) lines++;
        if (out.length > 0 && lines > 0) {
            const closing =
                kind === Tok.BraceRight || kind === Tok.ParenRight || kind === Tok.BracketRight;
            lineLevel = closing && brackets.length > 0 ? brackets.at(-1)! : level;
            out += newline.repeat(Math.min(lines, 2)) + indent.repeat(lineLevel);
        } else if (out.length > 0 && space(previous, kind, unary, afterComment)) out += " ";
        const emitted = source.slice(start, end);
        out += kind === undefined && source.startsWith("//", start) ? emitted.trimEnd() : emitted;
        at = end;
    };
    for (let i = 0, comment = 0; i < count; i++) {
        const start = starts[i]!;
        for (; comment < comments.length && comments[comment]! < start; comment += 2) {
            emit(comments[comment]!, comments[comment + 1]!, undefined);
            afterComment = true;
        }
        const kind = kinds[i] as Tok;
        if (kind === Tok.EOF) break;
        emit(start, ends[i]!, kind);
        if (kind === Tok.BraceLeft || kind === Tok.ParenLeft || kind === Tok.BracketLeft) {
            brackets.push(lineLevel);
            level = lineLevel + 1;
        } else if (
            (kind === Tok.BraceRight || kind === Tok.ParenRight || kind === Tok.BracketRight) &&
            brackets.length > 0
        ) {
            brackets.pop();
            level = brackets.length > 0 ? brackets.at(-1)! + 1 : 0;
        }
        unary = isUnary(kind, previous);
        previous = kind;
        afterComment = false;
    }
    return out.length > 0 ? out + newline : out;
}

/** Whether the operator token is a prefix unary operator, judging by the token before it. */
function isUnary(kind: Tok, previous: Tok): boolean {
    if (kind === Tok.Bang || kind === Tok.Tilde) return true;
    if (kind !== Tok.Minus && kind !== Tok.Star && kind !== Tok.And && kind !== Tok.AndAnd)
        return false;
    return !endsOperand(previous);
}

function endsOperand(kind: Tok): boolean {
    return (
        kind === Tok.Ident ||
        (kind >= Tok.Int && kind <= Tok.FloatH) ||
        kind === Tok.True ||
        kind === Tok.False ||
        kind === Tok.ParenRight ||
        kind === Tok.BracketRight ||
        kind === Tok.TemplateEnd ||
        kind === Tok.Underscore
    );
}

/** Whether a space separates the tokens on the same line; the undefined kind is a comment. */
function space(
    previous: Tok,
    next: Tok | undefined,
    unary: boolean,
    afterComment: boolean,
): boolean {
    if (afterComment) return next === undefined || !noSpaceBefore.has(next);
    if (next === undefined) return previous !== Tok.ParenLeft && previous !== Tok.BracketLeft;
    if (noSpaceBefore.has(next) || noSpaceAfter.has(previous) || unary) return false;
    if (next === Tok.ParenLeft) return !endsOperand(previous);
    return true;
}
