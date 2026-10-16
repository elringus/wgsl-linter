import { check, type Options, type Semantics } from "./semantic/check.ts";
import { resolve } from "./semantic/resolve.ts";
import { Document } from "./service/document.ts";
import type { Diagnostic } from "./syntax/diagnostic.ts";
import { parse } from "./syntax/parser.ts";

export type { Diagnostic, Note, Severity } from "./syntax/diagnostic.ts";
export type { Options, Semantics } from "./semantic/check.ts";
export { parse } from "./syntax/parser.ts";
export { resolve } from "./semantic/resolve.ts";
export { check } from "./semantic/check.ts";
export { validatePipeline, type PipelineStage } from "./semantic/pipeline.ts";
export { Document, type DocumentOptions } from "./service/document.ts";
export { hover, type Hover } from "./service/hover.ts";
export type { Layout } from "./service/describe.ts";
export { inlayHints, type InlayHint } from "./service/hints.ts";
export {
    completion,
    CompletionKind,
    type CompletionItem,
    type Completions,
} from "./service/completion.ts";
export { signatureHelp, type Signature, type SignatureHelp } from "./service/signature.ts";
export {
    definition,
    isValidName,
    prepareRename,
    references,
    rename,
    type Range,
} from "./service/navigation.ts";
export {
    documentSymbols,
    foldingRanges,
    SymbolKind,
    type DocumentSymbol,
    type FoldingRange,
} from "./service/symbols.ts";
export {
    semanticTokens,
    tokenModifiers,
    TokenModifier,
    TokenType,
    tokenTypes,
} from "./service/tokens.ts";
export { format, type FormatOptions } from "./service/format.ts";
export { extractTemplates, type Template } from "./embed.ts";

/** Parses, resolves and checks the WGSL source text. */
export function analyze(text: string, options?: Options): Semantics {
    return check(resolve(parse(text)), options);
}

/** Returns all the diagnostics of the WGSL source text, sorted by their position. */
export function lint(text: string, options?: Options): Diagnostic[] {
    return new Document(text, options).diagnostics();
}
