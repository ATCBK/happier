import { shikiTokenizeScopeLines } from '@/components/ui/code/highlighting/shiki/shikiTokenize';
import { buildDocumentOutline, type DocumentOutlineBaselineInput, type DocumentOutlineBaselineResult } from './documentOutline';

export type { DocumentOutlineBaselineInput, DocumentOutlineBaselineResult } from './documentOutline';

export async function loadDocumentOutlineBaseline(input: DocumentOutlineBaselineInput): Promise<DocumentOutlineBaselineResult> {
    try {
        const tokensByLine = await shikiTokenizeScopeLines(input);
        return { status: 'ok', symbols: buildDocumentOutline({ lines: input.lines, tokensByLine }) };
    } catch {
        return { status: 'unavailable', reason: 'grammar_engine_unavailable' };
    }
}
