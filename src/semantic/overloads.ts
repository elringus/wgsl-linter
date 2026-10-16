import { constructors, enums, functions, matchers, operators } from "./builtins.ts";
import {
    abstractFloat,
    abstractInt,
    type Access,
    type AddressSpace,
    array,
    atomic,
    atomicCompareExchangeResult,
    boolType,
    buffer,
    commonType,
    conversionRank,
    f16,
    f32,
    frexpResult,
    i32,
    isAbstract,
    isConstructible,
    Kind,
    mat,
    modfResult,
    noConversion,
    pointer,
    reference,
    sampledTexture,
    scalars,
    storageTexture,
    texture,
    type Type,
    u32,
    unsizedBuffer,
    vec,
    voidType,
} from "./types.ts";

/** Type pattern of a builtin overload's parameter or result. */
export interface Pattern {
    readonly name: string;
    readonly args: readonly Pattern[];
    /** Index of the referenced template parameter, or -1. */
    readonly template: number;
}

export enum TemplateKind {
    Type,
    Number,
    Enum,
}

export interface TemplateParam {
    readonly name: string;
    readonly kind: TemplateKind;
    readonly constraint: Pattern | undefined;
}

export interface Param {
    readonly name: string;
    readonly type: Pattern;
    /** Whether the argument must be a const-expression. */
    readonly constant: boolean;
}

/** A builtin function, value constructor, conversion or operator overload. */
export interface Overload {
    readonly kind: "function" | "constructor" | "operator";
    readonly name: string;
    readonly mustUse: boolean;
    /** Name of the const-evaluation function when the overload is const-evaluable. */
    readonly evaluator: string | undefined;
    /** Shader stages the overload is restricted to, or empty when it's allowed in all stages. */
    readonly stages: readonly string[];
    readonly conversion: boolean;
    /** Template parameters: the explicit ones first. */
    readonly templates: readonly TemplateParam[];
    readonly explicit: number;
    readonly params: readonly Param[];
    readonly result: Pattern | undefined;
    /** The overload's signature as declared in the builtin table. */
    readonly signature: string;
}

/** Template argument provided explicitly: a type or an enumerant. */
export type TemplateArg = Type | string;

/** The overload selected for a call, with the parameter and result types for its arguments. */
export interface Resolution {
    readonly overload: Overload;
    readonly params: readonly Type[];
    /** The result type, or void when the overload doesn't return a value. */
    readonly result: Type;
    readonly templates: readonly (Type | undefined)[];
    readonly values: readonly (number | string | undefined)[];
}

const parsed = new Map<string, readonly Overload[]>();

/** Returns the overloads of the builtin function, or undefined when there's no such function. */
export function functionOverloads(name: string): readonly Overload[] | undefined {
    return lookup("function", name, functions[name]);
}

/** Returns the value constructor and conversion overloads of the type, such as `vec3` or `f32`. */
export function constructorOverloads(name: string): readonly Overload[] | undefined {
    return lookup("constructor", name, constructors[name]);
}

/** Returns the overloads of the unary or binary operator. */
export function operatorOverloads(op: string, operands: number): readonly Overload[] {
    return lookup("operator", op + operands, operators[op + operands]) ?? [];
}

/** Whether the name is a builtin function. */
export function isBuiltinFunction(name: string): boolean {
    return Object.hasOwn(functions, name);
}

/** Returns the names of all builtin functions. */
export function builtinFunctionNames(): readonly string[] {
    return Object.keys(functions);
}

function lookup(
    kind: Overload["kind"],
    key: string,
    lines: readonly string[] | undefined,
): readonly Overload[] | undefined {
    if (!lines) return undefined;
    const id = `${kind}:${key}`;
    let overloads = parsed.get(id);
    if (!overloads) parsed.set(id, (overloads = lines.map(line => parseOverload(kind, line))));
    return overloads;
}

// ---- parsing ----

const tokenPattern = /'[^']*'|[A-Za-z_]\w*|\d+|->|\S/g;
const prefixPattern = /^(?:@\w+(?:\([^)]*\))? )*(?:implicit\([^)]*\) )?/;
const namePattern = /^(?:[A-Za-z_]\w*|[^\w(]+)/;

function parseOverload(kind: Overload["kind"], line: string): Overload {
    const signature = line.replace(prefixPattern, "");
    const name = namePattern.exec(signature)![0];
    const prefix = line.slice(0, line.length - signature.length).match(tokenPattern) ?? [];
    const tokens = [...prefix, name, ...signature.slice(name.length).match(tokenPattern)!];
    let pos = 0;
    const peek = (): string => tokens[pos] ?? "";
    const next = (): string => tokens[pos++]!;
    let mustUse = false;
    let conversion = false;
    let evaluator: string | undefined;
    const stages: string[] = [];
    const templates: TemplateParam[] = [];
    while (peek() === "@") {
        next();
        const attribute = next();
        const args: string[] = [];
        if (peek() === "(") {
            next();
            while (peek() !== ")") {
                const arg = next();
                if (arg !== ",") args.push(arg.slice(1, -1));
            }
            next();
        }
        if (attribute === "must_use") mustUse = true;
        else if (attribute === "conv") conversion = true;
        else if (attribute === "const") evaluator = args[0] ?? "";
        else if (attribute === "stage") stages.push(...args);
    }
    const implicit: [string, string[]][] = [];
    if (peek() === "implicit") {
        next();
        implicit.push(...templateList(")"));
    }
    next();
    const explicit = peek() === "<" ? templateList(">") : [];
    for (const [templateName] of [...explicit, ...implicit])
        templates.push({ name: templateName, kind: TemplateKind.Type, constraint: undefined });
    const resolveTemplates = (list: [string, string[]][], offset: number): void => {
        for (let i = 0; i < list.length; i++) {
            const [templateName, constraint] = list[i]!;
            if (constraint.length === 0) continue;
            const kind =
                constraint[0] === "num"
                    ? TemplateKind.Number
                    : Object.hasOwn(enums, constraint[0]!) || isEnumMatcher(constraint[0]!)
                      ? TemplateKind.Enum
                      : TemplateKind.Type;
            const pattern =
                kind === TemplateKind.Number ? undefined : patternOf(constraint, templates);
            templates[offset + i] = { name: templateName, kind, constraint: pattern };
        }
    };
    resolveTemplates(explicit, 0);
    resolveTemplates(implicit, explicit.length);
    const params: Param[] = [];
    next();
    while (peek() !== ")") {
        let constant = false;
        if (peek() === "@") {
            next();
            next();
            constant = true;
        }
        let paramName = "";
        if (tokens[pos + 1] === ":") {
            paramName = next();
            next();
        }
        params.push({ name: paramName, type: patternOf(typeTokens(), templates), constant });
        if (peek() === ",") next();
    }
    next();
    let result: Pattern | undefined;
    if (peek() === "->") {
        next();
        result = patternOf(typeTokens(), templates);
    }
    return {
        kind,
        name,
        mustUse,
        evaluator,
        stages,
        conversion,
        templates,
        explicit: explicit.length,
        params,
        result,
        signature,
    };

    function typeTokens(): string[] {
        const out: string[] = [];
        let depth = 0;
        while (pos < tokens.length) {
            const t = peek();
            if (depth === 0 && (t === "," || t === ")" || t === ">")) break;
            if (t === "<") depth++;
            else if (t === ">") depth--;
            out.push(next());
        }
        return out;
    }

    function templateList(close: string): [string, string[]][] {
        next();
        const items: [string, string[]][] = [];
        while (peek() !== close) {
            const itemName = next();
            let constraint: string[] = [];
            if (peek() === ":") {
                next();
                constraint = typeTokens();
            }
            items.push([itemName, constraint]);
            if (peek() === ",") next();
        }
        next();
        return items;
    }
}

function isEnumMatcher(name: string): boolean {
    return matchers[name]?.[0]?.includes(".") ?? false;
}

function patternOf(tokens: readonly string[], templates: readonly TemplateParam[]): Pattern {
    let pos = 0;
    const parse = (): Pattern => {
        const name = tokens[pos++]!;
        const args: Pattern[] = [];
        if (tokens[pos] === "<") {
            pos++;
            while (tokens[pos] !== ">") {
                args.push(parse());
                if (tokens[pos] === ",") pos++;
            }
            pos++;
        }
        const template = args.length === 0 ? templates.findIndex(t => t.name === name) : -1;
        return { name, args, template };
    };
    return parse();
}

// ---- matching ----

class MatchState {
    readonly types: (Type | undefined)[] = [];
    readonly values: (number | string | undefined)[] = [];
    constructor(
        readonly overload: Overload,
        readonly constant: boolean,
    ) {}
}

/**
 * Selects the overload matching the template and argument types, following Tint's overload
 * resolution. Returns undefined when no overload matches, or null when the call is ambiguous.
 * @param constant whether all the arguments are const-expressions
 */
export function resolveOverload(
    overloads: readonly Overload[],
    templateArgs: readonly TemplateArg[],
    args: readonly Type[],
    constant: boolean,
): Resolution | undefined | null {
    const candidates: Resolution[] = [];
    for (const overload of overloads) {
        const candidate = matchOverload(overload, templateArgs, args, constant);
        if (candidate) candidates.push(candidate);
    }
    if (candidates.length <= 1) return candidates[0];
    const best = args.map(() => noConversion + 1);
    let winner: Resolution | undefined;
    let matched = 0;
    for (const candidate of candidates) {
        let won = false;
        let lost = false;
        for (let i = 0; i < args.length; i++) {
            const rank = conversionRank(args[i]!, candidate.params[i]!);
            if (best[i]! > rank) {
                best[i] = rank;
                won = true;
            } else if (best[i]! < rank) lost = true;
        }
        if (!won) continue;
        matched++;
        if (!lost) {
            if (winner) matched--;
            winner = candidate;
        }
    }
    return matched > 1 ? null : winner;
}

function matchOverload(
    overload: Overload,
    templateArgs: readonly TemplateArg[],
    args: readonly Type[],
    constant: boolean,
): Resolution | undefined {
    if (overload.params.length !== args.length || overload.explicit !== templateArgs.length)
        return undefined;
    const state = new MatchState(overload, constant);
    for (let i = 0; i < templateArgs.length; i++) {
        const arg = templateArgs[i]!;
        const template = overload.templates[i]!;
        if (typeof arg === "string") {
            if (template.kind !== TemplateKind.Enum) return undefined;
            if (template.constraint && !matchEnum(template.constraint, arg, state))
                return undefined;
            state.values[i] = arg;
            continue;
        }
        if (template.kind !== TemplateKind.Type) return undefined;
        const type = template.constraint ? matchType(template.constraint, arg, state) : arg;
        if (!type) return undefined;
        state.types[i] = type;
    }
    for (let i = 0; i < args.length; i++)
        if (!matchType(overload.params[i]!.type, args[i]!, state)) return undefined;
    for (let i = overload.explicit; i < overload.templates.length; i++) {
        const template = overload.templates[i]!;
        if (template.kind === TemplateKind.Type) {
            const type = state.types[i];
            if (!type) return undefined;
            if (!template.constraint) continue;
            const constrained = matchType(template.constraint, type, state);
            if (!constrained) return undefined;
            state.types[i] = constrained;
        } else {
            const value = state.values[i];
            if (value === undefined) return undefined;
            if (
                template.kind === TemplateKind.Enum &&
                template.constraint &&
                typeof value === "string"
            )
                if (!matchEnum(template.constraint, value, state)) return undefined;
        }
    }
    const params: Type[] = [];
    for (let i = 0; i < args.length; i++)
        params.push(matchType(overload.params[i]!.type, args[i]!, state)!);
    const result = overload.result ? buildType(overload.result, state) : voidType;
    if (!result) return undefined;
    return {
        overload,
        params,
        result,
        templates: state.types,
        values: state.values,
    };
}

function matchType(pattern: Pattern, type: Type, state: MatchState): Type | undefined {
    if (pattern.template >= 0) {
        const current = state.types[pattern.template];
        if (!current) return (state.types[pattern.template] = type);
        const common = commonType(current, type);
        if (common) state.types[pattern.template] = common;
        return common;
    }
    const alternatives = matchers[pattern.name];
    if (alternatives) {
        for (const alternative of alternatives) {
            const matched = matchLeaf(alternative, type, state);
            if (matched) return matched;
        }
        return undefined;
    }
    const { name, args } = pattern;
    switch (name) {
        case "bool":
        case "i32":
        case "u32":
        case "f32":
        case "f16":
        case "ia":
        case "fa":
            return matchLeaf(name, type, state);
        case "vec":
        case "vec2":
        case "vec3":
        case "vec4": {
            if (type.kind !== Kind.Vector) return undefined;
            if (
                name === "vec"
                    ? !matchNumber(args[0]!, type.count, state)
                    : type.count !== +name[3]!
            )
                return undefined;
            const elem = matchType(args[args.length - 1]!, type.elem!, state);
            return elem && vec(type.count, elem);
        }
        case "mat": {
            if (type.kind !== Kind.Matrix) return undefined;
            if (
                !matchNumber(args[0]!, type.count, state) ||
                !matchNumber(args[1]!, type.rows, state)
            )
                return undefined;
            const elem = matchType(args[2]!, type.elem!, state);
            return elem && mat(type.count, type.rows, elem);
        }
        case "atomic": {
            if (type.kind !== Kind.Atomic) return undefined;
            const elem = matchType(args[0]!, type.elem!, state);
            return elem && atomic(elem);
        }
        case "array": {
            if (
                type.kind !== Kind.Array ||
                type.count <= 0 ||
                !matchNumber(args[1]!, type.count, state)
            )
                return undefined;
            const elem = matchType(args[0]!, type.elem!, state);
            return elem && array(elem, type.count);
        }
        case "runtime_array": {
            if (type.kind !== Kind.Array || type.count !== 0) return undefined;
            const elem = matchType(args[0]!, type.elem!, state);
            return elem && array(elem);
        }
        case "ptr":
        case "ref": {
            if (type.kind !== (name === "ptr" ? Kind.Pointer : Kind.Reference)) return undefined;
            if (
                !matchEnum(args[0]!, type.space!, state) ||
                !matchEnum(args[2]!, type.access!, state)
            )
                return undefined;
            const store = matchType(args[1]!, type.elem!, state);
            if (!store) return undefined;
            return (name === "ptr" ? pointer : reference)(type.space!, store, type.access!);
        }
        case "unsized_buffer":
            return type === unsizedBuffer ? type : undefined;
        case "buffer":
            return type.kind === Kind.Buffer &&
                type.count !== 0 &&
                matchNumber(args[0]!, type.count, state)
                ? type
                : undefined;
        case "__constructible":
            return isConstructible(type) && !isAbstract(type) ? type : undefined;
        case "sampler":
        case "sampler_comparison":
            return type.kind === Kind.Sampler && type.name === name ? type : undefined;
        default:
            if (name.length === 6 && name.startsWith("mat")) {
                if (
                    type.kind !== Kind.Matrix ||
                    type.count !== +name[3]! ||
                    type.rows !== +name[5]!
                )
                    return undefined;
                const elem = matchType(args[0]!, type.elem!, state);
                return elem && mat(type.count, type.rows, elem);
            }
            if (type.kind !== Kind.Texture || type.name !== name) return undefined;
            if (type.format) {
                if (
                    !matchEnum(args[0]!, type.format, state) ||
                    !matchEnum(args[1]!, type.access!, state)
                )
                    return undefined;
                return type;
            }
            if (args.length === 0) return type;
            if (!type.elem) return undefined;
            {
                const elem = matchType(args[0]!, type.elem, state);
                return elem && sampledTexture(name, elem);
            }
    }
}

function matchLeaf(name: string, type: Type, state: MatchState): Type | undefined {
    switch (name) {
        case "bool":
            return type.kind === Kind.Bool ? boolType : undefined;
        case "i32":
            return type.kind === Kind.I32 || type.kind === Kind.AbstractInt ? i32 : undefined;
        case "u32":
            return type.kind === Kind.U32 || type.kind === Kind.AbstractInt ? u32 : undefined;
        case "f32":
            return type.kind === Kind.F32 ||
                type.kind === Kind.AbstractInt ||
                type.kind === Kind.AbstractFloat
                ? f32
                : undefined;
        case "f16":
            return type.kind === Kind.F16 ||
                type.kind === Kind.AbstractInt ||
                type.kind === Kind.AbstractFloat
                ? f16
                : undefined;
        case "ia":
            return state.constant && type.kind === Kind.AbstractInt ? abstractInt : undefined;
        case "fa":
            return state.constant &&
                (type.kind === Kind.AbstractInt || type.kind === Kind.AbstractFloat)
                ? abstractFloat
                : undefined;
        default:
            return undefined;
    }
}

function matchNumber(pattern: Pattern, value: number, state: MatchState): boolean {
    if (pattern.template < 0) return +pattern.name === value;
    const current = state.values[pattern.template];
    if (current === undefined) {
        state.values[pattern.template] = value;
        return true;
    }
    return current === value;
}

function matchEnum(pattern: Pattern, value: string, state: MatchState): boolean {
    if (pattern.template >= 0) {
        const template = state.overload.templates[pattern.template]!;
        const current = state.values[pattern.template];
        if (current === undefined) {
            if (template.constraint && !matchEnum(template.constraint, value, state)) return false;
            state.values[pattern.template] = value;
            return true;
        }
        return current === value;
    }
    const members = enums[pattern.name];
    if (members) return members.includes(value);
    const alternatives = matchers[pattern.name];
    return !!alternatives && alternatives.some(a => a.slice(a.indexOf(".") + 1) === value);
}

function buildType(pattern: Pattern, state: MatchState): Type | undefined {
    if (pattern.template >= 0) return state.types[pattern.template];
    const { name, args } = pattern;
    const scalar = scalars.get(name);
    if (scalar) return scalar;
    const arg = (i: number): Type | undefined => buildType(args[i]!, state);
    const value = (i: number): number | string | undefined => {
        const p = args[i]!;
        return p.template >= 0 ? state.values[p.template] : matchers[p.name]?.[0]?.split(".")[1];
    };
    switch (name) {
        case "vec": {
            const elem = arg(1);
            return elem && vec(value(0) as number, elem);
        }
        case "vec2":
        case "vec3":
        case "vec4": {
            const elem = arg(0);
            return elem && vec(+name[3]!, elem);
        }
        case "mat": {
            const elem = arg(2);
            return elem && mat(value(0) as number, value(1) as number, elem);
        }
        case "ptr":
        case "ref": {
            const store = arg(1);
            const make = name === "ptr" ? pointer : reference;
            return store && make(value(0) as AddressSpace, store, value(2) as Access);
        }
        case "atomic": {
            const elem = arg(0);
            return elem && atomic(elem);
        }
        case "__frexp_result":
        case "__modf_result": {
            const elem = arg(0);
            return elem && (name === "__frexp_result" ? frexpResult : modfResult)(elem);
        }
        case "__frexp_result_vec":
        case "__modf_result_vec": {
            const elem = arg(1);
            return (
                elem &&
                (name === "__frexp_result_vec" ? frexpResult : modfResult)(
                    vec(value(0) as number, elem),
                )
            );
        }
        case "__atomic_compare_exchange_result": {
            const elem = arg(0);
            return elem && atomicCompareExchangeResult(elem);
        }
        case "buffer":
            return buffer(value(0) as number);
        case "unsized_buffer":
            return unsizedBuffer;
        default:
            if (name.startsWith("mat")) {
                const elem = arg(0);
                return elem && mat(+name[3]!, +name[5]!, elem);
            }
            if (name.startsWith("texture_storage"))
                return storageTexture(name, value(0) as string, value(1) as Access);
            if (name.startsWith("texture")) {
                const elem = args.length > 0 ? arg(0) : undefined;
                return elem ? sampledTexture(name, elem) : texture(name);
            }
            return undefined;
    }
}

/** Formats the template and argument types of a call for the diagnostic messages. */
export function callSignature(
    name: string,
    templateArgs: readonly string[],
    args: readonly string[],
): string {
    return `${name}${templateArgs.length > 0 ? `<${templateArgs.join(", ")}>` : ""}(${args.join(", ")})`;
}
