import * as React from 'react';

import { NavigationPlacementCustomizer, type NavigationPlacementItem } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';

type CustomizerProps = React.ComponentProps<typeof NavigationPlacementCustomizer>;

/**
 * The Attachments row records where Attach belongs when uploads are admitted; it does not decide
 * whether they are. A disabled Home/build capability has no local Settings switch to repair it.
 */
function useAttachmentsRow(): ((item: NavigationPlacementItem) => NavigationPlacementItem) {
  const decision = useFeatureDecision('attachments.uploads');
  if (decision === null || decision.state === 'enabled') return item => item;
  return item => ({ ...item, placementNote: t('navigationPlacement.attachmentsUnavailable') });
}

/** The shared composer customizer plus the one availability fact only this surface knows. */
export function ComposerPlacementCustomizer(props: CustomizerProps & CustomModalInjectedProps) {
  const annotateAttachments = useAttachmentsRow();
  const items = props.items.map(item => item.id === 'attachments' ? annotateAttachments(item) : item);
  return <NavigationPlacementCustomizer {...props} items={items} />;
}
