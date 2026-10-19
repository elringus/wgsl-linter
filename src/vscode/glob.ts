const compiled = new Map<string, RegExp>();

/** Whether the path matches the glob of the `**`, `*`, `?`, `[a-z]`, `[!a-z]` and `{a,b}` wildcards. */
export function matches(glob: string, path: string): boolean {
    let regex = compiled.get(glob);
    if (!regex) compiled.set(glob, (regex = compile(glob)));
    return regex.test(path);
}

function compile(glob: string): RegExp {
    let source = "";
    let braces = 0;
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i]!;
        if (char === "*" && glob[i + 1] === "*") {
            const slash = glob[i + 2] === "/";
            source += slash ? "(?:.*/)?" : ".*";
            i += slash ? 2 : 1;
        } else if (char === "*") source += "[^/]*";
        else if (char === "?") source += "[^/]";
        else if (char === "[") {
            const negated = glob[i + 1] === "!" || glob[i + 1] === "^";
            const from = i + (negated ? 2 : 1);
            const close = glob.indexOf("]", from + 1);
            if (close < 0) source += "\\[";
            else {
                const set = glob.slice(from, close).replace(/[\\\]]/g, "\\$&");
                source += negated ? `(?!/)[^${set}]` : `[${set}]`;
                i = close;
            }
        } else if (char === "{") {
            braces++;
            source += "(?:";
        } else if (char === "}" && braces > 0) {
            braces--;
            source += ")";
        } else if (char === "," && braces > 0) source += "|";
        else source += char.replace(/[.+^$()|[\]\\{}]/, "\\$&");
    }
    return new RegExp(`^${source}$`);
}
