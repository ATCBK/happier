import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { EYEBROW_TYPOGRAPHY } from '@/constants/Typography';

import { Text, type AppTextProps } from './Text';

export type EyebrowProps = AppTextProps;

const stylesheet = StyleSheet.create((theme) => ({
    text: {
        ...EYEBROW_TYPOGRAPHY,
        color: theme.colors.text.secondary,
    },
}));

export function Eyebrow({ style, ...props }: EyebrowProps): React.ReactElement {
    const styles = stylesheet;
    return (
        <Text
            {...props}
            style={[styles.text, style]}
        />
    );
}
