import type { ReactElement } from 'react';

import { useOptionalHappierUiPalette } from '../environment/context.js';
import { HAPPIER_SPACE_STEPS } from '../environment/spacing.js';
import { HappierThreadMessage, type HappierThreadMessageProps } from '../presentation/content/ThreadMessage.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type ThreadMessageProps = Omit<HappierThreadMessageProps, 'space' | 'selectionColors' | 'style'>;

/** The Discussion's grouped-message frame, with the current plugin theme. */
export function ThreadMessage(props: ThreadMessageProps): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  return <HappierThreadMessage {...props} space={HAPPIER_SPACE_STEPS}
    selectionColors={{ background: palette?.navigationSelected ?? theme.colors.elevatedSurface,
      foreground: palette?.selection ?? theme.colors.text }} />;
}
