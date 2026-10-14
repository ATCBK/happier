import * as React from 'react';
import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export function ChangedFilesSectionHeader(props: {
    theme: any;
    color: string;
    children: React.ReactNode;
}): React.ReactElement {
    const { theme, color, children } = props;
    return (
        <View
            style={{
                backgroundColor: theme.colors.surface.inset,
                paddingHorizontal: theme.space.s16,
                paddingVertical: theme.space.s12,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.border.default,
            }}
        >
            <Text
                style={{
                    ...Typography.variant('label', 'semiBold'),
                    color,
                }}
            >
                {children}
            </Text>
        </View>
    );
}
