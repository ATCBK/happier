import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MODAL_DIFF } from '@/components/dev/track/TrackCaretSpecimen';
import { PhoneAskSheet } from '@/components/sessions/composer/phoneAsk/PhoneAskSheet';
import { PhoneWorkingCapsuleView } from '@/components/sessions/composer/phoneAsk/PhoneWorkingCapsule';
import { PhoneAskSheetFrame } from '@/components/sessions/composer/phoneAsk/PhoneAskSheetFrame';
import { PhoneAskSheetProvider, usePhoneAskSheet, usePhoneAskSheetState } from '@/components/sessions/composer/phoneAsk/phoneAskSheetState';
import { SessionView } from '@/components/sessions/shell/SessionViewHost';
import { useAskSessionReveal } from '@/components/ui/code/selection/useAskSessionReveal';
import { Text } from '@/components/ui/text/Text';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { FileContentPanel } from '@/components/workspaces/files/file/FileContentPanel';

const SELECTED = new Set(['n:19', 'n:20', 'n:21', 'n:22', 'n:23', 'n:24']);

export type PhoneAskSheetSpecimenPhase = 'page' | 'open' | 'working' | 'needsYou';

/**
 * Dev-only specimen of the phone Ask flow (lab ask Ap/Ap2) while no agent Session with a workspace exists on
 * the QA Account: the File page body (lab content) stands as the phone cockpit's File scene, a real Session screen
 * mounts the one composer in the cockpit's real Chat frame, and Ask reveals through the real owner, so that frame
 * raises the Session screen as the sheet over the page. `working`/`needsYou` show the capsule at static props.
 */
export function PhoneAskSheetSpecimen(props: Readonly<{ sessionId: string; serverId: string; phase: PhoneAskSheetSpecimenPhase }>) {
    const sheet = usePhoneAskSheetState(true);
    return (
        <PhoneAskSheetProvider value={sheet}>
            <PhoneAskSheetSpecimenBody {...props} />
        </PhoneAskSheetProvider>
    );
}

function PhoneAskSheetSpecimenBody(props: Readonly<{ sessionId: string; serverId: string; phase: PhoneAskSheetSpecimenPhase }>) {
    const { theme } = useUnistyles();
    const reveal = useAskSessionReveal();
    const raised = usePhoneAskSheet()?.phase === 'open';
    const autoOpen = props.phase === 'open';
    React.useEffect(() => {
        if (autoOpen) reveal();
    }, [autoOpen, reveal]);
    const renderComposer = React.useCallback((composer: Parameters<typeof PhoneAskSheet>[0]['composer']) => <PhoneAskSheet composer={composer} />, []);
    return (
        <View style={styles.root} testID="dev-phone-ask-sheet">
            <View style={[StyleSheet.absoluteFill, styles.page]}>
                <Text variant="title" emphasis="semiBold" style={styles.title}>SettingsModal.tsx</Text>
                <Text variant="meta" style={styles.meta}>apps/ui/…/settings/ · +4 −2</Text>
                <View style={styles.body}>
                    <FileContentPanel
                        theme={theme}
                        displayMode="diff"
                        sessionId=""
                        filePath="apps/ui/sources/components/settings/SettingsModal.tsx"
                        diffContent={MODAL_DIFF}
                        fileContent={null}
                        language="typescript"
                        selectedLineKeys={props.phase === 'page' ? new Set<string>() : SELECTED}
                        lineSelectionEnabled={false}
                        onToggleLine={() => {}}
                    />
                </View>
                {props.phase === 'page' ? (
                    <View style={styles.ask}><ToolbarButton label="Ask" onPress={reveal} testID="dev-phone-ask-trigger" /></View>
                ) : null}
                {props.phase === 'working' || props.phase === 'needsYou' ? (
                    <PhoneWorkingCapsuleView kind={props.phase} agent="Codex" onView={() => {}} />
                ) : null}
            </View>
            {/* As the cockpit hosts its Chat scene: hidden behind the File scene until Ask raises it. */}
            <View style={[StyleSheet.absoluteFill, raised ? null : styles.hidden]} pointerEvents={raised ? 'box-none' : 'none'}>
                <PhoneAskSheetFrame raised={raised}>
                    <SessionView id={props.sessionId} routeServerId={props.serverId} surfaceFocusedOverride surfaceVisibleOverride renderComposer={renderComposer} />
                </PhoneAskSheetFrame>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1 },
    hidden: { display: 'none' },
    page: { backgroundColor: theme.colors.surface.base },
    title: { paddingHorizontal: theme.space.s24, paddingTop: theme.space.s20, color: theme.colors.text.primary },
    meta: { paddingHorizontal: theme.space.s24, paddingTop: theme.space.s4, paddingBottom: theme.space.s12, color: theme.colors.text.secondary },
    body: { flex: 1, minHeight: 0, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    ask: { position: 'absolute', bottom: theme.space.s40, alignSelf: 'center' },
}));
