import { Kind, typeName } from "../semantic/types.ts";
import { childOf, initializerOf, Node } from "../syntax/tree.ts";
import type { Document } from "./document.ts";

/** A hint shown inline in the source. */
export interface InlayHint {
    readonly offset: number;
    readonly label: string;
}

/** Returns the inferred types of the declarations without explicit types within the range. */
export function inlayHints(doc: Document, start: number, end: number): InlayHint[] {
    const { tree } = doc;
    const { types } = doc.semantics;
    const hints: InlayHint[] = [];
    for (let node = 1; node < tree.count; node++) {
        const kind = tree.kinds[node];
        if (kind !== Node.Let && kind !== Node.Var && kind !== Node.Const && kind !== Node.Override)
            continue;
        const name = childOf(tree, node, Node.Name);
        if (!name || tree.ends[name]! < start || tree.ends[name]! > end) continue;
        if (doc.inPrelude(tree.starts[name]!, tree.ends[name]!)) continue;
        if (childOf(tree, node, Node.Type) || !initializerOf(tree, node)) continue;
        const type = types[node];
        if (!type || type.kind === Kind.Error) continue;
        const shown = type.kind === Kind.Reference ? type.elem! : type;
        hints.push({ offset: tree.ends[name]!, label: `: ${typeName(shown)}` });
    }
    return hints;
}
