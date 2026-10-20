import * as React from 'react';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { isBrowserPreviewRefusalReasonCode } from '@/sync/domains/browser/adapters/targets/localPreview';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

/**
 * A failure that did NOT replace the page.
 *
 * A failed sub-navigation leaves the previous document rendered, so `BrowserFrameError` never
 * appears and the only evidence would otherwise be that nothing happened. The page stays at full
 * strength and one freshness line says what failed, with the one recovery (Retry) — the canonical
 * stale-but-retained owner, not a full-strength danger strip with nothing to do. Returns `null` the
 * rest of the time: the address field owns the URL and the progress line owns loading.
 */
export function BrowserStatusBar(props: Readonly<{
    view: BrowserControlViewState | null;
    onRetry?: () => void;
    testID?: string;
}>): React.ReactElement | null {
    const lastError = props.view?.lastError;
    // A relay preview's refusal replaced the page: the frame's own state card says it, once.
    if (!lastError || isBrowserPreviewRefusalReasonCode(lastError)) {
        return null;
    }
    const copy = resolveReasonCopy({ reasonCode: lastError, kind: 'browserStatus' });
    return (
        <SurfaceFreshnessLine
            testID={props.testID}
            reason={copy.message}
            tone="warning"
            {...(props.onRetry ? { action: { label: t('common.retry'), onPress: props.onRetry } } : {})}
        />
    );
}
