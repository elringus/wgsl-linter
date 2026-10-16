import { Kind, scalarOf, type Type, typeName } from "./types.ts";

/**
 * Value of a const-expression: abstract-int scalars are bigints, other numeric scalars are
 * numbers already rounded to their type, and composites are arrays of their components
 * (matrices are arrays of columns).
 */
export type Value = number | bigint | boolean | readonly Value[];

/** Error raised when const-evaluation fails, reported as a shader-creation error. */
export class EvalError extends Error {}

const i64Min = -(2n ** 63n);
const i64Max = 2n ** 63n - 1n;
export const f32Max = 3.4028234663852886e38;
export const f16Max = 65504;

export function fail(message: string): never {
    throw new EvalError(message);
}

/** Rounds the number to the floating point type, failing when the result isn't finite. */
export function roundFloat(value: number, kind: Kind, describe?: () => string): number {
    const rounded =
        kind === Kind.F32 ? Math.fround(value) : kind === Kind.F16 ? Math.f16round(value) : value;
    if (!Number.isFinite(rounded))
        fail(
            describe
                ? `${describe()} cannot be represented as '${floatName(kind)}'`
                : `value ${value} cannot be represented as '${floatName(kind)}'`,
        );
    return rounded;
}

function floatName(kind: Kind): string {
    return kind === Kind.F32 ? "f32" : kind === Kind.F16 ? "f16" : "abstract-float";
}

function checkInt(value: bigint, describe: () => string): bigint {
    if (value < i64Min || value > i64Max)
        fail(`${describe()} cannot be represented as 'abstract-int'`);
    return value;
}

/** Formats the scalar value for the diagnostic messages. */
export function formatScalar(value: Value): string {
    if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
    return String(value);
}

/** Returns the zero value of the type. */
export function zeroValue(type: Type): Value {
    switch (type.kind) {
        case Kind.Bool:
            return false;
        case Kind.AbstractInt:
            return 0n;
        case Kind.Vector:
        case Kind.Array:
            return Array.from({ length: Math.max(type.count, 0) }, () => zeroValue(type.elem!));
        case Kind.Matrix:
            return Array.from({ length: type.count }, () =>
                Array.from({ length: type.rows }, () => zeroValue(type.elem!)),
            );
        case Kind.Struct:
            return type.members.map(m => zeroValue(m.type));
        default:
            return 0;
    }
}

/** Converts the scalar value between the scalar types, as the value conversion builtins do. */
export function convertScalar(value: Value, from: Type, to: Type): Value {
    if (from === to) return value;
    const target = to.kind;
    if (target === Kind.Bool)
        return typeof value === "bigint" ? value !== 0n : value !== 0 && value !== false;
    if (typeof value === "boolean") {
        if (target === Kind.AbstractInt) return value ? 1n : 0n;
        return value ? 1 : 0;
    }
    const failure = (): never =>
        fail(`value ${formatScalar(value)} cannot be represented as '${typeName(to)}'`);
    switch (target) {
        case Kind.AbstractInt: {
            if (typeof value === "bigint") return value;
            if (!Number.isFinite(value as number)) return failure();
            const truncated = BigInt(Math.trunc(value as number));
            return truncated < i64Min || truncated > i64Max ? failure() : truncated;
        }
        case Kind.AbstractFloat:
            return Number(value);
        case Kind.I32:
        case Kind.U32: {
            const min = target === Kind.I32 ? -2147483648 : 0;
            if (typeof value === "bigint") {
                const max = target === Kind.I32 ? 2147483647n : 4294967295n;
                return value >= BigInt(min) && value <= max ? Number(value) : failure();
            }
            if (from.kind === Kind.I32 || from.kind === Kind.U32)
                return target === Kind.I32 ? (value as number) | 0 : (value as number) >>> 0;
            if (Number.isNaN(value)) return 0;
            const max = floatToIntMax(from.kind, target);
            const truncated = Math.trunc(value as number);
            return truncated < min ? min : truncated > max ? max : truncated + 0;
        }
        case Kind.F32:
        case Kind.F16: {
            const number = Number(value);
            const max = target === Kind.F32 ? f32Max : f16Max;
            if (!(Math.abs(number) <= max)) return failure();
            return target === Kind.F32 ? Math.fround(number) : Math.f16round(number);
        }
        default:
            return value;
    }
}

/**
 * Returns the largest value of the integer type exactly representable in the floating point
 * type: the bound the conversions clamp the floats to.
 */
function floatToIntMax(from: Kind, to: Kind): number {
    if (from === Kind.F32) return to === Kind.I32 ? 2147483520 : 4294967040;
    return to === Kind.I32 ? 2147483647 : 4294967295;
}

/** Converts the value between the types of the same shape, such as when materializing. */
export function convertValue(value: Value, from: Type, to: Type): Value {
    if (from === to) return value;
    if (from.kind === Kind.Struct) {
        const values = value as readonly Value[];
        return to.members.map((m, i) => convertValue(values[i]!, from.members[i]!.type, m.type));
    }
    const fromScalar = scalarOf(from);
    const toScalar = scalarOf(to);
    return map1(value, v => convertScalar(v, fromScalar, toScalar));
}

// ---- operators ----

/** Applies the function to the components of the values, broadcasting the scalars to vectors. */
export function map2(a: Value, b: Value, f: (a: Value, b: Value) => Value): Value {
    if (Array.isArray(a)) {
        if (Array.isArray(b)) return a.map((x, i) => map2(x, b[i]!, f));
        return a.map(x => map2(x, b, f));
    }
    if (Array.isArray(b)) return b.map(y => map2(a, y, f));
    return f(a, b);
}

export function map1(a: Value, f: (a: Value) => Value): Value {
    return Array.isArray(a) ? a.map(x => map1(x, f)) : f(a);
}

/** Evaluates the binary operator on scalars of the given scalar type. */
export function binaryScalar(op: string, kind: Kind, a: Value, b: Value): Value {
    const describe = (): string => `'${formatScalar(a)} ${op} ${formatScalar(b)}'`;
    switch (op) {
        case "==":
            return a === b;
        case "!=":
            return a !== b;
        case "<":
            return (a as number) < (b as number);
        case "<=":
            return (a as number) <= (b as number);
        case ">":
            return (a as number) > (b as number);
        case ">=":
            return (a as number) >= (b as number);
        case "&&":
        case "&":
            if (kind === Kind.Bool) return (a as boolean) && (b as boolean);
            return kind === Kind.AbstractInt
                ? (a as bigint) & (b as bigint)
                : intOf(kind, (a as number) & (b as number));
        case "||":
        case "|":
            if (kind === Kind.Bool) return (a as boolean) || (b as boolean);
            return kind === Kind.AbstractInt
                ? (a as bigint) | (b as bigint)
                : intOf(kind, (a as number) | (b as number));
        case "^":
            return kind === Kind.AbstractInt
                ? (a as bigint) ^ (b as bigint)
                : intOf(kind, (a as number) ^ (b as number));
        case "<<":
            return shiftLeft(kind, a, b as number, describe);
        case ">>":
            return shiftRight(kind, a, b as number);
    }
    switch (kind) {
        case Kind.AbstractInt: {
            const x = a as bigint;
            const y = b as bigint;
            switch (op) {
                case "+":
                    return checkInt(x + y, describe);
                case "-":
                    return checkInt(x - y, describe);
                case "*":
                    return checkInt(x * y, describe);
                case "/":
                    if (y === 0n || (x === i64Min && y === -1n))
                        fail(`${describe()} cannot be represented as 'abstract-int'`);
                    return x / y;
                case "%":
                    if (y === 0n || (x === i64Min && y === -1n))
                        fail(`${describe()} cannot be represented as 'abstract-int'`);
                    return x % y;
            }
            break;
        }
        case Kind.I32:
        case Kind.U32: {
            const x = a as number;
            const y = b as number;
            switch (op) {
                case "+":
                    return intOf(kind, x + y);
                case "-":
                    return intOf(kind, x - y);
                case "*":
                    return intOf(kind, Math.imul(x, y));
                case "/":
                case "%": {
                    const name = kind === Kind.I32 ? "i32" : "u32";
                    if (y === 0 || (kind === Kind.I32 && x === -2147483648 && y === -1))
                        fail(`${describe()} cannot be represented as '${name}'`);
                    return intOf(kind, op === "/" ? Math.trunc(x / y) : x % y);
                }
            }
            break;
        }
        default: {
            const x = a as number;
            const y = b as number;
            const name = floatName(kind);
            const result = (r: number): number => roundFloat(r, kind, describe);
            switch (op) {
                case "+":
                    return result(x + y);
                case "-":
                    return result(x - y);
                case "*":
                    return result(x * y);
                case "/":
                    if (y === 0) fail(`${describe()} cannot be represented as '${name}'`);
                    return result(x / y);
                case "%":
                    if (y === 0) fail(`${describe()} cannot be represented as '${name}'`);
                    return result(x % y);
            }
        }
    }
    throw new Error(`unknown operator ${op}`);
}

function intOf(kind: Kind, value: number): number {
    return kind === Kind.I32 ? value | 0 : value >>> 0;
}

function shiftLeft(kind: Kind, a: Value, shift: number, describe: () => string): Value {
    if (kind === Kind.AbstractInt) {
        const x = a as bigint;
        if (shift >= 64) {
            if (x !== 0n) fail(`${describe()} cannot be represented as 'abstract-int'`);
            return 0n;
        }
        const mask = BigInt.asUintN(64, -1n << BigInt(64 - shift - 1));
        const bits = BigInt.asUintN(64, x) & mask;
        if (bits !== 0n && bits !== mask) fail("shift left operation results in sign change");
        return BigInt.asIntN(64, x << BigInt(shift));
    }
    if (shift >= 32)
        fail("shift left value must be less than the bit width of the lhs, which is 32");
    const x = (a as number) >>> 0;
    if (kind === Kind.I32) {
        const mask = (0xffffffff << (32 - shift - 1)) >>> 0;
        const bits = (x & mask) >>> 0;
        if (bits !== 0 && bits !== mask) fail("shift left operation results in sign change");
        return (x << shift) | 0;
    }
    if (shift > 0 && (x & ((0xffffffff << (32 - shift)) >>> 0)) >>> 0 !== 0)
        fail(`${describe()} cannot be represented as 'u32'`);
    return (x << shift) >>> 0;
}

function shiftRight(kind: Kind, a: Value, shift: number): Value {
    if (kind === Kind.AbstractInt) {
        const x = a as bigint;
        if (shift >= 64) return x < 0n ? -1n : 0n;
        return x >> BigInt(shift);
    }
    if (shift >= 32)
        fail("shift right value must be less than the bit width of the lhs, which is 32");
    return kind === Kind.I32 ? (a as number) >> shift : (a as number) >>> shift;
}

/** Evaluates the unary operator on a scalar of the given scalar type. */
export function unaryScalar(op: string, kind: Kind, a: Value): Value {
    switch (op) {
        case "!":
            return !(a as boolean);
        case "~":
            return kind === Kind.AbstractInt ? ~(a as bigint) : intOf(kind, ~(a as number));
        default:
            if (kind === Kind.AbstractInt) return a === i64Min ? a : -(a as bigint);
            if (kind === Kind.I32) return -(a as number) | 0;
            return -(a as number);
    }
}

/** Multiplies the matrices, matrix and vector or vector and matrix. */
export function multiplyLinear(a: Value, aType: Type, b: Value, bType: Type, kind: Kind): Value {
    const add = (x: number, y: number): number => roundFloat(x + y, kind);
    const mul = (x: number, y: number): number => roundFloat(x * y, kind);
    const dot = (x: readonly number[], y: readonly number[]): number => {
        let sum = 0;
        for (let i = 0; i < x.length; i++) sum = add(sum, mul(x[i]!, y[i]!));
        return sum;
    };
    const columns = (m: Value): number[][] => m as number[][];
    if (aType.kind === Kind.Matrix && bType.kind === Kind.Vector) {
        const m = columns(a);
        const v = b as number[];
        return Array.from({ length: aType.rows }, (_, r) =>
            dot(
                m.map(c => c[r]!),
                v,
            ),
        );
    }
    if (aType.kind === Kind.Vector && bType.kind === Kind.Matrix) {
        const v = a as number[];
        return columns(b).map(c => dot(v, c));
    }
    const x = columns(a);
    const y = columns(b);
    return y.map(column =>
        Array.from({ length: aType.rows }, (_, r) =>
            dot(
                x.map(c => c[r]!),
                column,
            ),
        ),
    );
}
