import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HomeAddForm } from '@/components/homes/add/HomeAddForm';
import { MachineAddForm } from '@/components/machines/add/MachineAddForm';
import {
    MachineAddFailureNotice,
    MachineAddPaneHeader,
    MachineAddStepList,
    MachineArrivedCard,
    MachineNotSeeingNotice,
    MachineWatchLine,
} from '@/components/machines/add/MachineAddPanes';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * Dev-only specimen of Add a machine / Add a Home (lab `add-flows`), for side-by-side pairs against the
 * lab frames. `M1` (Home block), `H1` (Settings draft) and `H2` (Home K1 block) are the real forms on
 * this device's real state. `MS` and `MX` draw the real panes at fixture props for the states a dev
 * stack cannot produce on demand (a setup that fails, a machine that joins). `?only=<frame>`.
 */
const FRAMES = ['M1', 'MS', 'MX', 'H1', 'H2'] as const;
type Frame = typeof FRAMES[number];

const noop = () => {};
const STARTED_MS = Date.now() - 42_000;

export function AddFlowsSpecimen(props: Readonly<{ only: string | null }>) {
    const frames = FRAMES.filter((frame) => !props.only || props.only === frame);
    return (
        <ScrollView style={styles.root} contentContainerStyle={styles.content}>
            {frames.map((frame) => (
                <View key={frame} style={styles.block} testID={`add-flows-specimen.${frame}`}>
                    {props.only ? null : <Text style={styles.caption}>{frame}</Text>}
                    <FrameBody frame={frame} />
                </View>
            ))}
        </ScrollView>
    );
}

function FrameBody(props: Readonly<{ frame: Frame }>) {
    switch (props.frame) {
        case 'M1':
            return (
                <View style={styles.paper}>
                    <MachineAddForm layout="panel" testID="specimen.add-machine" onClose={noop} onStartSession={noop} onNewPool={noop} />
                </View>
            );
        case 'MS':
            return (
                <View style={styles.boards}>
                    <View style={[styles.paper, styles.board]}>
                        <MachineAddPaneHeader title={t('addFlows.pathThisComputerTitle')} lead={t('addFlows.thisComputerRunningLead', { machine: 'MacBook Pro' })} />
                        <MachineAddStepList
                            testID="specimen.steps.running"
                            steps={[
                                { id: 'install', label: 'Install the Happier service', state: 'done', elapsedMs: 6_000 },
                                { id: 'connect', label: 'Connect it to Personal Home', state: 'done', elapsedMs: 2_000 },
                                { id: 'agents', label: 'Look for agents on this computer', state: 'running', elapsedMs: null },
                            ]}
                        />
                    </View>
                    <View style={[styles.paper, styles.board]}>
                        <MachineAddPaneHeader title={t('addFlows.pathThisComputerTitle')} lead={t('addFlows.thisComputerTaskLead', { machine: 'MacBook Pro', home: 'Personal Home' })} />
                        <MachineAddFailureNotice
                            testID="specimen.failure"
                            failure={{
                                title: 'Setup stopped at “Connect it to Personal Home”',
                                body: 'The service started but home.leeroy.dev didn’t answer it. Nothing else changed.',
                                details: 'relay handshake timed out after 30 s',
                            }}
                            onRetry={noop}
                        />
                        <MachineAddStepList
                            testID="specimen.steps.failed"
                            steps={[
                                { id: 'install', label: 'Install the Happier service', state: 'done', elapsedMs: 6_000 },
                                { id: 'connect', label: 'Connect it to Personal Home', state: 'failed', elapsedMs: null },
                                { id: 'agents', label: 'Look for agents on this computer', state: 'pending', elapsedMs: null },
                            ]}
                        />
                    </View>
                    <View style={[styles.paper, styles.board]}>
                        <MachineAddPaneHeader title={t('addFlows.pathThisComputerTitle')} lead={t('addFlows.thisComputerTaskLead', { machine: 'MacBook Pro', home: 'Personal Home' })} />
                        <AttentionBanner
                            testID="specimen.onAnotherHome"
                            tone="warning"
                            title={t('addFlows.onAnotherHomeTitle', { machine: t('addFlows.pathThisComputerTitle') })}
                            description={t('addFlows.onAnotherHomeBody', { home: 'Personal Home' })}
                            action={{ label: t('addFlows.moveToHome', { home: 'Personal Home' }), onPress: noop }}
                            secondaryAction={{ label: t('addFlows.keepOnOtherHome'), onPress: noop }}
                        />
                    </View>
                </View>
            );
        case 'MX':
            return (
                <View style={styles.boards}>
                    <View style={[styles.paper, styles.board]}>
                        <MachineWatchLine testID="specimen.watch" subject="devbox" homeName="Personal Home" startedAtMs={STARTED_MS} />
                    </View>
                    <View style={[styles.paper, styles.board]}>
                        <MachineArrivedCard
                            testID="specimen.arrived"
                            machineId="specimen-devbox"
                            serverId="specimen"
                            name="devbox"
                            facts={['Linux · x86_64', t('addFlows.machineConnectedJustNow')].join(' · ')}
                            onStartSession={noop}
                            onAddAnother={noop}
                        />
                    </View>
                    <View style={[styles.paper, styles.board]}>
                        <MachineNotSeeingNotice testID="specimen.notSeeing" subject="devbox" homeName="home.leeroy.dev" />
                        <MachineWatchLine testID="specimen.watch.long" subject="devbox" homeName="Personal Home" startedAtMs={Date.now() - 301_000} />
                    </View>
                    <View style={[styles.paper, styles.board]}>
                        <MachineAddFailureNotice
                            testID="specimen.sshRefused"
                            failure={{
                                title: 'devbox.internal refused the sign-in',
                                body: 'Your SSH agent has no key that leeroy@devbox.internal accepts. Add yours with ssh-add, or choose Key file.',
                                details: null,
                            }}
                            onRetry={noop}
                            secondary={{ label: 'Use a key file', onPress: noop }}
                        />
                    </View>
                </View>
            );
        case 'H1':
            return (
                <View style={[styles.paper, styles.pagePaper]}>
                    <HomeAddForm layout="page" testID="specimen.add-home.page" onClose={noop} />
                </View>
            );
        case 'H2':
            return (
                <View style={styles.paper}>
                    <HomeAddForm layout="panel" testID="specimen.add-home.panel" initialPath="direct" onClose={noop} />
                </View>
            );
    }
}

const styles = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    content: {
        padding: theme.space.s24,
        gap: 28,
        maxWidth: 1040,
        width: '100%',
        alignSelf: 'center',
    },
    block: {
        gap: theme.space.s10,
    },
    caption: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.tertiary,
    },
    paper: {
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
    },
    pagePaper: {
        padding: theme.space.s24,
    },
    boards: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s16,
    },
    board: {
        flexGrow: 1,
        flexBasis: 300,
        padding: theme.space.s20,
        gap: 14,
    },
}));
