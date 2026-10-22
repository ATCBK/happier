import * as React from 'react';
import { resolveHappierCapabilityBlockingNotice } from '@happier-dev/plugin-ui/presentation';

import { capabilityStatusLabels, type CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';

/**
 * The one notice a blocked capability page leads with: what stopped working, what that means for the
 * person's sessions, and the one fix. Whether it shows, its tone and its action come from the shared
 * capability status owner; drawn by the shared tinted page notice.
 */
export function CapabilityBlockingBanner(props: Readonly<{
    status: CapabilityStatus;
    title: string;
    body: string;
    testID?: string;
}>): React.ReactElement | null {
    const notice = resolveHappierCapabilityBlockingNotice(props.status, capabilityStatusLabels);
    if (notice === null) return null;
    return (
        <AttentionBanner
            testID={props.testID ?? 'capability.banner'}
            tone={notice.tone}
            title={props.title}
            description={props.body}
            action={notice.action}
        />
    );
}
