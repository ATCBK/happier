import type { ReactElement } from 'react';

import { useOptionalHappierUiTypography } from '../environment/context.js';
import { HappierReplyQuote, type HappierReplyQuoteSource, type HappierReplyQuoteTextProps } from '../presentation/content/ReplyQuote.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { Icon, type IconName } from './Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type ReplyQuoteProps = Readonly<{
  testID?: string;
  kind: 'message' | 'doc_passage' | 'task';
  source: HappierReplyQuoteSource;
}>;

const sourceMarks = { message: 'conversations', doc_passage: 'file', task: 'issue' } satisfies Record<ReplyQuoteProps['kind'], IconName>;

/** Source reads and routing stay with the author; the host owns the quote's presentation. */
export function ReplyQuote(props: ReplyQuoteProps): ReactElement {
  const theme = usePluginTheme();
  return <HappierReplyQuote testID={props.testID} source={props.source} Text={QuoteText}
    leading={<Icon name={sourceMarks[props.kind]} size="small" tone="secondary" />}
    colors={{ text: theme.colors.text, secondaryText: theme.colors.secondaryText, border: theme.colors.divider, focus: theme.colors.focus }} />;
}

function QuoteText(props: HappierReplyQuoteTextProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  return <HappierText testID={props.testID} numberOfLines={props.numberOfLines} style={[
    resolveHappierTypeRoleStyle('meta', theme, typography, props.role === 'source' ? 'semiBold' : undefined),
    { color: props.color }, props.style,
  ]}>{props.children}</HappierText>;
}
