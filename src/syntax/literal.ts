import { Tok } from "./token.ts";

/** End offset of the literal scanned by the last {@link scanNumber} call. */
export let scannedEnd = 0;
/** Error message of the literal scanned by the last {@link scanNumber} call, or empty. */
export let scannedError = "";

/** Scans the numeric literal starting at the offset and returns its token kind. */
export function scanNumber(text: string, pos: number): Tok {
    scannedError = "";
    const c1 = text.charCodeAt(pos + 1);
    if (text.charCodeAt(pos) === 48 && (c1 === 120 || c1 === 88)) return scanHex(text, pos);
    return scanDecimal(text, pos);
}

function scanDecimal(text: string, pos: number): Tok {
    let p = skipDigits(text, pos);
    let float = false;
    if (text.charCodeAt(p) === 46) {
        float = true;
        p = skipDigits(text, p + 1);
    }
    let c = text.charCodeAt(p);
    if (c === 101 || c === 69) {
        float = true;
        p++;
        c = text.charCodeAt(p);
        if (c === 43 || c === 45) p++;
        const digits = skipDigits(text, p);
        if (digits === p) return fail(p, "incomplete exponent for floating point literal");
        p = digits;
        c = text.charCodeAt(p);
    }
    if (c === 102 || c === 104) {
        scannedEnd = p + 1;
        return check(text, pos, c === 102 ? Tok.FloatF : Tok.FloatH);
    }
    if (float) {
        scannedEnd = p;
        return check(text, pos, Tok.Float);
    }
    if (text.charCodeAt(pos) === 48 && p > pos + 1)
        return fail(p, "integer literal cannot have leading 0s");
    return scanIntSuffix(text, pos, p);
}

function scanHex(text: string, pos: number): Tok {
    let p = skipHexDigits(text, pos + 2);
    let digits = p > pos + 2;
    let float = false;
    if (text.charCodeAt(p) === 46) {
        float = true;
        const end = skipHexDigits(text, p + 1);
        digits ||= end > p + 1;
        p = end;
    }
    if (!digits) return fail(pos + 2, "integer or float hex literal has no significant digits");
    const c = text.charCodeAt(p);
    if (c === 112 || c === 80) {
        p++;
        const s = text.charCodeAt(p);
        if (s === 43 || s === 45) p++;
        const exp = skipDigits(text, p);
        if (exp === p) return fail(p, "expected an exponent value for hex float");
        p = exp;
        const suffix = text.charCodeAt(p);
        if (suffix === 102 || suffix === 104) {
            scannedEnd = p + 1;
            return check(text, pos, suffix === 102 ? Tok.FloatF : Tok.FloatH);
        }
        scannedEnd = p;
        return check(text, pos, Tok.Float);
    }
    if (float) {
        scannedEnd = p;
        return check(text, pos, Tok.Float);
    }
    return scanIntSuffix(text, pos, p);
}

function scanIntSuffix(text: string, pos: number, p: number): Tok {
    const c = text.charCodeAt(p);
    if (c === 105 || c === 117) {
        scannedEnd = p + 1;
        return check(text, pos, c === 105 ? Tok.IntI : Tok.IntU);
    }
    scannedEnd = p;
    return check(text, pos, Tok.Int);
}

function check(text: string, pos: number, kind: Tok): Tok {
    const literal = text.slice(pos, scannedEnd);
    if (kind <= Tok.IntU) {
        const max =
            kind === Tok.Int ? 0x7fffffffffffffffn : kind === Tok.IntI ? 0x7fffffffn : 0xffffffffn;
        if (intValue(literal) > max)
            scannedError = `value cannot be represented as '${intTypeName(kind)}'`;
        return kind;
    }
    if (kind === Tok.Float) {
        if (!Number.isFinite(floatValue(literal)))
            scannedError = "value cannot be represented as 'abstract-float'";
        return kind;
    }
    const name = kind === Tok.FloatF ? "f32" : "f16";
    if (isHex(literal)) {
        const [mantissa, exponent] = hexFloatParts(literal);
        const representable =
            kind === Tok.FloatF
                ? fits(mantissa, exponent, 24, 127, -149)
                : fits(mantissa, exponent, 11, 15, -24);
        if (representable === 1) scannedError = `value cannot be represented as '${name}'`;
        else if (representable === 2)
            scannedError = `value cannot be exactly represented as '${name}'`;
        return kind;
    }
    const max = kind === Tok.FloatF ? 3.4028234663852886e38 : 65504;
    if (!(Math.abs(floatValue(literal)) <= max))
        scannedError = `value cannot be represented as '${name}'`;
    return kind;
}

function intTypeName(kind: Tok): string {
    return kind === Tok.Int ? "abstract-int" : kind === Tok.IntI ? "i32" : "u32";
}

/** Returns 0 when the value fits exactly, 1 when it overflows and 2 when it's inexact. */
function fits(
    mantissa: bigint,
    exponent: number,
    bits: number,
    maxExp: number,
    minExp: number,
): number {
    if (mantissa === 0n) return 0;
    while ((mantissa & 1n) === 0n) {
        mantissa >>= 1n;
        exponent++;
    }
    const length = mantissa.toString(2).length;
    const top = exponent + length - 1;
    if (top > maxExp) return 1;
    return length > bits || exponent < minExp ? 2 : 0;
}

function fail(end: number, message: string): Tok {
    scannedEnd = end;
    scannedError = message;
    return Tok.Invalid;
}

function skipDigits(text: string, p: number): number {
    for (let c = text.charCodeAt(p); c >= 48 && c <= 57; c = text.charCodeAt(++p));
    return p;
}

function skipHexDigits(text: string, p: number): number {
    for (let c = text.charCodeAt(p); isHexDigit(c); c = text.charCodeAt(++p));
    return p;
}

function isHexDigit(c: number): boolean {
    return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

function isHex(literal: string): boolean {
    const c = literal.charCodeAt(1);
    return c === 120 || c === 88;
}

function stripSuffix(literal: string): string {
    const c = literal.charCodeAt(literal.length - 1);
    if (c === 105 || c === 117) return literal.slice(0, -1);
    if ((c === 102 || c === 104) && !(isHex(literal) && !/[pP]/.test(literal)))
        return literal.slice(0, -1);
    return literal;
}

/** Returns the value of an integer literal. */
export function intValue(literal: string): bigint {
    return BigInt(stripSuffix(literal));
}

/** Returns the value of a floating point literal, rounded to the nearest double. */
export function floatValue(literal: string): number {
    if (!isHex(literal)) return Number(stripSuffix(literal));
    const [mantissa, exponent] = hexFloatParts(literal);
    return toDouble(mantissa, exponent);
}

function hexFloatParts(literal: string): [bigint, number] {
    let mantissa = 0n;
    let exponent = 0;
    let p = 2;
    let fraction = false;
    for (; p < literal.length; p++) {
        const c = literal.charCodeAt(p);
        if (c === 46) {
            fraction = true;
            continue;
        }
        if (!isHexDigit(c)) break;
        mantissa = mantissa * 16n + BigInt(parseInt(literal[p]!, 16));
        if (fraction) exponent -= 4;
    }
    if (p < literal.length) exponent += parseInt(literal.slice(p + 1).replace(/[fh]$/, ""), 10);
    return [mantissa, exponent];
}

function toDouble(mantissa: bigint, exponent: number): number {
    if (mantissa === 0n) return 0;
    const length = mantissa.toString(2).length;
    if (length > 64) {
        const shift = length - 64;
        mantissa >>= BigInt(shift);
        exponent += shift;
    }
    return ldexp(Number(mantissa), exponent);
}

/** Multiplies the value by 2 to the power of the exponent without intermediate overflow. */
export function ldexp(value: number, exponent: number): number {
    if (exponent > 2200) return value * Infinity;
    if (exponent < -2200) return 0;
    while (exponent > 1000) {
        value *= 2 ** 1000;
        exponent -= 1000;
    }
    while (exponent < -1000) {
        value *= 2 ** -1000;
        exponent += 1000;
    }
    return value * 2 ** exponent;
}
