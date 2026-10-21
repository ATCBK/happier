import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierReplyQuote, type HappierReplyQuoteSource, type HappierReplyQuoteTextProps, type ReplyQuoteProps } from '@happier-dev/plugin-ui/components';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';

const sourceMarks = { message: 'chats-circle', doc_passage: 'file-text', task: 'check-square' } satisfies Record<ReplyQuoteProps['kind'], IconName>;

/** Core supplies its scaled text and theme to the same source quote plugins use. */
export function ReplyQuote(props: Readonly<{
    testID?: string;
    kind: ReplyQuoteProps['kind'];
    source: HappierReplyQuoteSource;
}>) {
    const { theme } = useUnistyles();
    return <HappierReplyQuote testID={props.testID} source={props.source} Text={QuoteText}
        leading={<Icon name={sourceMarks[props.kind]} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
        colors={{ text: theme.colors.text.primary, secondaryText: theme.colors.text.secondary,
            border: theme.colors.border.default, focus: theme.colors.border.focus }} space={theme.space} />;
}

function QuoteText(props: HappierReplyQuoteTextProps) {
    return <Text testID={props.testID} variant="meta" emphasis={props.role === 'source' ? 'semiBold' : undefined}
        numberOfLines={props.numberOfLines} style={[{ color: props.color }, props.style]}>{props.children}</Text>;
}
