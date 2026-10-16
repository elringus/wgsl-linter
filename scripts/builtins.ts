/// <reference types="bun" />
// Generates src/semantic/builtins.ts from Tint's wgsl.def.
// Usage: bun scripts/builtins.ts [dawn-commit]; defaults to the latest commit on main.

const repo = "https://raw.githubusercontent.com/google/dawn";
const output = new URL("../src/semantic/builtins.ts", import.meta.url);

// Chromium-experimental and internal features the analyzer doesn't support.
const excludedTypes = new Set([
    "i8",
    "u8",
    "string",
    "subgroup_matrix",
    "texel_buffer",
    "binding_array",
    "input_attachment",
]);
const excludedFunctions = new Set(["print", "hasResource", "getResource", "inputAttachmentLoad"]);

const commit = process.argv[2] ?? (await latestCommit());
const def = await fetchDef("src/tint/lang/wgsl/wgsl.def");
const imports = [...def.matchAll(/^import "(.+)"/gm)].map(m => m[1]!);
const source = (await Promise.all(imports.map(fetchDef))).join("\n") + "\n" + def;

const enums = new Map<string, string[]>();
const precedence = new Map<string, number>();
const matchers = new Map<string, string[]>();
const functions = new Map<string, string[]>();
const constructors = new Map<string, string[]>();
const operators = new Map<string, string[]>();

parse(source);
for (const [name, alternatives] of matchers)
    if (!alternatives[0]!.includes("."))
        matchers.set(
            name,
            alternatives.toSorted((a, b) => (precedence.get(b) ?? -1) - (precedence.get(a) ?? -1)),
        );
await Bun.write(output, emit());
console.log(`Generated ${output.pathname} from dawn@${commit}.`);

async function latestCommit(): Promise<string> {
    const response = await fetch("https://api.github.com/repos/google/dawn/commits/main");
    return ((await response.json()) as { sha: string }).sha;
}

async function fetchDef(path: string): Promise<string> {
    const response = await fetch(`${repo}/${commit}/${path}`);
    if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`);
    return response.text();
}

function parse(text: string): void {
    const tokens = text
        .replace(/\/\/.*$/gm, "")
        .replace(/(?<!\bop\s*)>>/g, "> >")
        .match(/"[^"]*"|[A-Za-z_]\w*|\d+(?:\.\d+)?|->|&&|\|\||==|!=|<=|>=|<<|>>|\S/g)!;
    let pos = 0;
    const peek = (): string => tokens[pos] ?? "";
    const next = (): string => tokens[pos++]!;
    const expect = (token: string): void => {
        if (next() !== token)
            throw new Error(
                `Expected '${token}' near: ${tokens.slice(pos - 8, pos + 4).join(" ")}`,
            );
    };

    while (pos < tokens.length) {
        if (peek() === "import") {
            pos += 2;
            continue;
        }
        if (peek() === "enum") {
            next();
            const name = next();
            const members: string[] = [];
            expect("{");
            while (peek() !== "}") {
                if (peek() === "@") pos += 3;
                else members.push(next());
            }
            next();
            enums.set(name, members);
            continue;
        }
        if (peek() === "match") {
            next();
            const name = next();
            expect(":");
            const alternatives = [qualified()];
            while (peek() === "|") {
                next();
                alternatives.push(qualified());
            }
            matchers.set(name, alternatives);
            continue;
        }
        const attributes: string[] = [];
        while (peek() === "@") {
            next();
            let attribute = next();
            if (peek() === "(") {
                const args: string[] = [];
                next();
                while (peek() !== ")") {
                    const arg = next();
                    if (arg !== ",") args.push(arg.replace(/"/g, "'"));
                }
                next();
                attribute += `(${args.join(", ")})`;
            }
            attributes.push(attribute);
        }
        if (peek() === "type") {
            next();
            const name = next();
            const level = attributes.find(a => a.startsWith("precedence("));
            if (level) precedence.set(name, Number(level.slice(11, -1)));
            if (peek() === "<") templates("<", ">");
            continue;
        }
        const implicit = peek() === "implicit" ? (next(), templates("(", ")")) : [];
        const kind = next();
        if (kind !== "fn" && kind !== "ctor" && kind !== "conv" && kind !== "op")
            throw new Error(
                `Unexpected declaration '${kind}' near: ${tokens.slice(pos - 8, pos + 4).join(" ")}`,
            );
        const name = next();
        const explicit = peek() === "<" ? templates("<", ">") : [];
        const params = parameters();
        let result = "";
        if (peek() === "->") {
            next();
            result = type();
        }
        add(kind, name, attributes, explicit, implicit, params, result);
    }

    function qualified(): string {
        let name = next();
        if (peek() === ".") name += next() + next();
        return name;
    }

    function type(): string {
        let out = qualified();
        if (peek() === "<") {
            next();
            const args = [type()];
            while (peek() === ",") {
                next();
                args.push(type());
            }
            expect(">");
            out += `<${args.join(", ")}>`;
        }
        return out;
    }

    function templates(open: string, close: string): string[] {
        expect(open);
        const items: string[] = [];
        while (peek() !== close) {
            let item = next();
            if (peek() === ":") {
                next();
                item += `: ${type()}`;
            }
            items.push(item);
            if (peek() === ",") next();
        }
        next();
        return items;
    }

    function parameters(): string[] {
        expect("(");
        const items: string[] = [];
        while (peek() !== ")") {
            let item = "";
            while (peek() === "@") {
                next();
                const attribute = next();
                if (peek() === "(") while (next() !== ")");
                if (attribute === "const") item += "@const ";
            }
            if (tokens[pos + 1] === ":") {
                item += `${next()}: `;
                next();
            }
            items.push(item + type());
            if (peek() === ",") next();
        }
        next();
        return items;
    }
}

function add(
    kind: string,
    name: string,
    attributes: string[],
    explicit: string[],
    implicit: string[],
    params: string[],
    result: string,
): void {
    if (
        attributes.includes("deprecated") ||
        excludedFunctions.has(name) ||
        name.startsWith("subgroupMatrix")
    )
        return;
    const words =
        [...explicit, ...implicit, ...params, result].join(" ").match(/[A-Za-z_]\w*/g) ?? [];
    if (words.some(w => excludedTypes.has(w))) return;
    const line = [
        kind === "conv" ? "@conv" : "",
        ...attributes
            .filter(a => a === "must_use" || a.startsWith("const") || a.startsWith("stage"))
            .map(a => "@" + a),
        implicit.length > 0 ? `implicit(${implicit.join(", ")})` : "",
        `${name}${explicit.length > 0 ? `<${explicit.join(", ")}>` : ""}(${params.join(", ")})`,
        result ? `-> ${result}` : "",
    ]
        .filter(Boolean)
        .join(" ");
    const group = kind === "fn" ? functions : kind === "op" ? operators : constructors;
    const key = kind === "op" ? `${name}${params.length}` : name;
    if (!group.has(key)) group.set(key, []);
    group.get(key)!.push(line);
}

function emit(): string {
    const quote = (s: string): string => JSON.stringify(s);
    const table = (map: Map<string, string[]>): string =>
        [...map]
            .map(
                ([name, lines]) =>
                    `    ${quote(name)}: [\n${lines.map(l => `        ${quote(l)},\n`).join("")}    ],\n`,
            )
            .join("");
    const list = (map: Map<string, string[]>): string =>
        [...map]
            .map(([name, items]) => `    ${name}: [${items.map(quote).join(", ")}],\n`)
            .join("");
    return `// Generated by scripts/builtins.ts from Tint's src/tint/lang/wgsl/wgsl.def; do not edit.

/** The Dawn commit the table is generated from. */
export const dawnCommit = ${quote(commit)};

/** Enumerations: the members of each enum. */
export const enums: Readonly<Record<string, readonly string[]>> = {
${list(enums)}};

/** Type and enum matchers: the alternatives of each matcher, type matchers in precedence order. */
export const matchers: Readonly<Record<string, readonly string[]>> = {
${list(matchers)}};

/** Builtin function overloads, by function name. */
export const functions: Readonly<Record<string, readonly string[]>> = {
${table(functions)}};

/** Value constructor and conversion overloads, by type name. */
export const constructors: Readonly<Record<string, readonly string[]>> = {
${table(constructors)}};

/** Operator overloads, by operator and operand count. */
export const operators: Readonly<Record<string, readonly string[]>> = {
${table(operators)}};
`;
}
