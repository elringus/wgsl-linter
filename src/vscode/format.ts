import * as vscode from "vscode";
import { extractTemplates, type Template } from "../embed.ts";
import { format } from "../service/format.ts";
import type { Regions } from "./regions.ts";

/** Formats the WGSL templates with the tags in the editor's document. */
export function formatTemplates(
    { document, options }: vscode.TextEditor,
    edit: vscode.TextEditorEdit,
    tags: readonly string[] = ["wgsl"],
): void {
    const text = document.getText();
    const indent = indentOf(options as vscode.FormattingOptions);
    for (const template of extractTemplates(text, tags)) {
        const formatted = formatTemplate(text, template, indent);
        if (formatted === text.slice(template.start, template.end)) continue;
        const range = new vscode.Range(
            document.positionAt(template.start),
            document.positionAt(template.end),
        );
        edit.replace(range, formatted);
    }
}

export function provideFormatting(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
): vscode.TextEdit[] {
    const text = document.getText();
    const formatted = format(text, { indent: indentOf(options) });
    if (formatted === text) return [];
    const all = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
    return [vscode.TextEdit.replace(all, formatted)];
}

export function provideFormatTemplateAction(
    regions: Regions,
    document: vscode.TextDocument,
    range: vscode.Range,
): vscode.CodeAction[] {
    const template = regions.at(document, range.start)?.[0].template;
    if (!template) return [];
    const text = document.getText();
    const editor = vscode.window.activeTextEditor;
    const indent =
        editor?.document === document
            ? indentOf(editor.options as vscode.FormattingOptions)
            : "    ";
    const formatted = formatTemplate(text, template, indent);
    if (formatted === text.slice(template.start, template.end)) return [];
    const action = new vscode.CodeAction(
        "Format WGSL template",
        vscode.CodeActionKind.RefactorRewrite,
    );
    action.edit = new vscode.WorkspaceEdit();
    const target = new vscode.Range(
        document.positionAt(template.start),
        document.positionAt(template.end),
    );
    action.edit.replace(document.uri, target, formatted);
    return [action];
}

/** Formats the template's content, indenting the lines one level deeper than the template's line. */
function formatTemplate(text: string, template: Template, indent: string): string {
    const content = text.slice(template.start, template.end);
    const formatted = format(template.text, { indent, source: content }).trimEnd();
    if (!content.includes("\n")) return formatted;
    const lineStart = text.lastIndexOf("\n", template.start - 1) + 1;
    const base = /^[ \t]*/.exec(text.slice(lineStart))![0];
    const lines = formatted.split(/\r?\n/).map(line => (line ? base + indent + line : line));
    const newline = content.includes("\r\n") ? "\r\n" : "\n";
    return newline + lines.join(newline) + newline + base;
}

function indentOf(options: vscode.FormattingOptions): string {
    return options.insertSpaces ? " ".repeat(options.tabSize) : "\t";
}
