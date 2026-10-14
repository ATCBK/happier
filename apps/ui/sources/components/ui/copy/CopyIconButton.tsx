import * as React from 'react';
import { Platform, Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { t } from '@/text';

const ICON_SIZE = 14;
const HORIZONTAL_PADDING = 8;
export const COPY_ICON_BUTTON_WIDTH = ICON_SIZE + HORIZONTAL_PADDING * 2;

export type CopyIconButtonProps = Readonly<{
    /** The text to copy; pass a function when building it is not free, so it only runs on press. */
    text: string | (() => string);
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

export const CopyIconButton = React.memo<CopyIconButtonProps>(({ text, style, testID }) => {
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const { copy, isCopied } = useHappierCopyFeedback();
    const copied = isCopied();

    const onCopy = React.useCallback(() => copy(
        () => setClipboardStringSafe(typeof text === 'function' ? text() : text),
    ), [copy, text]);

    return (
        <Pressable
            testID={testID}
            style={[styles.button, style, (isWeb && isHovered) ? styles.buttonHovered : null]}
            onPress={onCopy}
            onHoverIn={isWeb ? () => setIsHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
            accessibilityRole="button"
            accessibilityLabel={t('common.copy')}
        >
            <Icon
                name={copied ? 'check' : 'copy'}
                size={ICON_SIZE}
                color={copied ? (theme.colors.state.success.foreground ?? theme.colors.text.secondary) : theme.colors.text.secondary}
            />
        </Pressable>
    );
});

const styles = StyleSheet.create(() => ({
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: HORIZONTAL_PADDING,
        paddingVertical: 6,
        borderRadius: 8,
    },
    buttonHovered: {
        opacity: 0.85,
    },
}));
