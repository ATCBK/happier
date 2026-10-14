import type { ReactElement } from 'react';

import { HappierApprovalPendingNotice } from '../presentation/interaction/ApprovalPendingNotice.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type ApprovalPendingNoticeProps = Readonly<{
  /**
   * `banner` (default): the one notice a page shows above what is waiting. `line`: the compact form
   * among a picker's or bar's other status lines; it names `subject` first.
   */
  presentation?: 'banner' | 'line';
  /** What is waiting ("DeepSeek V4 Pro"). The line truncates it first so the status stays readable. */
  subject?: string | null;
  /** The waiting state; Happier's "Waiting for approval" when omitted. */
  title?: string;
  titleKey?: string;
  /** The banner's sentence beneath the title: what finishes once it is approved. */
  description?: string;
  descriptionKey?: string;
  /** The open control's name; Happier's "Open approval" when omitted. */
  openLabel?: string;
  openLabelKey?: string;
  /** Open the approval (an Inbox link, a host surface). Approving, waiting and settling stay with the request's owner. */
  onOpen: () => unknown;
  testID?: string;
}>;

/**
 * A request that is waiting for someone's approval: what waits, that it waits, and the way to the
 * approval — the same notice Happier shows on its own pages and pickers. Controlled presentation: the
 * author says when a request waits and what opening it does.
 */
export function ApprovalPendingNotice(props: ApprovalPendingNoticeProps): ReactElement {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const presentation = props.presentation ?? 'banner';
  const title = resolveAuthorText(translate, props.title, props.titleKey)
    ?? translate('happier.plugin-ui.approvalPending.title', 'Waiting for approval');
  const openLabel = resolveAuthorText(translate, props.openLabel, props.openLabelKey)
    ?? translate('happier.plugin-ui.approvalPending.open', 'Open approval');
  const openTestID = props.testID ? `${props.testID}.open` : undefined;
  return (
    <HappierApprovalPendingNotice
      presentation={presentation}
      testID={props.testID}
      theme={theme}
      subject={props.subject}
      title={title}
      description={resolveAuthorText(translate, props.description, props.descriptionKey)}
      icon={<Icon name="info" size={presentation === 'line' ? 'small' : 'medium'} tone={presentation === 'line' ? 'secondary' : 'neutral'} />}
      open={presentation === 'line'
        ? <Button testID={openTestID} variant="plain" size="small" accessibilityLabel={openLabel} icon={<Icon name="forward" size="small" tone="secondary" />} onPress={props.onOpen} />
        : <Button testID={openTestID} variant="secondary" size="small" title={openLabel} onPress={props.onOpen} />}
    />
  );
}
