import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import type { SessionDiscussionOpenedSummaryV1 } from '@happier-dev/protocol';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { Item } from '@/components/ui/lists/Item';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { ITEM_SUBTITLE_TEXT_METRICS, ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

/** The protocol supplies at most three recent authors. */
const AUTHOR_AVATAR_PX = 20;

const styles = StyleSheet.create((theme) => ({
    title: {
        ...Typography.default(),
        ...ITEM_TITLE_TEXT_METRICS.compact,
        color: theme.colors.text.primary,
    },
    titleUnread: { ...Typography.default('semiBold') },
    subtitle: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.compact,
        color: theme.colors.text.secondary,
    },
    trailing: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, flexShrink: 0 },
    badge: { position: 'relative', top: 0, right: 0 },
    time: {
        ...Typography.default(),
        ...ITEM_SUBTITLE_TEXT_METRICS.tight,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
}));

type RowLabels = Readonly<{
    you: string;
    viaAgent: string;
    messages: (count: number) => string;
    unread: (count: number) => string;
    mentions: (count: number) => string;
}>;

/**
 * The row's second line: who wrote last, then how long the conversation is. Unread and mention
 * counts are not repeated here — they are the badges at the row's end.
 */
export function buildSessionDiscussionRowSubtitle(input: Readonly<{
    latestAuthor: string | null;
    latestIsViewer: boolean;
    producedByAgent: boolean;
    messageCount: number;
    labels: RowLabels;
}>): readonly string[] {
    const author = input.latestIsViewer ? input.labels.you : input.latestAuthor;
    return [
        author ?? '',
        input.producedByAgent ? input.labels.viaAgent : '',
        input.labels.messages(input.messageCount),
    ].filter((value) => value.length > 0);
}

/** One spoken name for the row: the title, the attention the badges carry, the subtitle, the time. */
export function buildSessionDiscussionRowAccessibilityLabel(input: Readonly<{
    title: string;
    subtitle: readonly string[];
    unreadCount: number;
    unreadMentionCount: number;
    relativeTime: string;
    labels: Pick<RowLabels, 'unread' | 'mentions'>;
}>): string {
    const facts = [
        input.unreadMentionCount > 0 ? input.labels.mentions(input.unreadMentionCount) : '',
        input.unreadCount > 0 ? input.labels.unread(input.unreadCount) : '',
        ...input.subtitle,
        input.relativeTime,
    ].filter((value) => value.length > 0);
    return `${input.title}. ${facts.join(', ')}`;
}

function readLatestAuthorName(discussion: SessionDiscussionOpenedSummaryV1): string | null {
    const actor = discussion.latestMessage.accountActor;
    if (!actor) return null;
    if (actor.profile === null) return t('message.accountActorFormerMember');
    return formatAccountDisplayName(actor.profile) ?? t('message.accountActorUnnamedMember');
}

function readAuthorImage(discussion: SessionDiscussionOpenedSummaryV1, accountId: string): string | null {
    const actor = discussion.latestMessage.accountActor;
    return actor?.accountId === accountId ? actor.profile?.avatarUrl ?? null : null;
}

const rowLabels: RowLabels = {
    get you() { return t('session.collaboration.pane.you'); },
    get viaAgent() { return t('session.collaboration.discussion.viaAgent'); },
    messages: (count) => t('session.collaboration.discussion.messageCount', { count }),
    unread: (count) => t('session.collaboration.discussion.unreadCount', { count }),
    mentions: (count) => t('session.collaboration.discussion.unreadMentionCount', { count }),
};

/**
 * One conversation in the Collaboration pane (lab C1): up to three recent authors, the title (bold
 * while unread), who wrote last and how many messages, then the mention indicator, unread count and the
 * time at the row's end.
 */
export const SessionDiscussionRow = React.memo(function SessionDiscussionRow(props: Readonly<{
    discussion: SessionDiscussionOpenedSummaryV1;
    /** The viewing Account, so its own last message reads "You". */
    viewerAccountId: string;
    onPress: () => void;
    selected?: boolean;
}>): React.ReactElement {
    const { discussion } = props;
    const title = discussion.title ?? t('session.collaboration.discussion.encryptedTitle');
    const unread = discussion.unreadCount > 0;
    const mentioned = unread && discussion.unreadMentionCount > 0;
    const relativeTime = formatShortRelativeTime(discussion.latestMessage.createdAt);
    const subtitle = buildSessionDiscussionRowSubtitle({
        latestAuthor: readLatestAuthorName(discussion),
        latestIsViewer: discussion.latestMessage.authorAccountId === props.viewerAccountId,
        producedByAgent: discussion.latestMessage.producerV1 !== null,
        messageCount: discussion.messageSeq,
        labels: rowLabels,
    });
    const authors = discussion.recentAuthorAccountIds.slice(0, 3);
    return (
        <Item
            testID={`session-discussion-row-${discussion.id}`}
            accessibilityRole="button"
            accessibilityLabel={buildSessionDiscussionRowAccessibilityLabel({
                title,
                subtitle,
                unreadCount: discussion.unreadCount,
                unreadMentionCount: mentioned ? discussion.unreadMentionCount : 0,
                relativeTime,
                labels: rowLabels,
            })}
            selected={props.selected ?? false}
            onPress={props.onPress}
            density="compact"
            showChevron={false}
            showDivider={false}
            leftElement={<AvatarStack
                testID={`session-discussion-row-recent-authors-${discussion.id}`}
                size={AUTHOR_AVATAR_PX}
                reservedCount={3}
                entries={authors.map((accountId) => ({
                    key: accountId,
                    testID: `session-discussion-row-recent-author-${discussion.id}-${accountId}`,
                    content: <Avatar id={accountId} imageUrl={readAuthorImage(discussion, accountId)} size={AUTHOR_AVATAR_PX} />,
                }))}
            />}
            title={<Text
                    testID={`session-discussion-row-title-${discussion.id}`}
                    style={[styles.title, unread ? styles.titleUnread : null]}
                    numberOfLines={1}
                >
                    {title}
                </Text>}
            subtitle={<Text style={styles.subtitle} numberOfLines={1}>{subtitle.join(' · ')}</Text>}
            rightElement={<View style={styles.trailing} accessible={false} importantForAccessibility="no-hide-descendants">
                {mentioned ? (
                    <TabBadge testID={`session-discussion-row-mention-${discussion.id}`} variant="dot" tone="attention" style={styles.badge} />
                ) : null}
                {unread ? (
                    <TabBadge testID={`session-discussion-row-unread-${discussion.id}`} variant="count" value={discussion.unreadCount} tone="neutral" style={styles.badge} />
                ) : null}
                {relativeTime ? <Text style={styles.time}>{relativeTime}</Text> : null}
            </View>}
        />
    );
});

const SKELETON_TITLE_WIDTHS = ['62%', '78%', '54%'] as const;

/**
 * A conversation row's reserved shape while the first page is read: the author mark, the title and
 * the second line, at the row's own geometry so the list does not move when the rows arrive.
 */
export function SessionDiscussionRowSkeleton(props: Readonly<{ index: number; testID?: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const color = theme.colors.surface.pressedOverlay;
    return (
        <View testID={props.testID} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Item
                mode="info" density="compact" showChevron={false} showDivider={false}
                leftElement={<AvatarStack size={AUTHOR_AVATAR_PX} reservedCount={3} entries={[{
                    key: 'author', avatar: false,
                    content: <HappierSkeletonBlock color={color} width={AUTHOR_AVATAR_PX} height={AUTHOR_AVATAR_PX} radius={AUTHOR_AVATAR_PX / 2} reducedMotion={reducedMotion} />,
                }]} />}
                title={<HappierSkeletonBlock color={color} width={SKELETON_TITLE_WIDTHS[props.index % SKELETON_TITLE_WIDTHS.length]} height={10} reducedMotion={reducedMotion} />}
                subtitle={<HappierSkeletonBlock color={color} width="36%" height={8} reducedMotion={reducedMotion} />}
            />
        </View>
    );
}
