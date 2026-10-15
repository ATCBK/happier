import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { IconButton, type IconButtonVariant } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { t } from '@/text';

const ICON_SIZE = 14;
const HORIZONTAL_PADDING = 8;
const COPY_ICON_BUTTON_SIZE = ICON_SIZE + HORIZONTAL_PADDING * 2;
export const COPY_ICON_BUTTON_WIDTH = Math.max(COPY_ICON_BUTTON_SIZE, resolveMinimumInteractiveTargetSize(Platform.OS));

export type CopyIconButtonProps = Readonly<{
    /** The text to copy; pass a function when building it is not free, so it only runs on press. */
    text: string | (() => string);
    /** Placement only; interaction chrome belongs to IconButton. */
    style?: StyleProp<ViewStyle>;
    variant?: IconButtonVariant;
    testID?: string;
}>;

export const CopyIconButton = React.memo<CopyIconButtonProps>(({ text, style, testID, variant = 'plain' }) => {
    const { theme } = useUnistyles();
    const { copy, isCopied } = useHappierCopyFeedback();
    const copied = isCopied();

    const onCopy = React.useCallback(() => copy(
        () => setClipboardStringSafe(typeof text === 'function' ? text() : text),
    ), [copy, text]);

    return (
        <View style={style}>
            <IconButton
                testID={testID}
                size={COPY_ICON_BUTTON_SIZE}
                iconSize={ICON_SIZE}
                variant={variant}
                minimumInteractiveTargetSize={COPY_ICON_BUTTON_WIDTH}
                onPress={onCopy}
                accessibilityLabel={t('common.copy')}
                icon={(
                    <Icon
                        name={copied ? 'check' : 'copy'}
                        size={ICON_SIZE}
                        color={copied ? (theme.colors.state.success.foreground ?? theme.colors.text.secondary) : theme.colors.text.secondary}
                    />
                )}
            />
        </View>
    );
});
