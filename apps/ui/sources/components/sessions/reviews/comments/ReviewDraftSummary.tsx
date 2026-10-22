import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { filterReviewCommentDraftsIncludedInPrompt } from '@/sync/domains/input/reviewComments/reviewCommentPrompt';
import { formatReviewCommentAnchorLabel } from '@/sync/domains/input/reviewComments/reviewCommentPresentation';
import { t } from '@/text';
import { shadowLevelStyle } from '@/shadowElevation';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

/** The room a Review stream keeps under its foot so the tray never covers the last lines. */
export const REVIEW_TRAY_RESERVED_PX = 76;

export type ReviewDraftSummaryProps = Readonly<{
    enabled: boolean;
    /** Steps aside (kept mounted, so an open comment and its draft survive) while Find is seated in its place. */
    yielded?: boolean;
    drafts: readonly ReviewCommentDraft[];
    /** Hands the comments to the session composer, where they ride along with the next message. */
    onGoToComposer: () => void;
    /** Leaves one comment out of the next message (it stays saved). */
    onDetachDraft?: (draft: ReviewCommentDraft) => void;
    /**
     * When Review can send, Ask for changes grows the tray into the composer in place (SG). `text` is
     * the session's own draft (one draft owner); `onSend` sends through the one session send path.
     * Absent, Ask for changes hands off to the session composer.
     */
    composer?: Readonly<{
        text: string;
        onChangeText: (text: string) => void;
        onSend: () => void;
        sending: boolean;
    }> | null;
}>;

function firstWords(body: string): string {
    const line = body.trim().split(/\r?\n/)[0] ?? '';
    return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/**
 * Review's comment tray (details lab 2, R1/SG): it floats at the foot of the stream and gathers the
 * draft comments that go with the next message. Opened, it shows each one as a chip — where it is
 * and its first words — so any can be left out before asking the agent for changes.
 */
export function ReviewDraftSummary(props: ReviewDraftSummaryProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [open, setOpen] = React.useState(false);
    const [asking, setAsking] = React.useState(false);
    if (!props.enabled || props.drafts.length === 0) return null;
    const included = filterReviewCommentDraftsIncludedInPrompt(props.drafts);
    const composer = props.composer ?? null;
    const composing = asking && composer !== null;
    const askForChanges = () => {
        if (composer) {
            setAsking(true);
            setOpen(true);
            return;
        }
        props.onGoToComposer();
    };
    return (
        <View testID="review-drafts-summary" style={[styles.tray, composing ? styles.trayComposing : null, props.yielded ? styles.trayYielded : null]} pointerEvents="box-none">
            {composing ? (
                <View testID="review-ask-composer" style={styles.askHeader}>
                    <Icon name="chat-circle" size={16} color={theme.colors.state.active.foreground} />
                    <Text numberOfLines={1} style={styles.summaryText}>
                        <Text style={styles.summaryStrong}>{t('detailsSurface.review.askForChanges')}</Text>
                        {` · ${t('detailsSurface.review.comments', { count: included.length })}`}
                    </Text>
                    <View style={styles.grow} />
                    <IconButton
                        testID="review-ask-collapse"
                        variant="plain"
                        size={26}
                        iconSize={14}
                        iconName="caret-down"
                        accessibilityLabel={t('common.close')}
                        onPress={() => setAsking(false)}
                    />
                </View>
            ) : null}
            {(open || composing) && included.length > 0 ? (
                <View testID="review-drafts-chips" style={styles.chips}>
                    {included.map((draft) => (
                        <View key={draft.id} testID={`review-draft-chip-${draft.id}`} style={styles.chip}>
                            <Icon name="chat-circle" size={12} color={theme.colors.state.active.foreground} />
                            <Text numberOfLines={1} style={styles.chipAnchor}>{formatReviewCommentAnchorLabel(draft)}</Text>
                            <Text numberOfLines={1} style={styles.chipBody}>{firstWords(draft.body)}</Text>
                            {props.onDetachDraft ? (
                                <IconButton
                                    testID={`review-draft-chip-detach-${draft.id}`}
                                    variant="plain"
                                    size={20}
                                    iconSize={10}
                                    iconName="x"
                                    accessibilityLabel={t('detailsSurface.review.detachCommentA11y')}
                                    onPress={() => props.onDetachDraft?.(draft)}
                                />
                            ) : null}
                        </View>
                    ))}
                </View>
            ) : null}
            {composing && composer ? (
                <View style={styles.askBody}>
                    <TextInput
                        testID="review-ask-input"
                        value={composer.text}
                        onChangeText={composer.onChangeText}
                        placeholder={t('detailsSurface.review.askPlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        multiline
                        autoFocus
                        style={styles.askInput}
                    />
                    <View style={styles.askBar}>
                        <View style={styles.grow} />
                        <ToolbarButton
                            testID="review-ask-send"
                            tone="primary"
                            size="md"
                            label={t('detailsSurface.review.send')}
                            busy={composer.sending}
                            disabled={composer.sending}
                            onPress={composer.onSend}
                        />
                    </View>
                </View>
            ) : (
            <View style={styles.bar}>
                <Pressable
                    testID="review-drafts-expand"
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    onPress={() => setOpen((current) => !current)}
                    style={styles.summary}
                >
                    <Icon name="chat-circle" size={16} color={theme.colors.state.active.foreground} />
                    <Text numberOfLines={1} style={styles.summaryText}>
                        <Text style={styles.summaryStrong}>{t('detailsSurface.review.comments', { count: included.length })}</Text>
                        {` · ${t('detailsSurface.review.goesWithNext', { count: included.length })}`}
                    </Text>
                </Pressable>
                <ToolbarButton
                    testID="review-drafts-go-to-composer"
                    tone="primary"
                    size="md"
                    label={t('detailsSurface.review.askForChanges')}
                    onPress={askForChanges}
                />
            </View>
            )}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    tray: {
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 14,
        zIndex: 4,
        borderRadius: 14,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        ...shadowLevelStyle(theme.colors.shadowLevels[3]),
        overflow: 'hidden',
    },
    trayComposing: {
        left: 12,
        right: 12,
        bottom: 12,
        borderRadius: 18,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    trayYielded: {
        display: 'none',
    },
    askHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingTop: theme.space.s10,
        paddingHorizontal: 14,
    },
    askBody: {
        paddingHorizontal: theme.space.s12,
        paddingBottom: theme.space.s10,
        gap: theme.space.s6,
    },
    askInput: {
        ...Typography.variant('reading'),
        minHeight: 44,
        maxHeight: 160,
        paddingHorizontal: theme.space.s4,
        paddingTop: theme.space.s8,
        color: theme.colors.text.primary,
    },
    askBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    grow: {
        flex: 1,
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s6,
        paddingTop: theme.space.s10,
        paddingHorizontal: theme.space.s12,
    },
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        maxWidth: '100%',
        minHeight: 26,
        paddingLeft: theme.space.s8,
        paddingRight: theme.space.s2,
        borderRadius: 8,
        backgroundColor: theme.colors.state.active.background,
    },
    chipAnchor: {
        ...Typography.mono(),
        fontSize: 11,
        color: theme.colors.text.tertiary,
    },
    chipBody: {
        ...Typography.variant('meta'),
        flexShrink: 1,
        color: theme.colors.text.primary,
    },
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        minHeight: 48,
        paddingVertical: theme.space.s6,
        paddingLeft: 14,
        paddingRight: theme.space.s6,
    },
    summary: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        minHeight: 36,
    },
    summaryText: {
        ...Typography.variant('body'),
        flexShrink: 1,
        color: theme.colors.text.secondary,
    },
    summaryStrong: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));
