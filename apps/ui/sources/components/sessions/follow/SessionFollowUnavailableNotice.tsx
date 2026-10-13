import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { t } from '@/text';

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: theme.space.s16 },
    title: { textAlign: 'center', marginBottom: theme.space.s8 },
    description: { textAlign: 'center', color: theme.colors.text.secondary },
    back: { marginTop: theme.space.s16 },
}));

/**
 * Settled "you cannot Follow from here" state for the direct Follow route.
 *
 * The route is reachable from a link, a notification and a deep link, so the two ways the
 * editor can fail to appear must say which one happened instead of rendering an empty screen:
 * a Home that does not offer Following is a settled answer, while a Home this device could not
 * reach is a retry. The back target is the exact Session address the link named, never an
 * ambient Home.
 */
export function SessionFollowUnavailableNotice(props: Readonly<{
    onBack: () => void;
    reason?: 'unsupported' | 'unreachable';
    onRetry?: () => void;
}>): React.ReactElement {
    const maxWidthStyle = useLayoutMaxWidthStyle();
    const unreachable = props.reason === 'unreachable';
    const testID = unreachable ? 'session-follow-unreachable' : 'session-follow-unavailable';
    return (
        <View testID={testID} style={[styles.root, maxWidthStyle]}>
            <Text style={styles.title}>
                {unreachable ? t('session.follow.unreachableTitle') : t('session.follow.unavailableTitle')}
            </Text>
            <Text style={styles.description}>
                {unreachable
                    ? t('session.follow.unreachableDescription')
                    : t('session.follow.unavailableDescription')}
            </Text>
            {props.onRetry ? (
                <RoundButton
                    title={t('common.retry')}
                    display="default"
                    size="normal"
                    onPress={props.onRetry}
                    testID={`${testID}.retry`}
                    style={styles.back}
                />
            ) : null}
            <RoundButton
                title={t('common.back')}
                display="inverted"
                size="normal"
                onPress={props.onBack}
                testID={`${testID}.back`}
                style={styles.back}
            />
        </View>
    );
}
