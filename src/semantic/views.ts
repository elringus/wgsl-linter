import type { Note } from "../syntax/diagnostic.ts";
import { Node, type Tree } from "../syntax/tree.ts";
import { alignOf, layoutOf, sizeOf, strideOf } from "./layout.ts";
import type { Resolution as OverloadResolution } from "./overloads.ts";
import { memoryRoot } from "./resolve.ts";
import { hasFixedFootprint, Kind, type Type } from "./types.ts";

/** Semantic facts the buffer view analysis depends on. */
export interface ViewInput {
    readonly tree: Tree;
    readonly refs: Uint32Array;
    readonly types: readonly (Type | undefined)[];
    readonly overloads: readonly (OverloadResolution | undefined)[];
    /** Returns the value of the integer expression when known. */
    readonly value: (node: number) => number | undefined;
    /** Returns the size of the buffer type in bytes when known. */
    readonly size: (buffer: Type) => number | undefined;
    readonly report: (node: number, message: string, note?: Note) => void;
}

/** Minimum size of the buffer a pointer parameter points to, required by the views of it. */
interface ViewSize {
    /** Minimum size of the buffer including the views' offsets and sizes. */
    readonly total: number;
    /** The call creating the view requiring the size. */
    readonly node: number;
}

const u32Max = 4294967295;

/**
 * Validates the offsets and sizes of the bufferView and bufferArrayView calls against the
 * sizes of the viewed buffers, also through the buffer pointers passed to the user-declared
 * functions. The calls must be analyzed in dependency order: the callees first.
 */
export class BufferViews {
    private readonly params = new Map<number, ViewSize>();

    constructor(private readonly input: ViewInput) {}

    /** Analyzes the bufferView or bufferArrayView call. */
    view(call: number): void {
        const { tree, types, overloads, value, size, report } = this.input;
        const res = overloads[call]!;
        const name = res.overload.name;
        const array = name === "bufferArrayView";
        const buffer = tree.nexts[tree.firsts[call]!]!;
        const offsetArg = tree.nexts[buffer]!;
        const store = res.result.elem!;
        const align = alignOf(store);
        let min = sizeOf(store);
        let tailOffset = 0;
        let stride = 0;
        if (!hasFixedFootprint(store)) {
            if (store.kind === Kind.Struct) {
                const layout = layoutOf(store);
                tailOffset = layout[layout.length - 1]!.offset;
                stride = strideOf(store.members[store.members.length - 1]!.type);
            } else stride = strideOf(store);
            min = tailOffset + stride;
        }
        const count = size(types[buffer]!.elem!);
        let offset = value(offsetArg);
        if (offset !== undefined) {
            if (offset < 0)
                return report(offsetArg, `the offset argument of ${name} must be non-negative`);
            if (offset % align !== 0)
                return report(
                    offsetArg,
                    `the offset argument of ${name} must evenly divide the alignment of the return type (${align})`,
                );
        }
        offset ??= 0;
        let total = offset + min;
        if (!array) {
            if (total > u32Max)
                return report(
                    offsetArg,
                    `the offset argument of ${name} plus the minimum size of the return type must not overflow a 32-bit unsigned integer`,
                );
            if (count !== undefined && total > count)
                return report(
                    offsetArg,
                    `the offset argument of ${name} plus the minimum size of the return type must be less than or equal to the buffer size`,
                );
        } else {
            const sizeArg = tree.nexts[offsetArg]!;
            let length = value(sizeArg);
            if (length !== undefined) {
                if (length < 0)
                    return report(sizeArg, `the size argument of ${name} must be non-negative`);
                if (length < min)
                    return report(
                        sizeArg,
                        `the size argument (${length} bytes) of ${name} must be large enough to include one element of the runtime-sized array (${min} bytes)`,
                    );
                if ((length - tailOffset) % stride !== 0)
                    return report(
                        sizeArg,
                        `the size argument (${length} bytes) of ${name} minus the return type offset (${tailOffset} bytes) must be evenly divisible by the stride of the runtime-sized array (${stride} bytes)`,
                    );
            }
            length ??= 0;
            if (offset + length + min > u32Max)
                return report(
                    call,
                    `the offset and size arguments of ${name} plus the minimum return type size must not overflow a 32-bit unsigned integer`,
                );
            total = offset + Math.max(length, min);
            if (count !== undefined && total > count)
                return report(
                    call,
                    `the buffer (${count} bytes) must be large enough to include one element of the runtime-sized array (${min} bytes)`,
                );
        }
        this.require(memoryRoot(tree, this.input.refs, buffer), { total, node: call });
    }

    /** Analyzes the buffer pointers passed to the parameters of the user-declared function. */
    userCall(call: number, decl: number): void {
        const { tree, refs, types, size, report } = this.input;
        let param = tree.firsts[decl]!;
        for (let arg = tree.nexts[tree.firsts[call]!]!; arg; arg = tree.nexts[arg]!) {
            while (tree.kinds[param] !== Node.Param) param = tree.nexts[param]!;
            const required = this.params.get(param);
            param = tree.nexts[param]!;
            if (!required) continue;
            const root = memoryRoot(tree, refs, arg);
            const buffer = types[root]!.elem!;
            const count = buffer.kind === Kind.Buffer ? size(buffer) : undefined;
            if (count !== undefined && count < required.total) {
                const { starts, ends } = tree;
                const node = required.node;
                const note = {
                    start: starts[node]!,
                    end: ends[node]!,
                    message: "due to call here",
                };
                report(
                    root,
                    `buffer size (${count} bytes) is smaller than the minimum view size (${required.total} bytes)`,
                    note,
                );
                continue;
            }
            this.require(root, required);
        }
    }

    /** Records the size required from the buffer the parameter points to. */
    private require(root: number, size: ViewSize): void {
        if (this.input.tree.kinds[root] !== Node.Param) return;
        const existing = this.params.get(root);
        if (!existing || size.total > existing.total) this.params.set(root, size);
    }
}
