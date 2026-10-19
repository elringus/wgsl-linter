import * as vscode from "vscode";
import {
    documentSymbols,
    type DocumentSymbol,
    foldingRanges,
    SymbolKind,
} from "../service/symbols.ts";
import type { Region, Regions } from "./regions.ts";

export function provideSymbols(
    regions: Regions,
    document: vscode.TextDocument,
): vscode.DocumentSymbol[] {
    const convert = (region: Region, symbol: DocumentSymbol): vscode.DocumentSymbol => {
        const result = new vscode.DocumentSymbol(
            symbol.name,
            symbol.detail,
            kinds[symbol.kind],
            regions.range(document, region, symbol.range)!,
            regions.range(document, region, symbol.selection)!,
        );
        result.children = symbol.children.map(child => convert(region, child));
        return result;
    };
    return regions
        .of(document)
        .flatMap(region => documentSymbols(region.doc).map(s => convert(region, s)));
}

export function provideFoldingRanges(
    regions: Regions,
    document: vscode.TextDocument,
): vscode.FoldingRange[] {
    const ranges: vscode.FoldingRange[] = [];
    for (const region of regions.of(document))
        for (const range of foldingRanges(region.doc)) {
            const at = regions.range(document, region, range)!;
            const start = at.start.line;
            const end = at.end.line - (range.comment ? 0 : 1);
            if (end > start)
                ranges.push(
                    new vscode.FoldingRange(
                        start,
                        end,
                        range.comment ? vscode.FoldingRangeKind.Comment : undefined,
                    ),
                );
        }
    return ranges;
}

const kinds: Record<SymbolKind, vscode.SymbolKind> = {
    [SymbolKind.Function]: vscode.SymbolKind.Function,
    [SymbolKind.Struct]: vscode.SymbolKind.Struct,
    [SymbolKind.Field]: vscode.SymbolKind.Field,
    [SymbolKind.Variable]: vscode.SymbolKind.Variable,
    [SymbolKind.Constant]: vscode.SymbolKind.Constant,
    [SymbolKind.TypeAlias]: vscode.SymbolKind.TypeParameter,
};
