import * as vscode from "vscode";
import { Diagnostics } from "./diagnostics.ts";
import { Regions } from "./regions.ts";
import { features } from "./register.ts";

export { formatTemplates } from "./format.ts";
export type { Options } from "./regions.ts";
export { register } from "./register.ts";

/** Activates the extension with the workspace settings. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const regions = new Regions({});
    await regions.loadPreludes();
    const diagnostics = new Diagnostics(regions);
    const disposables = [
        ...features(regions, diagnostics),
        ...regions.watchPreludes(() => diagnostics.lintAll()),
    ];
    context.subscriptions.push(vscode.Disposable.from(...disposables));
}
