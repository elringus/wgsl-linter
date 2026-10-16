import { Tok } from "../syntax/token.ts";
import { Node, tokenText, type Tree } from "../syntax/tree.ts";
import {
    binaryScalar,
    convertValue,
    fail,
    map1,
    map2,
    multiplyLinear,
    unaryScalar,
    type Value,
    zeroValue,
} from "./eval.ts";
import { evaluateBuiltin } from "./intrinsics.ts";
import type { Resolution } from "./overloads.ts";
import { Kind, scalarOf, type Type } from "./types.ts";

/** The semantic information needed to evaluate the expressions. */
export interface Evaluation {
    readonly tree: Tree;
    readonly types: readonly (Type | undefined)[];
    readonly overloads: readonly (Resolution | undefined)[];
}

/**
 * Computes the value of a parenthesized, unary, binary, index, member or call expression from
 * the values of its operands, which `get` provides; returns undefined when an operand is unknown.
 * Throws {@link EvalError} when the evaluation fails.
 */
export function valueOf(
    evaluation: Evaluation,
    node: number,
    get: (node: number) => Value | undefined,
): Value | undefined {
    const { tree, types, overloads } = evaluation;
    const first = tree.firsts[node]!;
    switch (tree.kinds[node]) {
        case Node.Paren:
            return get(first);
        case Node.Unary: {
            const res = overloads[node];
            const a = get(first);
            if (!res || a === undefined) return undefined;
            const op = operatorOf(tree, node);
            const x = convertValue(a, types[first]!, res.params[0]!);
            const kind = scalarOf(res.result).kind;
            return map1(x, v => unaryScalar(op, kind, v));
        }
        case Node.Binary: {
            const second = tree.nexts[first]!;
            const op = operatorOf(tree, node);
            const a = get(first);
            if (a === undefined) return undefined;
            if (op === "&&" || op === "||") return (op === "&&" ? !a : a) ? a : get(second);
            const res = overloads[node];
            const b = get(second);
            if (!res || b === undefined) return undefined;
            const [lt, rt] = res.params as [Type, Type];
            const x = convertValue(a, types[first]!, lt);
            const y = convertValue(b, types[second]!, rt);
            const kind = scalarOf(lt).kind;
            const evaluator = res.overload.evaluator;
            if (
                evaluator === "MultiplyMatVec" ||
                evaluator === "MultiplyVecMat" ||
                evaluator === "MultiplyMatMat"
            )
                return multiplyLinear(x, lt, y, rt, kind);
            return map2(x, y, (p, q) => binaryScalar(op, kind, p, q));
        }
        case Node.Index: {
            const base = get(first) as readonly Value[] | undefined;
            const index = get(tree.nexts[first]!);
            if (base === undefined || index === undefined) return undefined;
            const position = Number(index);
            if (position < 0 || position >= base.length)
                fail(`index ${position} out of bounds [0..${base.length - 1}]`);
            return base[position];
        }
        case Node.Member: {
            const base = get(first) as readonly Value[] | undefined;
            const type = types[first];
            if (base === undefined || !type) return undefined;
            const name = tokenText(tree, node);
            if (type.kind === Kind.Struct)
                return base[type.members.findIndex(m => m.name === name)];
            const indices = swizzleIndices(name);
            return indices.length === 1 ? base[indices[0]!] : indices.map(i => base[i]!);
        }
        case Node.Call:
            return callValue(evaluation, node, get);
        default:
            return undefined;
    }
}

function callValue(
    evaluation: Evaluation,
    node: number,
    get: (node: number) => Value | undefined,
): Value | undefined {
    const { tree, types, overloads } = evaluation;
    const args: Value[] = [];
    const argTypes: Type[] = [];
    for (let arg = tree.nexts[tree.firsts[node]!]!; arg; arg = tree.nexts[arg]!) {
        const value = get(arg);
        if (value === undefined) return undefined;
        args.push(value);
        argTypes.push(types[arg]!);
    }
    const res = overloads[node];
    const type = types[node]!;
    if (!res) {
        if (args.length === 0) return zeroValue(type);
        if (type.kind === Kind.Struct)
            return args.map((a, i) => convertValue(a, argTypes[i]!, type.members[i]!.type));
        return args.map((a, i) => convertValue(a, argTypes[i]!, type.elem!));
    }
    const converted = args.map((a, i) => convertValue(a, argTypes[i]!, res.params[i]!));
    if (res.overload.kind === "function") return evaluateBuiltin(res.overload.name, converted, res);
    return constructValue(type, converted, res.params);
}

/** Builds the value of a vector, matrix or scalar from the constructor arguments. */
function constructValue(type: Type, args: readonly Value[], params: readonly Type[]): Value {
    if (args.length === 0) return zeroValue(type);
    switch (type.kind) {
        case Kind.Vector: {
            if (args.length === 1 && params[0]!.kind !== Kind.Vector)
                return Array.from({ length: type.count }, () => args[0]!);
            const out: Value[] = [];
            for (const arg of args) {
                if (Array.isArray(arg)) out.push(...arg);
                else out.push(arg);
            }
            return convertValue(out, params[0]!, type);
        }
        case Kind.Matrix: {
            if (args.length === 1) return convertValue(args[0]!, params[0]!, type);
            if (args.length === type.count) return args;
            const columns: Value[] = [];
            for (let c = 0; c < type.count; c++)
                columns.push(args.slice(c * type.rows, (c + 1) * type.rows));
            return columns;
        }
        default:
            return convertValue(args[0]!, params[0]!, type);
    }
}

function operatorOf(tree: Tree, node: number): string {
    const op = tree.tokens.kinds[tree.tokenOf[node]!] as Tok;
    switch (op) {
        case Tok.Minus:
        case Tok.MinusMinus:
            return "-";
        case Tok.Bang:
            return "!";
        case Tok.Tilde:
            return "~";
        case Tok.And:
        case Tok.AndAnd:
            return tree.kinds[node] === Node.Unary ? "&" : op === Tok.AndAnd ? "&&" : "&";
        default:
            return tokenText(tree, node);
    }
}

/** Returns the component indices of a valid swizzle name. */
export function swizzleIndices(name: string): number[] {
    const set = /^[xyzw]+$/.test(name) ? "xyzw" : "rgba";
    return Array.from({ length: name.length }, (_, i) => set.indexOf(name[i]!));
}
