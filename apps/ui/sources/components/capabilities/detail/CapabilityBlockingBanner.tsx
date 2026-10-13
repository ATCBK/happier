import * as React from 'react';

import { presentCapabilityStatus, type CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';

/**
 * The one notice a blocked capability page leads with: what stopped working, what that means for the
 * person's sessions, and the one fix. Only for a status that blocks (needs you: amber; failed: rose);
 * quiet and neutral statuses stay in the header and rows. Drawn by the shared tinted page notice.
 */
export function CapabilityBlockingBanner(props: Readonly<{
    status: CapabilityStatus;
    title: string;
    body: string;
    testID?: string;
}>): React.ReactElement | null {
    const presentation = presentCapabilityStatus(props.status, 'header');
    if (presentation.tone !== 'needs_you' && presentation.tone !== 'failed') return null;
    const fix = props.status.fix;
    return (
        <AttentionBanner
            testID={props.testID ?? 'capability.banner'}
            tone={presentation.tone === 'failed' ? 'danger' : 'warning'}
            title={props.title}
            description={props.body}
            action={fix && presentation.fixLabel ? { label: presentation.fixLabel, onPress: fix.onPress, ...(presentation.tone === 'failed' ? { display: 'secondary' as const } : {}) } : null}
        />
    );
}
