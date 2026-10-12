import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { TranscriptFindRevealSpecimen } from '@/components/dev/transcriptFind/TranscriptFindRevealSpecimen';

/** Dev-only: the real chat transcript with Find over a local history, for the reveal browser regression. */
export default function TranscriptFindDevScreen(): React.ReactElement {
    const params = useLocalSearchParams<{ hydrateAfterMs?: string; older?: string; olderDelayMs?: string }>();
    const hydrateAfterMs = Number(params.hydrateAfterMs ?? 0);
    const olderDelayMs = Number(params.olderDelayMs ?? 1500);
    return <TranscriptFindRevealSpecimen
        hydrateAfterMs={Number.isFinite(hydrateAfterMs) ? hydrateAfterMs : 0}
        withOlderHistory={params.older === '1'}
        olderDelayMs={Number.isFinite(olderDelayMs) ? olderDelayMs : 1500} />;
}
