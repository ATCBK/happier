import * as React from 'react';

import type { PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import { useArtifact } from '@/sync/domains/state/storage';
import { t } from '@/text';

/**
 * The origin of a saved prompt for its editor header. A new draft has none.
 */
export function usePromptLibraryEntryMeta(artifactId: string | null, qualified?: Readonly<{
    header: Readonly<Record<string, unknown>> | null;
}>): readonly PageHeaderMetaFact[] {
    const artifact = useArtifact(qualified ? '' : artifactId ?? '');
    const header = qualified ? qualified.header : artifact?.header;
    const origin = artifactId && typeof header?.origin === 'string' ? header.origin : null;
    return React.useMemo(() => {
        const facts: PageHeaderMetaFact[] = [];
        if (origin === 'imported') facts.push({ key: 'origin', text: t('promptLibrary.imported') });
        if (origin === 'built_in') facts.push({ key: 'origin', text: t('promptLibrary.builtIn') });
        return facts;
    }, [origin]);
}
