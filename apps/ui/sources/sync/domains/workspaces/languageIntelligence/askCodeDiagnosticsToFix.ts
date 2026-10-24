import { askAboutRanges, type AskAboutFileRanges } from '@/components/ui/code/selection/askAboutRanges';
import { selectCodeDiagnostics, type CodeDiagnosticsProjection } from './codeDiagnostics';

export type AskCodeDiagnosticsToFixInput = Readonly<{
    projection: CodeDiagnosticsProjection | ReturnType<typeof selectCodeDiagnostics>;
    workspaceScope: Parameters<typeof askAboutRanges>[0]['workspaceScope'];
    sessionTarget: Parameters<typeof askAboutRanges>[0]['sessionTarget'];
    targetContext?: Parameters<typeof askAboutRanges>[0]['targetContext'];
    /** The initiating Account, File-page holder and diagnostic text still belong to this operation. */
    isCurrent(): boolean;
    readFile(path: string): Promise<Readonly<{ savedText: string | null; unsaved: boolean }> | null>;
    saveFileEdits(path: string): Promise<boolean>;
}>;
export async function askCodeDiagnosticsToFix(input: AskCodeDiagnosticsToFixInput): ReturnType<typeof askAboutRanges> {
    const diagnostics = 'entries' in input.projection ? selectCodeDiagnostics(input.projection) : input.projection;
    if (!input.isCurrent() || diagnostics.state !== 'ready' || !diagnostics.count) return { created: 0, drafts: [] };
    const groups = new Map<string, typeof diagnostics.items[number][]>();
    for (const item of diagnostics.items) {
        const items = groups.get(item.path) ?? [];
        items.push(item);
        groups.set(item.path, items);
    }
    const files: AskAboutFileRanges[] = [];
    for (const [filePath, items] of groups) {
        let file = await input.readFile(filePath);
        if (!input.isCurrent() || !file || file.savedText === null) return { created: 0, drafts: [] };
        if (file.unsaved) {
            if (!await input.saveFileEdits(filePath) || !input.isCurrent()) return { created: 0, drafts: [] };
            file = await input.readFile(filePath);
            if (!input.isCurrent() || !file || file.savedText === null || file.unsaved) return { created: 0, drafts: [] };
        }
        files.push({ filePath, savedText: file.savedText, ranges: items.map((item) => ({
            startLine: item.range.start.line + 1,
            endLine: item.range.end.line + 1 - (item.range.end.line > item.range.start.line && item.range.end.character === 0 ? 1 : 0),
            body: item.message,
        })) });
    }
    if (!input.isCurrent()) return { created: 0, drafts: [] };
    return askAboutRanges({ workspaceScope: input.workspaceScope, files, sessionTarget: input.sessionTarget,
        targetContext: input.targetContext, includeInPrompt: true, preserveRangeOccurrences: true });
}
