import React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';

export type ReviewCommentsHeaderButtonProps = Readonly<{
    labels: Readonly<{
        title: string;
        count: (params: Readonly<{ count: number }>) => string;
    }>;
    /** Unresolved comments once they have been read; null while unknown, so nothing claims "0". */
    unresolvedCount: number | null;
    expanded: boolean;
    onPress?: () => void;
    testID?: string;
}>;

/** The review comments disclosure: one quiet row in the pane's own row anatomy. */
export function ReviewCommentsHeaderButton(props: ReviewCommentsHeaderButtonProps) {
    const { theme } = useUnistyles();
    const count = props.unresolvedCount;
    return (
        <Item
            testID={props.testID}
            density="compact"
            title={props.labels.title}
            detail={count != null && count > 0 ? props.labels.count({ count }) : undefined}
            icon={<Icon name="chat-circle" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
            rightElement={<Icon name={props.expanded ? 'caret-down' : 'caret-right'} size={12} color={theme.colors.text.tertiary} />}
            accessibilityExpanded={props.expanded}
            onPress={props.onPress}
        />
    );
}
