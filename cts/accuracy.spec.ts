import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { analyze } from "../src/index.ts";
import type { Value } from "../src/semantic/eval.ts";
import { Node } from "../src/syntax/tree.ts";

/**
 * Checks the const-evaluation against the const cases of the CTS execution tests for the
 * builtins and operators: the tests are run with stubs capturing the expressions and the
 * cases, whose inputs are then evaluated and checked to lie within the expected intervals.
 * Generating the cases takes minutes, so the spec runs only with the CTS environment variable,
 * which `bun scripts/cts.ts` sets.
 */

const expression = join(import.meta.dirname, "suite/src/webgpu/shader/execution/expression");
const directories = ["call/builtin", "binary", "unary"];

/**
 * The tests whose expectations are not about the const-evaluation: the assignment of the
 * abstract floats expects the subnormals flushed, as the GPU stores them.
 */
const excluded = ["unary/af_assignment"];

/** A case list of an expression captured from a CTS test. */
interface Run {
    readonly test: string;
    readonly build: (values: readonly string[]) => string;
    readonly predeclaration: string;
    readonly resultType: CtsType;
    readonly cases: readonly CtsCase[];
}

interface CtsType {
    readonly kind?: string;
    toString(): string;
    create(value: unknown): unknown;
    requiresF16(): boolean;
}

interface CtsCase {
    readonly input: CtsValue | readonly CtsValue[];
    readonly expected: unknown;
}

interface CtsValue {
    wgsl(): string;
    readonly type: { requiresF16(): boolean };
}

interface Comparison {
    readonly matched: boolean;
    readonly got: string;
    readonly expected: string;
}

const enabled = !!process.env.CTS && existsSync(expression);

describe.skipIf(!enabled)("const-evaluation accuracy", async () => {
    const runs = enabled ? await captureRuns() : [];

    it.each(runs.map(run => [run.test, run] as const))("evaluates %s", async (_, run) => {
        const { toComparator } = await import(`${expression}/expectation.ts`);
        const failures = evaluate(run, toComparator);
        expect(failures.slice(0, 10)).toEqual([]);
    });
});

/**
 * Creates the base of the suite's tsconfig, which the transforms of the suite's sources look up
 * and which is in the suite's dev dependencies, not installed.
 */
function stubTsconfigBase(): void {
    const base = join(import.meta.dirname, "suite/node_modules/gts/tsconfig-google.json");
    if (existsSync(base)) return;
    mkdirSync(join(base, ".."), { recursive: true });
    writeFileSync(base, "{}");
}

/** Runs the const cases of the CTS expression tests with stubs capturing the case lists. */
async function captureRuns(): Promise<Run[]> {
    stubTsconfigBase();
    const runs: Run[] = [];
    let current = "";
    const builder = (build: Run["build"], predeclaration = "") => ({ build, predeclaration });
    vi.doMock(`${expression}/expression.ts`, async original => ({
        ...(await original<object>()),
        basicExpressionBuilder: builder,
        abstractFloatShaderBuilder: builder,
        abstractIntShaderBuilder: builder,
        basicExpressionWithPredeclarationBuilder: builder,
        compoundAssignmentBuilder: () => undefined,
        run: async (
            _: unknown,
            shader: { build: Run["build"]; predeclaration: string } | undefined,
            __: unknown,
            resultType: CtsType,
            config: { inputSource?: string; vectorize?: number },
            cases: CtsCase[],
        ) => {
            if (!shader || config.inputSource !== "const" || config.vectorize !== undefined) return;
            runs.push({ test: current, ...shader, resultType, cases });
        },
    }));
    vi.doMock(`${expression}/case_cache.ts`, async original => ({
        ...(await original<object>()),
        makeCaseCache: (_: string, builders: Record<string, () => CtsCase[]>) => ({
            get: async (name: string) => builders[name]!(),
        }),
    }));
    const stub = (params: object): unknown =>
        new Proxy(
            { params },
            { get: (target, key) => (key === "params" ? target.params : () => {}) },
        );
    for (const directory of directories)
        for (const file of readdirSync(join(expression, directory))) {
            const cache = file.replace(".spec.ts", ".cache.ts");
            const name = `${directory}/${file.replace(".spec.ts", "")}`;
            if (!file.endsWith(".spec.ts") || !existsSync(join(expression, directory, cache)))
                continue;
            if (excluded.includes(name)) continue;
            const { g } = await import(join(expression, directory, file));
            for (const test of g.iterate()) {
                for (const runCase of test.iterate(null)) {
                    const params = runCase.params as Record<string, unknown>;
                    const subcases: Iterable<object> = runCase.subcases ?? [{}];
                    for (const subcase of subcases) {
                        const merged = { ...params, ...subcase };
                        if ("inputSource" in merged && merged.inputSource !== "const") continue;
                        current = `${name}:${test.testPath.join(",")}:${JSON.stringify(merged)}`;
                        await test
                            .testFn(stub({ inputSource: "const", ...merged }))
                            .catch(() => {});
                    }
                }
            }
        }
    return runs;
}

/** Evaluates the cases of the run; returns the descriptions of the mismatches. */
function evaluate(
    run: Run,
    toComparator: (e: unknown) => { compare(got: unknown): Comparison },
): string[] {
    const inputs = (c: CtsCase): readonly CtsValue[] =>
        Array.isArray(c.input) ? c.input : [c.input as CtsValue];
    const f16 =
        run.resultType.requiresF16() ||
        run.cases.some(c => inputs(c).some(v => v.type.requiresF16()));
    const expressions = run.cases.map(c => run.build(inputs(c).map(v => v.wgsl())));
    const typeName = run.resultType.toString();
    const type = typeName.includes("abstract") ? "" : `: ${typeName}`;
    const code = [
        f16 ? "enable f16;" : "",
        run.predeclaration,
        ...expressions.map((e, i) => `const r${i}${type} = ${e};`),
    ].join("\n");
    const sem = analyze(code);
    const { tree } = sem;
    const failures: string[] = [];
    let i = 0;
    for (let decl = tree.firsts[0]!; decl; decl = tree.nexts[decl]!) {
        if (tree.kinds[decl] !== Node.Const) continue;
        const index = i++;
        const value = sem.values[decl] as Value | undefined;
        const errors = sem.diagnostics.filter(
            d => d.start >= tree.starts[decl]! && d.end <= tree.ends[decl]!,
        );
        if (value === undefined) {
            failures.push(
                `${expressions[index]}: ${errors.map(d => d.message).join("; ") || "no value"}`,
            );
            continue;
        }
        const comparison = toComparator(run.cases[index]!.expected).compare(
            toCts(value, run.resultType),
        );
        if (!comparison.matched)
            failures.push(
                `${expressions[index]} = ${comparison.got}, expected ${comparison.expected}`,
            );
    }
    return failures;
}

/** Converts the evaluated value to the CTS value of the type. */
function toCts(value: Value, type: CtsType): unknown {
    const flat = (v: Value): unknown[] =>
        Array.isArray(v) ? (v as Value[]).flatMap(flat) : [scalar(v)];
    const scalar = (v: Value): unknown => (typeof v === "boolean" ? (v ? 1 : 0) : v);
    return Array.isArray(value) ? type.create(flat(value)) : type.create(scalar(value));
}
