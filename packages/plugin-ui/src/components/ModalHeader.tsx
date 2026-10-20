import type { ReactElement, ReactNode } from 'react';

import { HappierModalHeader } from '../presentation/layout/ModalHeader.js';
import { IconButton } from './Button.js';
import { Icon } from './Icon.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type ModalHeaderProps = Readonly<{
  /** The dialog's name ("Link a pull request"). */
  title?: string;
  titleKey?: string;
  /** One line saying what it is for or what it acts on. */
  subtitle?: string;
  subtitleKey?: string;
  /** A leading identity mark (your `BrandMark`, an avatar). */
  leading?: ReactNode;
  /** Context controls beside the title (a target chip, a filter); they move beneath it on a phone. */
  actions?: ReactNode;
  /** Draws the close control. */
  onClose?: () => void;
  /** Overrides the host's "Close" for the close control's accessible name. */
  closeAccessibilityLabel?: string;
  /** The dialog is on a phone (a narrow card): the title keeps its row and the actions move beneath. */
  compact?: boolean;
  testID?: string;
}>;

/**
 * The title band Happier's own dialogs and sheets draw: title and subtitle, optional actions, close.
 * On a compact card with actions it recomposes the same way the host's does.
 */
export function ModalHeader(props: ModalHeaderProps): ReactElement | null {
  const translate = usePluginTranslation();
  const title = resolveAuthorText(translate, props.title, props.titleKey);
  const subtitle = resolveAuthorText(translate, props.subtitle, props.subtitleKey);
  const closeLabel =
    props.closeAccessibilityLabel ??
    translate('happier.plugin-ui.modalHeader.close', 'Close');
  return (
    <HappierModalHeader
      leading={props.leading}
      title={title}
      subtitle={subtitle}
      actions={props.actions}
      close={
        props.onClose ? (
          <IconButton
            accessibilityLabel={closeLabel}
            icon={<Icon name="close" tone="secondary" />}
            testID={props.testID ? `${props.testID}-close` : undefined}
            onPress={props.onClose}
          />
        ) : null
      }
      compact={props.compact}
      testID={props.testID}
      titleTestID={props.testID ? `${props.testID}-title` : undefined}
      subtitleTestID={props.testID ? `${props.testID}-subtitle` : undefined}
    />
  );
}
