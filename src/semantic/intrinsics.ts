import {
    binaryScalar,
    convertScalar,
    f16Max,
    f32Max,
    fail,
    formatScalar,
    map1,
    map2,
    roundFloat,
    unaryScalar,
    type Value,
} from "./eval.ts";
import { ldexp } from "../syntax/literal.ts";
import type { Resolution } from "./overloads.ts";
import { abstractFloat, f32, i32, Kind, scalarOf, type Type, u32 } from "./types.ts";

type Evaluator = (args: readonly Value[], kind: Kind, res: Resolution) => Value;

/** Const-evaluates the builtin function call; returns undefined when it's not const-evaluable. */
export function evaluateBuiltin(
    name: string,
    args: readonly Value[],
    res: Resolution,
): Value | undefined {
    const evaluator = evaluators[name];
    if (!evaluator) return undefined;
    const first = res.params[0];
    return evaluator(args, first ? scalarOf(first).kind : Kind.F32, res);
}

const isFloat = (kind: Kind): boolean =>
    kind === Kind.F32 || kind === Kind.F16 || kind === Kind.AbstractFloat;

/** Rounds the float result to the type, failing when it's not finite. */
const result = (value: number, kind: Kind): number => roundFloat(value, kind);

const add = (kind: Kind, a: Value, b: Value): Value => binaryScalar("+", kind, a, b);
const sub = (kind: Kind, a: Value, b: Value): Value => binaryScalar("-", kind, a, b);
const mul = (kind: Kind, a: Value, b: Value): Value => binaryScalar("*", kind, a, b);
const div = (kind: Kind, a: Value, b: Value): Value => binaryScalar("/", kind, a, b);

function one(kind: Kind, value: number): Value {
    return kind === Kind.AbstractInt ? BigInt(value) : value;
}

function floatFn(f: (x: number) => number, check?: (x: number) => string | undefined): Evaluator {
    return ([e], kind) =>
        map1(e!, x => {
            const message = check?.(x as number);
            if (message) fail(message);
            return result(f(x as number), kind);
        });
}

function intFn(f: (x: number, kind: Kind) => number): Evaluator {
    return ([e], kind) => map1(e!, x => f(x as number, kind));
}

function dot(kind: Kind, a: readonly Value[], b: readonly Value[]): Value {
    let sum: Value | undefined;
    for (let i = 0; i < a.length; i++) {
        const product = mul(kind, a[i]!, b[i]!);
        sum = sum === undefined ? product : add(kind, sum, product);
    }
    return sum!;
}

function length(kind: Kind, v: Value): number {
    if (!Array.isArray(v)) return result(Math.abs(v as number), kind);
    const squared = dot(kind, v, v) as number;
    return result(Math.sqrt(squared), kind);
}

function clamp(kind: Kind, e: Value, low: Value, high: Value): Value {
    if (low > high)
        fail(
            `clamp called with 'low' (${formatScalar(low)}) greater than 'high' (${formatScalar(high)})`,
        );
    const max = e > low ? e : low;
    return max < high ? max : high;
}

function det2(kind: Kind, a: Value, b: Value, c: Value, d: Value): Value {
    return sub(kind, mul(kind, a, d), mul(kind, c, b));
}

function det3(kind: Kind, m: readonly Value[]): Value {
    const [a, b, c, d, e, f, g, h, i] = m;
    const r = sub(
        kind,
        mul(kind, a!, det2(kind, e!, f!, h!, i!)),
        mul(kind, d!, det2(kind, b!, c!, h!, i!)),
    );
    return add(kind, r, mul(kind, g!, det2(kind, b!, c!, e!, f!)));
}

function det4(kind: Kind, m: readonly Value[]): Value {
    const [a, b, c, d, e, f, g, h, i, j, k, l, mm, n, o, p] = m;
    const r1 = sub(
        kind,
        mul(kind, a!, det3(kind, [f!, g!, h!, j!, k!, l!, n!, o!, p!])),
        mul(kind, e!, det3(kind, [b!, c!, d!, j!, k!, l!, n!, o!, p!])),
    );
    const r2 = add(kind, r1, mul(kind, i!, det3(kind, [b!, c!, d!, f!, g!, h!, n!, o!, p!])));
    return sub(kind, r2, mul(kind, mm!, det3(kind, [b!, c!, d!, f!, g!, h!, j!, k!, l!])));
}

/** Returns the value with the bits of the unsigned 32-bit integer reinterpreted as an f32. */
function f32FromBits(bits: number): number {
    scratch.setUint32(0, bits >>> 0);
    return scratch.getFloat32(0);
}

function f32Bits(value: number): number {
    scratch.setFloat32(0, value);
    return scratch.getUint32(0);
}

function f16FromBits(bits: number): number {
    scratch.setUint16(0, bits & 0xffff);
    return scratch.getFloat16(0);
}

function f16Bits(value: number): number {
    scratch.setFloat16(0, value);
    return scratch.getUint16(0);
}

const scratch = new DataView(new ArrayBuffer(8));

function roundHalfEven(x: number): number {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff !== 0.5) return Math.round(x);
    return floor % 2 === 0 ? floor : floor + 1;
}

function countLeading(x: number): number {
    return Math.clz32(x);
}

function countTrailing(x: number): number {
    x >>>= 0;
    if (x === 0) return 32;
    let count = 0;
    while ((x & 1) === 0) {
        x >>>= 1;
        count++;
    }
    return count;
}

function toKind(value: number, kind: Kind): number {
    return kind === Kind.I32 ? value | 0 : value >>> 0;
}

function bitRange(offset: number, count: number): void {
    if (offset > 32 || count > 32 || offset + count > 32)
        fail("'offset' + 'count' must be less than or equal to the bit width of 'e'");
}

function packValues(values: readonly number[], bits: number): number {
    let packed = 0;
    for (let i = 0; i < values.length; i++)
        packed |= (values[i]! & ((1 << bits) - 1)) << (i * bits);
    return packed >>> 0;
}

function bitcastBits(value: Value, from: Type): number[] {
    const elems = Array.isArray(value) ? value : [value];
    const scalar = scalarOf(from);
    const bytes: number[] = [];
    for (const e of elems) {
        let word: number;
        let size = 4;
        switch (scalar.kind) {
            case Kind.AbstractInt:
                word =
                    (e as bigint) < 0n
                        ? (convertScalar(e, scalar, i32) as number) >>> 0
                        : (convertScalar(e, scalar, u32) as number);
                break;
            case Kind.I32:
            case Kind.U32:
                word = (e as number) >>> 0;
                break;
            case Kind.F32:
                word = f32Bits(e as number);
                break;
            default:
                word = f16Bits(e as number);
                size = 2;
        }
        for (let i = 0; i < size; i++) bytes.push((word >>> (8 * i)) & 0xff);
    }
    return bytes;
}

function bitcast(args: readonly Value[], _kind: Kind, res: Resolution): Value {
    const bytes = bitcastBits(args[0]!, res.params[0]!);
    const target = res.result;
    const scalar = scalarOf(target);
    const size = scalar.kind === Kind.F16 ? 2 : 4;
    const out: number[] = [];
    for (let offset = 0; offset < bytes.length; offset += size) {
        let word = 0;
        for (let i = 0; i < size; i++) word |= bytes[offset + i]! << (8 * i);
        word >>>= 0;
        let value: number;
        switch (scalar.kind) {
            case Kind.I32:
                value = word | 0;
                break;
            case Kind.U32:
                value = word;
                break;
            case Kind.F32:
                value = f32FromBits(word);
                break;
            default:
                value = f16FromBits(word);
        }
        if (!Number.isFinite(value))
            fail(`value ${value} cannot be represented as '${scalar.name}'`);
        out.push(value);
    }
    return target.kind === Kind.Vector ? out : out[0]!;
}

const evaluators: Record<string, Evaluator> = {
    abs: ([e], kind) =>
        map1(e!, x => {
            if (kind === Kind.AbstractInt)
                return (x as bigint) < 0n && x !== -(2n ** 63n) ? -(x as bigint) : x;
            if (kind === Kind.I32) return (x as number) === -2147483648 ? x : Math.abs(x as number);
            return Math.abs(x as number);
        }),
    acos: floatFn(Math.acos, x =>
        x < -1 || x > 1
            ? "acos must be called with a value in the range [-1 .. 1] (inclusive)"
            : undefined,
    ),
    acosh: floatFn(Math.acosh, x =>
        x < 1 ? "acosh must be called with a value >= 1.0" : undefined,
    ),
    all: ([e]) => (Array.isArray(e) ? e.every(Boolean) : e!),
    any: ([e]) => (Array.isArray(e) ? e.some(Boolean) : e!),
    asin: floatFn(Math.asin, x =>
        x < -1 || x > 1
            ? "asin must be called with a value in the range [-1 .. 1] (inclusive)"
            : undefined,
    ),
    asinh: floatFn(Math.asinh),
    atan: floatFn(Math.atan),
    atanh: floatFn(Math.atanh, x =>
        x <= -1 || x >= 1
            ? "atanh must be called with a value in the range (-1 .. 1) (exclusive)"
            : undefined,
    ),
    atan2: ([y, x], kind) =>
        map2(y!, x!, (a, b) => result(Math.atan2(a as number, b as number), kind)),
    bitcast,
    ceil: floatFn(Math.ceil),
    clamp: ([e, low, high], kind) => {
        if (!Array.isArray(e)) return clamp(kind, e!, low!, high!);
        return e.map((x, i) => clamp(kind, x, (low as Value[])[i]!, (high as Value[])[i]!));
    },
    cos: floatFn(Math.cos),
    cosh: floatFn(Math.cosh),
    countLeadingZeros: intFn((x, kind) => toKind(countLeading(x >>> 0), kind)),
    countOneBits: intFn((x, kind) => {
        let v = x >>> 0;
        let count = 0;
        while (v) {
            count += v & 1;
            v >>>= 1;
        }
        return toKind(count, kind);
    }),
    countTrailingZeros: intFn((x, kind) => toKind(countTrailing(x), kind)),
    cross: ([u, v], kind) => {
        const [u0, u1, u2] = u as Value[];
        const [v0, v1, v2] = v as Value[];
        return [
            det2(kind, u1!, u2!, v1!, v2!),
            det2(kind, v0!, v2!, u0!, u2!),
            det2(kind, u0!, u1!, v0!, v1!),
        ];
    },
    degrees: ([e], kind) =>
        map1(e!, x => mul(kind, x, div(kind, one(kind, 180), result(Math.PI, kind)))),
    determinant: ([m], kind) => {
        const columns = m as Value[][];
        const n = columns.length;
        const me = (r: number, c: number): Value => columns[c]![r]!;
        const flat: Value[] = [];
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) flat.push(me(c, r));
        if (n === 2) return det2(kind, flat[0]!, flat[1]!, flat[2]!, flat[3]!);
        if (n === 3) return det3(kind, flat);
        return det4(kind, flat);
    },
    distance: ([a, b], kind) =>
        length(
            kind,
            map2(a!, b!, (x, y) => sub(kind, x, y)),
        ),
    dot: ([a, b], kind) => dot(kind, a as Value[], b as Value[]),
    dot4I8Packed: ([a, b]) => {
        let sum = 0;
        for (let i = 0; i < 4; i++)
            sum +=
                ((((a as number) >> (8 * i)) << 24) >> 24) *
                ((((b as number) >> (8 * i)) << 24) >> 24);
        return sum | 0;
    },
    dot4U8Packed: ([a, b]) => {
        let sum = 0;
        for (let i = 0; i < 4; i++)
            sum += (((a as number) >>> (8 * i)) & 0xff) * (((b as number) >>> (8 * i)) & 0xff);
        return sum >>> 0;
    },
    exp: ([e], kind) =>
        map1(e!, x => {
            const value = Math.exp(x as number);
            const rounded =
                kind === Kind.F32
                    ? Math.fround(value)
                    : kind === Kind.F16
                      ? Math.f16round(value)
                      : value;
            if (!Number.isFinite(rounded))
                fail(`e^${formatScalar(x)} cannot be represented as '${floatName(kind)}'`);
            return rounded;
        }),
    exp2: ([e], kind) =>
        map1(e!, x => {
            const value = 2 ** (x as number);
            const rounded =
                kind === Kind.F32
                    ? Math.fround(value)
                    : kind === Kind.F16
                      ? Math.f16round(value)
                      : value;
            if (!Number.isFinite(rounded))
                fail(`2^${formatScalar(x)} cannot be represented as '${floatName(kind)}'`);
            return rounded;
        }),
    extractBits: ([e, offset, count], kind) => {
        const o = offset as number;
        const c = count as number;
        bitRange(o, c);
        return map1(e!, x => {
            const v = (x as number) >>> 0;
            if (c === 0) return 0;
            if (c === 32) return toKind(v, kind);
            let r = (v >>> o) & ((2 ** c - 1) >>> 0);
            if (kind === Kind.I32 && r & (1 << (c - 1))) r |= ~((2 ** c - 1) >>> 0);
            return toKind(r, kind);
        });
    },
    faceForward: ([e1, e2, e3], kind) => {
        const d = dot(kind, e2 as Value[], e3 as Value[]) as number;
        return d < 0 ? e1! : map1(e1!, x => unaryScalar("-", kind, x));
    },
    firstLeadingBit: intFn((x, kind) => {
        if (kind === Kind.U32) return x === 0 ? 0xffffffff : 31 - Math.clz32(x);
        if (x === 0 || x === -1) return -1;
        return 31 - Math.clz32(x < 0 ? ~x : x);
    }),
    firstTrailingBit: intFn((x, kind) => (x === 0 ? toKind(-1, kind) : countTrailing(x))),
    floor: floatFn(Math.floor),
    fma: ([a, b, c], kind) => mapN([a!, b!, c!], ([x, y, z]) => add(kind, mul(kind, x!, y!), z!)),
    fract: ([e], kind) => map1(e!, x => result((x as number) - Math.floor(x as number), kind)),
    frexp: ([e], kind) => {
        const parts = (x: number): [number, Value] => {
            if (x === 0 || !Number.isFinite(x)) return [x, kind === Kind.AbstractFloat ? 0n : 0];
            let exp = Math.floor(Math.log2(Math.abs(x))) + 1;
            let fract = ldexp(x, -exp);
            if (Math.abs(fract) >= 1) {
                fract /= 2;
                exp++;
            } else if (Math.abs(fract) < 0.5) {
                fract *= 2;
                exp--;
            }
            return [result(fract, kind), kind === Kind.AbstractFloat ? BigInt(exp) : exp];
        };
        if (!Array.isArray(e)) return parts(e as number);
        const values = e.map(x => parts(x as number));
        return [values.map(v => v[0]), values.map(v => v[1])];
    },
    insertBits: ([e, newbits, offset, count], kind) => {
        const o = offset as number;
        const c = count as number;
        bitRange(o, c);
        return map2(e!, newbits!, (x, y) => {
            const v = (x as number) >>> 0;
            const n = (y as number) >>> 0;
            if (c === 0) return toKind(v, kind);
            if (c === 32) return toKind(n, kind);
            const mask = (((2 ** c - 1) >>> 0) << o) >>> 0;
            return toKind(((v & ~mask) | ((n << o) & mask)) >>> 0, kind);
        });
    },
    inverseSqrt: ([e], kind) =>
        map1(e!, x => {
            if ((x as number) <= 0) fail("inverseSqrt must be called with a value > 0");
            return div(kind, one(kind, 1), result(Math.sqrt(x as number), kind));
        }),
    ldexp: ([e1, e2], kind, res) => {
        const bias = kind === Kind.F16 ? 15 : kind === Kind.F32 ? 127 : 1023;
        const exponentKind = scalarOf(res.params[1]!).kind;
        return map2(e1!, e2!, (x, y) => {
            const exponent =
                exponentKind === Kind.AbstractInt ? Number(y as bigint) : (y as number);
            if (exponent > bias + 1) fail(`e2 must be less than or equal to ${bias + 1}`);
            return result((x as number) * 2 ** exponent, kind);
        });
    },
    length: ([e], kind) => length(kind, e!),
    log: floatFn(Math.log, x => (x <= 0 ? "log must be called with a value > 0" : undefined)),
    log2: floatFn(Math.log2, x => (x <= 0 ? "log2 must be called with a value > 0" : undefined)),
    max: ([a, b]) => map2(a!, b!, (x, y) => (x > y ? x : y)),
    min: ([a, b]) => map2(a!, b!, (x, y) => (x < y ? x : y)),
    mix: ([a, b, t], kind) =>
        mapN([a!, b!, Array.isArray(a) && !Array.isArray(t) ? a.map(() => t!) : t!], ([x, y, z]) =>
            add(kind, mul(kind, x!, sub(kind, one(kind, 1), z!)), mul(kind, y!, z!)),
        ),
    modf: ([e], kind) => [
        map1(e!, x => result((x as number) - Math.trunc(x as number), kind)),
        map1(e!, x => result(Math.trunc(x as number), kind)),
    ],
    normalize: ([e], kind) => {
        const len = length(kind, e!);
        if (len === 0) fail("zero length vector can not be normalized");
        return map1(e!, x => div(kind, x, len));
    },
    pack2x16float: ([e]) => {
        const halves = (e as number[]).map(x => {
            if (Math.abs(x) > f16Max)
                fail(`value ${formatScalar(x)} cannot be represented as 'f16'`);
            return f16Bits(Math.f16round(x));
        });
        return packValues(halves, 16);
    },
    pack2x16snorm: ([e]) =>
        packValues(
            (e as number[]).map(x => Math.floor(0.5 + 32767 * Math.min(Math.max(x, -1), 1))),
            16,
        ),
    pack2x16unorm: ([e]) =>
        packValues(
            (e as number[]).map(x => Math.floor(0.5 + 65535 * Math.min(Math.max(x, 0), 1))),
            16,
        ),
    pack4x8snorm: ([e]) =>
        packValues(
            (e as number[]).map(x => Math.floor(0.5 + 127 * Math.min(Math.max(x, -1), 1))),
            8,
        ),
    pack4x8unorm: ([e]) =>
        packValues(
            (e as number[]).map(x => Math.floor(0.5 + 255 * Math.min(Math.max(x, 0), 1))),
            8,
        ),
    pack4xI8: ([e]) => packValues(e as number[], 8),
    pack4xU8: ([e]) => packValues(e as number[], 8),
    pack4xI8Clamp: ([e]) =>
        packValues(
            (e as number[]).map(x => Math.min(Math.max(x, -128), 127)),
            8,
        ),
    pack4xU8Clamp: ([e]) =>
        packValues(
            (e as number[]).map(x => Math.min(Math.max(x, 0), 255)),
            8,
        ),
    pow: ([a, b], kind) =>
        map2(a!, b!, (x, y) => {
            const base = x as number;
            const exp = y as number;
            const value = Math.pow(base, exp);
            const rounded =
                kind === Kind.F32
                    ? Math.fround(value)
                    : kind === Kind.F16
                      ? Math.f16round(value)
                      : value;
            if (base < 0 || (base === 0 && exp <= 0) || !Number.isFinite(rounded))
                fail(
                    `'${formatScalar(base)} ^ ${formatScalar(exp)}' cannot be represented as '${floatName(kind)}'`,
                );
            return rounded;
        }),
    quantizeToF16: ([e]) =>
        map1(e!, x => {
            if (Math.abs(x as number) > f16Max)
                fail(`value ${formatScalar(x)} cannot be represented as 'f16'`);
            return Math.f16round(x as number);
        }),
    radians: ([e], kind) =>
        map1(e!, x => mul(kind, x, div(kind, result(Math.PI, kind), one(kind, 180)))),
    reflect: ([e1, e2], kind) => {
        const d = dot(kind, e2 as Value[], e1 as Value[]);
        const scaled = result(2 * (d as number), kind);
        return map2(e1!, e2!, (x, y) => sub(kind, x, mul(kind, scaled, y)));
    },
    refract: ([e1, e2, e3], kind) => {
        const d = dot(kind, e2 as Value[], e1 as Value[]);
        const eta = e3!;
        const k = sub(
            kind,
            one(kind, 1),
            mul(kind, mul(kind, eta, eta), sub(kind, one(kind, 1), mul(kind, d, d))),
        ) as number;
        if (k < 0) return (e1 as Value[]).map(() => 0);
        const scale = add(kind, mul(kind, eta, d), result(Math.sqrt(k), kind));
        return map2(e1!, e2!, (x, y) => sub(kind, mul(kind, eta, x), mul(kind, scale, y)));
    },
    reverseBits: intFn((x, kind) => {
        let v = x >>> 0;
        let r = 0;
        for (let i = 0; i < 32; i++) {
            r = (r << 1) | (v & 1);
            v >>>= 1;
        }
        return toKind(r, kind);
    }),
    round: floatFn(roundHalfEven),
    saturate: floatFn(x => Math.min(Math.max(x, 0), 1)),
    select: ([f, t, c]) => {
        if (Array.isArray(c)) return (f as Value[]).map((x, i) => (c[i] ? (t as Value[])[i]! : x));
        return c ? t! : f!;
    },
    sign: ([e], kind) =>
        map1(e!, x => {
            if (kind === Kind.AbstractInt)
                return (x as bigint) > 0n ? 1n : (x as bigint) < 0n ? -1n : 0n;
            return (x as number) > 0 ? 1 : (x as number) < 0 ? -1 : 0;
        }),
    sin: floatFn(Math.sin),
    sinh: floatFn(Math.sinh),
    smoothstep: ([low, high, x], kind) =>
        mapN([low!, high!, x!], ([l, h, v]) => {
            if (l === h)
                fail(
                    `smoothstep called with 'low' (${formatScalar(l!)}) equal to 'high' (${formatScalar(h!)})`,
                );
            const t0 = div(kind, sub(kind, v!, l!), sub(kind, h!, l!)) as number;
            const t = Math.min(Math.max(t0, 0), 1);
            return mul(kind, mul(kind, t, t), sub(kind, 3, mul(kind, 2, t)));
        }),
    sqrt: floatFn(Math.sqrt, x => (x < 0 ? "sqrt must be called with a value >= 0" : undefined)),
    step: ([edge, x]) => map2(edge!, x!, (e, v) => ((v as number) < (e as number) ? 0 : 1)),
    tan: floatFn(Math.tan),
    tanh: floatFn(Math.tanh),
    transpose: ([m]) => {
        const columns = m as Value[][];
        const rows = columns[0]!.length;
        return Array.from({ length: rows }, (_, r) => columns.map(c => c[r]!));
    },
    trunc: floatFn(Math.trunc),
    unpack2x16float: ([e]) =>
        [0, 1].map(i => {
            const value = f16FromBits((e as number) >>> (16 * i));
            if (!Number.isFinite(value)) fail(`value ${value} cannot be represented as 'f32'`);
            return value;
        }),
    unpack2x16snorm: ([e]) =>
        [0, 1].map(i =>
            Math.fround(Math.max(((((e as number) >>> (16 * i)) << 16) >> 16) / 32767, -1)),
        ),
    unpack2x16unorm: ([e]) =>
        [0, 1].map(i => Math.fround((((e as number) >>> (16 * i)) & 0xffff) / 65535)),
    unpack4x8snorm: ([e]) =>
        [0, 1, 2, 3].map(i =>
            Math.fround(Math.max(((((e as number) >>> (8 * i)) << 24) >> 24) / 127, -1)),
        ),
    unpack4x8unorm: ([e]) =>
        [0, 1, 2, 3].map(i => Math.fround((((e as number) >>> (8 * i)) & 0xff) / 255)),
    unpack4xI8: ([e]) => [0, 1, 2, 3].map(i => (((e as number) >>> (8 * i)) << 24) >> 24),
    unpack4xU8: ([e]) => [0, 1, 2, 3].map(i => ((e as number) >>> (8 * i)) & 0xff),
};

function mapN(values: readonly Value[], f: (components: Value[]) => Value): Value {
    const first = values[0]!;
    if (!Array.isArray(first)) return f(values as Value[]);
    return first.map((_, i) =>
        mapN(
            values.map(v => (v as Value[])[i]!),
            f,
        ),
    );
}

function floatName(kind: Kind): string {
    return kind === Kind.F32 ? "f32" : kind === Kind.F16 ? "f16" : "abstract-float";
}

void isFloat;
void f32Max;
void abstractFloat;
void f32;
