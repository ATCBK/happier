import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TranscriptAccountActor } from "@happier-dev/session-core/messages";
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveVisibleAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { t } from '@/text';

export type SessionMessageAccountBylineProps = Readonly<{
    messageId: string;
    actor: TranscriptAccountActor | null | undefined;
    viewerScope: ServerAccountScope | null;
    hasOtherNamedCollaborator: boolean;
}>;

export function SessionMessageAccountByline(props: SessionMessageAccountBylineProps) {
    const presentation = resolveVisibleAccountActorPresentation(props);
    if (!presentation) return null;
    const { name, avatar } = presentation;
    return (
        <View style={styles.byline}>
            <Text
                testID={`transcript-account-attribution:${props.messageId}`}
                accessibilityRole="text"
                accessibilityLabel={t('message.accountActorSentBy', { name })}
                numberOfLines={1}
                ellipsizeMode="tail"
                style={styles.name}
            >
                {name}
            </Text>
            <View
                testID={`transcript-account-avatar:${props.messageId}`}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                <Avatar
                    id={avatar.id}
                    imageUrl={avatar.imageUrl}
                    monochrome
                    size={20}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    byline: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-end',
        maxWidth: '100%',
        paddingHorizontal: theme.space.s16,
        marginBottom: theme.space.s4,
        gap: theme.space.s6,
    },
    name: {
        ...Typography.variant('meta'),
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
}));
