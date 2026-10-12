import * as React from 'react';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';

import type { ArtifactQuota } from './artifactActionsClient';

/**
 * `quota_exceeded`, said once above the content it blocks (lab A8 / A8p): which budget, the size and
 * the cap, and how to recover. The browser shows the full Account budget; the editor shows the refusal.
 * It is the app's one tinted notice (`AttentionBanner`), not an Artifacts-local callout.
 */
export function ArtifactQuotaNotice(
  props: Readonly<{
    quota: ArtifactQuota;
    testID: string;
    placement?: 'page-section' | 'inline';
  }>,
): React.ReactElement {
  const used = formatHappierDataBytes(props.quota.usedBytes, {
    kind: 'storage',
  });
  const limit = formatHappierDataBytes(props.quota.limitBytes, {
    kind: 'storage',
  });
  const document = props.quota.budget === 'document';
  return (
    <AttentionBanner
      testID={props.testID}
      tone="warning"
      placement={props.placement}
      announce="alert"
      title={
        document
          ? t('artifacts.browser.quota.documentTitle')
          : t('artifacts.browser.quota.accountTitle')
      }
      description={
        document
          ? t('artifacts.browser.quota.documentBody', { size: used, limit })
          : t('artifacts.browser.quota.accountBody', { used, limit })
      }
    />
  );
}
