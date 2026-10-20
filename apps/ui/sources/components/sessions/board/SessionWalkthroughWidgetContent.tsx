import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { Typography } from '@/constants/Typography';
import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { WalkthroughStopNumber } from '@/components/sessions/files/walkthrough/WalkthroughAtoms';
import { useSessionScmWalkthrough } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { useScmReviewedMarks } from '@/components/sessions/files/comparison/useScmReviewedMarks';
import { buildWalkthroughReadingProgress, type WalkthroughReadingProgress } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    body: { gap: theme.space.s12, minWidth: 0 },
    hero: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: theme.space.s8 },
    count: { ...Typography.default('bold'), ...happierPageTextMetrics('pageTitle'), color: theme.colors.text.primary, fontVariant: ['tabular-nums'] },
    countLabel: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary },
    stops: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s4 },
    next: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary },
    nextTitle: { ...Typography.default('medium'), color: theme.colors.text.primary },
    quiet: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary },
}));

/**
 * The Walkthrough on a Board (lab WT6-E1): how far *you* have read as the one hero, the stops as the
 * reading view's own marks (a mark made in the walkthrough fills here too), the next stop, and the
 * frame's footer leading back in. A read-only projection; it never persists personal progress.
 */
export function WalkthroughWidgetContentView(props: Readonly<{
    reading: WalkthroughReadingProgress | null;
    marksLoaded: boolean;
    onOpen?: () => void;
    testID: string;
}>) {
    const styles = stylesheet;
    const reading = props.reading;
    const stops = reading?.stops ?? [];
    const reviewed = props.marksLoaded ? reading?.reviewedCount ?? 0 : null;
    const next = props.marksLoaded ? stops.find((stop) => !stop.reviewed) ?? null : stops[0] ?? null;
    const body = stops.length === 0 ? (
        <Text testID={`${props.testID}-next`} style={styles.quiet}>
            {reading?.phase === 'inventory' || reading?.phase === 'arriving' ? t('walkthrough.readingChanges') : t('walkthrough.none.title')}
        </Text>
    ) : (
        <View style={styles.body}>
            {/* The slot stands before the marks arrive, so the count fills in without moving anything. */}
            <View testID={`${props.testID}-progress`} style={styles.hero}>
                <Text style={styles.count}>
                    {reviewed === null ? '\u2013' : t('walkthrough.boardReviewedCount', { count: reviewed, total: stops.length })}
                </Text>
                <Text style={styles.countLabel}>{t('walkthrough.boardStopsReviewed')}</Text>
            </View>
            <View testID={`${props.testID}-stops`} style={styles.stops}>
                {stops.map((stop, index) => (
                    <WalkthroughStopNumber key={stop.id} number={index + 1} size="rail"
                        reviewed={props.marksLoaded && stop.reviewed} current={next?.id === stop.id} />
                ))}
            </View>
            <Text testID={`${props.testID}-next`} style={styles.next} numberOfLines={1}>
                {next ? <>{`${t('walkthrough.nextStop')} · `}<Text style={styles.nextTitle}>{next.title}</Text></> : t('walkthrough.boardAllReviewed')}
            </Text>
        </View>
    );
    const continuing = reviewed !== null && reviewed > 0 && reviewed < stops.length;
    return <WidgetFrame presentation="body" testID={props.testID} frameStyle="card" placement="board" title={null} body={{ kind: 'content', children: body }}
        footer={props.onOpen ? { kind: 'open', label: continuing ? t('walkthrough.continueReading') : t('turnChanges.card.walkThrough'), onPress: props.onOpen } : null} />;
}

export function SessionWalkthroughWidgetContent(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    comparisonKind: 'session' | 'workingTree';
    interactive: boolean;
    testID: string;
}>) {
    const comparison = React.useMemo(() => ({ kind: props.comparisonKind }), [props.comparisonKind]);
    const result = useSessionScmWalkthrough(props.sessionId, comparison, 'walkthrough', props.serverId);
    const captured = result?.comparison ?? null;
    const marks = useScmReviewedMarks({ comparison: captured, serverId: props.serverId, host: { sessionId: props.sessionId } });
    const reading = React.useMemo(() => captured ? buildWalkthroughReadingProgress({ comparison: captured,
        walkthrough: result?.outputs?.walkthrough ?? null, reviewed: marks.record,
    }) : null, [captured, result?.outputs?.walkthrough, marks.record]);
    const router = useRouter();
    const onOpen = React.useCallback(() => router.push(buildSessionDetailsHref({
        sessionId: props.sessionId, serverId: props.serverId,
        details: { kind: 'scmReview', comparison, view: 'walkthrough' },
    }) as never), [comparison, props.serverId, props.sessionId, router]);
    return <WalkthroughWidgetContentView reading={reading} marksLoaded={captured !== null && marks.record !== null && marks.unavailableReason === null}
        {...(props.interactive ? { onOpen } : {})} testID={props.testID} />;
}
