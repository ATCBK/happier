import * as React from 'react';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { useSetting } from '@/sync/store/settingsReadHooks';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';


interface CodeViewProps {
    code: string;
    language?: string;
    findRanges?: readonly FindTextRange[];
    /** Wrap long lines in place (a details page reads the whole value); scrolls sideways by default. */
    wrap?: boolean;
}

export const CodeView = React.memo<CodeViewProps>(({ 
    code, 
    language,
    findRanges,
    wrap = false,
}) => {
    const jsonInferenceMaxBytes = useSetting('filesCodeViewJsonInferenceMaxBytes') as number | null;

    const resolvedLanguage = React.useMemo(() => {
        if (typeof language === 'string' && language.trim()) return language.trim();
        const trimmed = String(code ?? '').trim();
        if (!trimmed) return null;
        // Best-effort: infer JSON for common tool input/output blocks (frequently `JSON.stringify`).
        const budget = typeof jsonInferenceMaxBytes === 'number' ? jsonInferenceMaxBytes : 0;
        const canInferJson = budget > 0 && trimmed.length <= budget;

        if (canInferJson && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
            try {
                JSON.parse(trimmed);
                return 'json';
            } catch {
                // ignore
            }
        }
        return null;
    }, [code, jsonInferenceMaxBytes, language]);

    return (
        <CodeBlockView
            code={code}
            language={resolvedLanguage}
            selectable={true}
            wrap={wrap}
            showCopyButton={true}
            findRanges={findRanges}
        />
    );
});
