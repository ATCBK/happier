import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import {
    PaneHeaderSlotProvider,
    PaneHeaderSlotScope,
    usePublishedPaneHeaderContent,
} from '@/components/appShell/panes/paneHeaderSlot';
import type { TranscriptNavigationSessionStart } from '@/components/sessions/transcript/navigation/TranscriptNavigationEntryList';
import { TranscriptNavigationPanel } from '@/components/sessions/transcript/navigation/TranscriptNavigationPanel';
import type {
    TranscriptNavigationEntry,
    TranscriptNavigationTurnFacts,
} from '@/components/sessions/transcript/navigation/transcriptNavigationTypes';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Typography } from '@/constants/Typography';

/**
 * Dev-only fixtures for the Navigate pane (lab `navigate`, frames NA/NF/NS): the real panel,
 * list and pane header on the lab's session, so the build can be paired against the lab
 * without a live session on the dev account.
 */

const DAY_MS = 86_400_000;

function at(dayOffset: number, hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    const date = new Date();
    date.setHours(h ?? 0, m ?? 0, 0, 0);
    return date.getTime() - dayOffset * DAY_MS;
}

function facts(overrides: Partial<TranscriptNavigationTurnFacts>, startMs: number, durationMs: number | null): TranscriptNavigationTurnFacts {
    return {
        toolCount: 0,
        failedCount: 0,
        approvals: [],
        running: false,
        lastToolFailed: false,
        endedAtMs: durationMs === null ? null : startMs + durationMs,
        ...overrides,
    };
}

function turn(id: string, seq: number, createdAtMs: number, prompt: string, reply: string | null, turnFacts: TranscriptNavigationTurnFacts | null, pinned = false): TranscriptNavigationEntry {
    return {
        id,
        sessionId: 'specimen',
        seq,
        routeMessageId: null,
        transcriptBlockIndex: null,
        kind: 'user-turn',
        role: 'user',
        label: prompt,
        promptPreview: prompt,
        responsePreview: reply,
        createdAtMs,
        pinned,
        pinnedAtMs: pinned ? createdAtMs : null,
        loaded: turnFacts !== null,
        facts: turnFacts,
    };
}

function buildEntries(): TranscriptNavigationEntry[] {
    const t1740 = at(1, '17:40');
    const t1752 = at(1, '17:52');
    const t0912 = at(0, '09:12');
    const t0920 = at(0, '09:20');
    const t0934 = at(0, '09:34');
    const t0951 = at(0, '09:51');
    const t1018 = at(0, '10:18');
    const t1036 = at(0, '10:36');
    const t1042 = Date.now() - 134_000;
    return [
        turn('t1740', 1, t1740, 'Look at the settings routes before we change anything.', 'There are 11 settings routes; the modal wraps all of them through SettingsModal.', facts({ toolCount: 3 }, t1740, 38_000)),
        turn('t1752', 5, t1752, 'Try the old settings route on the phone build.', 'Stopped: Xcode isn’t installed on devbox.', facts({ toolCount: 3, failedCount: 1, lastToolFailed: true }, t1752, 41_000)),
        turn('t0912', 9, t0912, 'The settings modal flickers when the window resizes. Find out why and fix it.', 'It remounts because SettingsModal’s key includes the window width.', facts({ toolCount: 7 }, t0912, 108_000)),
        turn('t0920', 14, t0920, 'Key it by route instead, and keep the draft while resizing.', 'Done. The key now comes from useSettingsRouteKey.', facts({ toolCount: 5, approvals: [{ outcome: 'allowed', label: 'edit SettingsModal.tsx' }] }, t0920, 130_000), true),
        turn('t0934', 20, t0934, 'Add a test that resizes at three widths.', 'Added SettingsModal.test.tsx · all 24 tests pass.', facts({ toolCount: 6, failedCount: 1, approvals: [{ outcome: 'allowed', label: 'yarn test settings' }] }, t0934, 220_000)),
        {
            id: 'a0951',
            sessionId: 'specimen',
            seq: 27,
            routeMessageId: null,
            transcriptBlockIndex: 1,
            kind: 'pinned-assistant',
            role: 'assistant',
            label: 'The phone sheet is keyed by its route already, so it never remounts on rotate.',
            promptPreview: 'Add a test that resizes at three widths.',
            responsePreview: 'The phone sheet is keyed by its route already, so it never remounts on rotate.',
            createdAtMs: t0951,
            pinned: true,
            pinnedAtMs: t0951,
            loaded: true,
            facts: null,
        },
        turn('t1018', 30, t1018, 'Does the phone sheet use the same key?', 'No — it’s keyed by its route already. Only the desktop modal needed the fix.', facts({ toolCount: 2 }, t1018, 24_000)),
        turn('t1036', 34, t1036, 'Commit it and write the PR description.', 'Committed 4f2a91c and drafted the description.', facts({ toolCount: 4 }, t1036, 62_000), true),
        turn('t1042', 40, t1042, 'Run the full UI suite, then push and open the PR.', null, facts({ toolCount: 2, running: true, approvals: [{ outcome: 'pending', label: 'Run yarn test:ui?' }] }, t1042, null)),
    ];
}

const NOOP = () => undefined;
const START: TranscriptNavigationSessionStart = { atMs: at(1, '17:38'), detail: 'Claude on MacBook Pro' };
const VISIBLE = ['t1018', 'a0951'];

type Frame = Readonly<{
    id: string;
    title: string;
    entries: (all: TranscriptNavigationEntry[]) => TranscriptNavigationEntry[];
    historyComplete?: boolean;
    isLoading?: boolean;
    loadingEarlier?: boolean;
    offline?: boolean;
    newestTurn?: 'working' | 'waiting' | null;
}>;

const FRAMES: readonly Frame[] = [
    { id: 'NA', title: 'NA · newest first', entries: (all) => all, historyComplete: true, newestTurn: 'waiting' },
    { id: 'NF', title: 'NF · filters (press Approvals)', entries: (all) => all, historyComplete: true, newestTurn: 'waiting' },
    { id: 'NS-loading', title: 'NS · loading', entries: () => [], isLoading: true },
    { id: 'NS-new', title: 'NS · new session', entries: () => [] },
    { id: 'NS-partial', title: 'NS · partial history', entries: (all) => all.slice(3), historyComplete: false, newestTurn: 'waiting' },
    { id: 'NS-earlier', title: 'NS · loading earlier', entries: (all) => all.slice(3), historyComplete: false, loadingEarlier: true },
    { id: 'NS-offline', title: 'NS · offline', entries: (all) => all.slice(0, -1), historyComplete: true, offline: true },
];

function SpecimenHeader() {
    const content = usePublishedPaneHeaderContent('navigate-specimen');
    return <PaneHeader title="Navigate" line={content?.line ?? null} actions={content?.action ?? null} />;
}

function NavigateFrame(props: Readonly<{ frame: Frame }>) {
    const { frame } = props;
    const entries = React.useMemo(() => frame.entries(buildEntries()), [frame]);
    return (
        <PaneHeaderSlotProvider>
            <SpecimenHeader />
            <PaneHeaderSlotScope slotKey="navigate-specimen">
                <TranscriptNavigationPanel
                    sessionId="specimen"
                    entries={entries}
                    activeEntryId="t1018"
                    visibleEntryIds={VISIBLE}
                    newestTurn={frame.newestTurn ?? null}
                    historyComplete={frame.historyComplete === true}
                    onLoadEarlier={NOOP}
                    loadingEarlier={frame.loadingEarlier === true}
                    sessionStart={START}
                    offline={frame.offline ? { asOfMs: at(0, '10:42'), reason: 'MacBook Pro is offline' } : null}
                    onEntryPress={NOOP}
                    isLoading={frame.isLoading === true}
                    testIDPrefix="nav"
                />
            </PaneHeaderSlotScope>
        </PaneHeaderSlotProvider>
    );
}

export function NavigateSpecimen(props: Readonly<{ only: string | null; phone: boolean }>) {
    const frames = props.only ? FRAMES.filter((frame) => frame.id === props.only) : FRAMES;
    const grid = (
        <View style={styles.grid}>
            {frames.map((frame) => (
                <View key={frame.id} testID={`navigate-specimen-${frame.id}`} style={props.phone ? styles.framePhone : styles.frame}>
                    {props.only ? null : <Text style={styles.caption}>{frame.title}</Text>}
                    <View style={styles.frameBody}><NavigateFrame frame={frame} /></View>
                </View>
            ))}
        </View>
    );
    const content = props.only
        ? <View style={[styles.root, styles.content]}>{grid}</View>
        : <ScrollView style={styles.root} contentContainerStyle={styles.content}>{grid}</ScrollView>;
    return (
        <SurfaceStateSizeProvider size={props.phone ? 'phone' : 'pane'}>
            {content}
        </SurfaceStateSizeProvider>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.inset },
    content: { padding: theme.space.s16, gap: theme.space.s24 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 22 },
    caption: {  ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary, padding: theme.space.s8 },
    frame: {
        width: 470,
        height: 1240,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    framePhone: {
        width: '100%',
        height: 820,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
    },
    frameBody: { flex: 1, minHeight: 0 },
}));
