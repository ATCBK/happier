import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { TrackCaretSpecimen } from '@/components/dev/track/TrackCaretSpecimen';

/** Dev-only: Track's agent caret and wash in the File page body (lab tr T1). `?mode=diff|edit`, `?line=<n>`. */
export default function TrackDevScreen() {
    const params = useLocalSearchParams<{ mode?: string; line?: string }>();
    const line = typeof params.line === 'string' ? Number.parseInt(params.line, 10) : NaN;
    return <TrackCaretSpecimen mode={params.mode === 'diff' || params.mode === 'edit' ? params.mode : 'file'} line={Number.isFinite(line) && line > 1 ? line : null} />;
}
