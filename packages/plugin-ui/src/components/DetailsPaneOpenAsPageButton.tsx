import type { ReactElement } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

export type DetailsPaneOpenAsPageButtonProps = Readonly<{
  onPress: () => unknown;
  disabled?: boolean;
  testID?: string;
  /** Omit to use the host's translated Open as page label and tooltip. */
  accessibilityLabel?: string;
}>;

/**
 * The host's Open as page control, shared by core and authored DetailsPane actions.
 * The caller owns navigation: bind onPress to replacePageLocation(subPath, { backLocation }).
 */
export function DetailsPaneOpenAsPageButton(props: DetailsPaneOpenAsPageButtonProps): ReactElement | null {
  const host = useOptionalPluginUiPresentationHost();
  return host?.renderDetailsPaneOpenAsPageButton ? <>{host.renderDetailsPaneOpenAsPageButton(props)}</> : null;
}
