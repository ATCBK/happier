import { HappierSkeletonRows, type HappierStateSize } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Dev-only specimen of the pane-states composition (lab 0 boards S and S2): seven states × three
 * containers, rendered through the real owners so the lab can be compared side by side without a
 * reachable Home. Copy is the lab's illustration, not product copy.
 */
const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.inset },
    content: { padding: theme.space.s24, gap: 28 },
    block: { gap: theme.space.s12 },
    rowTitle: {  ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary },
    caption: {  ...Typography.variant('meta'), color: theme.colors.text.secondary },
    grid: { flexDirection: 'row', gap: 22, flexWrap: 'wrap' },
    frame: {
        height: 440,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    frameFlex: { flexGrow: 1, flexBasis: 380, minWidth: 320 },
    frameHeader: {  ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary, paddingHorizontal: theme.space.s16, paddingTop: theme.space.s16, paddingBottom: theme.space.s12 },
    frameBody: { flex: 1, minHeight: 0 },
    rows: { paddingVertical: theme.space.s8 },
    row: {  ...Typography.variant('body'),  color: theme.colors.text.primary, paddingHorizontal: theme.space.s16, paddingVertical: 11 },
    section: {  ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary, paddingHorizontal: theme.space.s16, paddingTop: 14, paddingBottom: theme.space.s4 },
}));

const noop = () => {};
const HOW = { label: 'How it works', onPress: noop };
const AS_OF = Date.now() - 8 * 60_000;

function SkeletonBody() {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    return (
        <View style={{ paddingTop: theme.space.s8 }}>
            <HappierSkeletonRows rows={4} theme={pluginTheme} />
        </View>
    );
}

function Rows(props: Readonly<{ rows: readonly string[] }>) {
    return (
        <View style={styles.rows}>
            {props.rows.map((row) => <Text key={row} style={styles.row}>{row}</Text>)}
        </View>
    );
}

type Cell = Readonly<{ header: string; body: React.ReactNode }>;
type Row = Readonly<{ title: string; caption: string; pane: Cell; details: Cell; page: Cell }>;

const ROWS: readonly Row[] = [
    {
        title: 'Empty that invites',
        caption: 'identity · one-sentence promise · one action · How it works',
        pane: { header: 'Local services', body: <SurfaceStateCard kind="empty" iconName="globe" title="Preview what you’re building" reason="Dev servers started in happier on MacBook Pro show up here, with a link that also opens on your phone." action={{ label: 'Start a dev server', onPress: noop }} learnMore={HOW} /> },
        details: { header: 'Board', body: <SurfaceStateCard kind="empty" iconName="squares-four" title="Keep the plan beside the chat" reason="Notes and live views pinned here stay with this session, for everyone who can read it." action={{ label: 'Add a note', onPress: noop }} secondaryAction={{ label: 'Interactive view', onPress: noop }} learnMore={HOW} /> },
        page: { header: 'Automations', body: <SurfaceStateCard kind="empty" iconName="timer" title="Let agents work while you’re away" reason="Run a prompt on a schedule — triage new issues each morning, check dependencies each night — and read the result on any device." action={{ label: 'New automation', onPress: noop }} note="Runs on a machine in Personal Home." learnMore={HOW} /> },
    },
    {
        title: 'Loading',
        caption: 'known shape → skeleton rows; unknown → a calm ring that names what it waits on',
        pane: { header: 'Agents', body: <SkeletonBody /> },
        details: { header: 'SettingsModal.tsx', body: <SurfaceStateCard kind="loading" title="Opening SettingsModal.tsx" reason="Reading it from MacBook Pro." /> },
        page: { header: 'Automations', body: <SkeletonBody /> },
    },
    {
        title: 'Stale',
        caption: 'last-known content at full strength + one freshness line',
        pane: { header: 'Changes', body: <><SurfaceFreshnessLine asOf={AS_OF} reason="devbox isn’t answering" action={{ label: 'Retry', onPress: noop }} /><Rows rows={['SettingsModal.tsx', 'SettingsModal.test.tsx', 'useSettingsRouteKey.ts', 'settings.tsx']} /></> },
        details: { header: 'SettingsModal.tsx', body: <><SurfaceFreshnessLine reason="Showing the version from 10:42 · reconnecting to MacBook Pro…" busy /><Rows rows={['export function SettingsModal({ route }: Props) {', '  const key = useSettingsRouteKey(route);', '  return <Modal key={key} onDismiss={close} />;', '}']} /></> },
        page: { header: 'Automations', body: <><SurfaceFreshnessLine asOf={AS_OF} reason="Happier Cloud isn’t responding" action={{ label: 'Retry', onPress: noop }} /><Rows rows={['Morning triage', 'Nightly dependency check', 'Weekly release notes']} /></> },
    },
    {
        title: 'Error',
        caption: 'what failed · the cause · one recovery · Details collapsed',
        pane: { header: 'Files', body: <SurfaceStateCard kind="error" iconName="folder" title="Couldn’t list files on devbox" reason="devbox didn’t answer within 20 seconds. It may be busy installing packages." action={{ label: 'Try again', onPress: noop }} diagnosticCode="rpc_timeout" /> },
        details: { header: 'Commit 4f2a91c', body: <SurfaceStateCard kind="error" iconName="git-commit" title="Couldn’t open commit 4f2a91c" reason="Git can’t find it any more. The branch was probably rebased after you opened this tab." action={{ label: 'Try again', onPress: noop }} secondaryAction={{ label: 'Show history', onPress: noop }} diagnosticCode="commit_not_found" /> },
        page: { header: 'Automations', body: <SurfaceStateCard kind="error" iconName="timer" title="Couldn’t load your automations" reason="Happier Cloud didn’t respond. Your automations keep running on their machines; only this list is out of date." action={{ label: 'Try again', onPress: noop }} diagnosticCode="http_503" /> },
    },
    {
        title: 'Unavailable / offline',
        caption: 'names the machine and when it was last seen · what still works · one action',
        pane: { header: 'Local services', body: <SurfaceStateCard kind="unavailable" title="Studio is offline" reason="Last seen at 09:12. Its dev servers appear here again when it’s back." action={{ label: 'Check again', onPress: noop }} /> },
        details: { header: 'relay/client.ts', body: <SurfaceStateCard kind="unavailable" title="This file is on Studio, which is offline" reason="Studio was last seen at 09:12. The tab stays here and opens the file as soon as Studio is back." action={{ label: 'Check again', onPress: noop }} note="Nothing is lost." /> },
        page: { header: 'Automations', body: <SurfaceStateCard kind="unavailable" title="You’re offline" reason="Automations keep running on their machines. This page updates when your connection is back." live={{ text: 'Reconnecting · next try in 8 s', busy: true }} action={{ label: 'Try now', onPress: noop }} /> },
    },
    {
        title: 'Permission denied',
        caption: 'say who can, instead of hiding the action; what the viewer still can do',
        pane: { header: 'Collaboration', body: <SurfaceStateCard kind="denied" title="Only Leeroy can change who has access" reason="Leeroy Brun owns this session. You can edit it and join its conversations." /> },
        details: { header: 'Relay retry plan', body: <SurfaceStateCard kind="denied" title="You no longer have access to this conversation" reason="Leeroy Brun stopped sharing this session with you at 10:51. Ask him if you still need it." secondaryAction={{ label: 'Close tab', onPress: noop }} /> },
        page: { header: 'Teams', body: <SurfaceStateCard kind="denied" iconName="users" title="Only administrators of Happier Labs can create Teams" reason="Ask Mei Kato or Jonas Tell to create a Team or to add you to one." /> },
    },
    {
        title: 'In-list line',
        caption: 'one quiet line on the rows’ edge; the section title stays',
        pane: { header: 'Collaboration', body: (
            <View>
                <Text style={styles.section}>Viewing now</Text>
                <SurfaceStateCard size="line" kind="loading" title="Connecting…" />
                <Text style={styles.section}>Responsible</Text>
                <SurfaceStateCard size="line" kind="empty" iconName="flag" title="No one yet." action={{ label: 'Assign to me', onPress: noop }} />
                <Text style={styles.section}>Who has access</Text>
                <SurfaceStateCard size="line" kind="error" title="Couldn’t load who has access." action={{ label: 'Try again', onPress: noop }} />
                <Text style={styles.section}>Public link</Text>
                <SurfaceStateCard size="line" kind="denied" title="Only Leeroy can create a public link." />
            </View>
        ) },
        details: { header: 'Review', body: (
            <View>
                <Text style={styles.section}>Review comments</Text>
                <SurfaceStateCard size="line" kind="empty" iconName="chat-circle" title="No comments yet. Select lines in a diff to comment." />
                <Text style={styles.section}>Untracked</Text>
                <SurfaceStateCard size="line" kind="error" title="Couldn’t read 1 file: permission denied on .env.local." action={{ label: 'Try again', onPress: noop }} />
            </View>
        ) },
        page: { header: 'Automations', body: (
            <View>
                <Rows rows={['Morning triage', 'Nightly dependency check']} />
                <Text style={styles.section}>On Studio</Text>
                <SurfaceStateCard size="line" kind="unavailable" title="Studio is offline · its automations run again when it’s back." />
            </View>
        ) },
    },
];

function Frame(props: Readonly<{ cell: Cell; size: HappierStateSize; width?: number }>) {
    return (
        <View style={[styles.frame, props.width ? { width: props.width } : styles.frameFlex]}>
            <Text style={styles.frameHeader}>{props.cell.header}</Text>
            <View style={styles.frameBody}>
                <SurfaceStateSizeProvider size={props.size}>{props.cell.body}</SurfaceStateSizeProvider>
            </View>
        </View>
    );
}

export function PaneStatesSpecimen(props: Readonly<{ only?: string | null }>) {
    const rows = props.only ? ROWS.filter((row) => row.title === props.only) : ROWS;
    return (
        <ScrollView style={styles.root} contentContainerStyle={styles.content} testID="pane-states-specimen">
            {rows.map((row) => (
                <View key={row.title} style={styles.block}>
                    <Text style={styles.rowTitle}>{row.title} <Text style={styles.caption}>{row.caption}</Text></Text>
                    <View style={styles.grid}>
                        <Frame cell={row.pane} size="pane" width={340} />
                        <Frame cell={row.details} size="details" width={520} />
                        <Frame cell={row.page} size="page" />
                    </View>
                </View>
            ))}
        </ScrollView>
    );
}
