import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { FileContentPanel } from '@/components/workspaces/files/file/FileContentPanel';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * Dev-only specimen of Track's agent caret and wash (lab tr T1) drawn by the real File page body owner
 * (`FileContentPanel`) at static props, View and Changes, so it can be compared with the lab without a writing
 * agent. `?mode=diff` shows Changes; `?line=<n>` moves the region (the caret travels there). The content is the
 * lab's illustration (the settings-modal change), not product data.
 */
const ROUTE_KEY = [
    "import * as React from 'react';",
    "import type { SettingsRoute } from './settingsRoutes';",
    '',
    '/**',
    ' * A stable key for the settings modal. It changes when the route changes,',
    ' * never when the window resizes, so the modal keeps its draft and scroll.',
    ' */',
    'export function useSettingsRouteKey(route: SettingsRoute): string {',
    '    return React.useMemo(() => {',
    '        switch (route.kind) {',
    "            case 'section':",
    '                return `section:${route.section}`;',
    "            case 'search':",
    "                return 'search';",
    '            default:',
    "                return 'root';",
    '        }',
    '    }, [route]);',
    '}',
].join('\n');

const MODAL_DIFF = [
    'diff --git a/SettingsModal.tsx b/SettingsModal.tsx',
    '--- a/SettingsModal.tsx',
    '+++ b/SettingsModal.tsx',
    '@@ -18,6 +18,7 @@',
    ' export function SettingsModal({ route, onClose }: Props) {',
    '     const { width } = useWindowDimensions();',
    '-    const key = `${route.path}:${width}`;',
    '+    // Keyed by route only: a resize must not remount the modal.',
    '+    const key = useSettingsRouteKey(route);',
    '     return (',
    '         <Modal key={key} onDismiss={onClose}>',
    '             <SettingsBody route={route} />',
].join('\n');

const NO_LINES = new Set<string>();

export function TrackCaretSpecimen(props: Readonly<{ mode: 'file' | 'diff'; line: number | null }>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const diff = props.mode === 'diff';
    const endLine = props.line ?? (diff ? 21 : 15);
    const presence = React.useMemo(() => ({ startLine: endLine - 1, endLine, agentId: 'claude', agentName: 'Claude', reducedMotion }),
        [endLine, reducedMotion]);
    return (
        <View style={styles.page} testID="dev-track-caret">
            <Text variant="title" emphasis="semiBold" style={styles.title}>{diff ? 'SettingsModal.tsx' : 'useSettingsRouteKey.ts'}</Text>
            <Text variant="meta" style={styles.meta}>Claude is writing · line {endLine - 1}</Text>
            <View style={styles.body}>
                <FileContentPanel
                    theme={theme}
                    displayMode={diff ? 'diff' : 'file'}
                    sessionId=""
                    filePath={diff ? 'apps/ui/sources/components/settings/SettingsModal.tsx' : 'apps/ui/sources/components/settings/useSettingsRouteKey.ts'}
                    diffContent={diff ? MODAL_DIFF : null}
                    fileContent={diff ? null : ROUTE_KEY}
                    language="typescript"
                    selectedLineKeys={NO_LINES}
                    lineSelectionEnabled={false}
                    onToggleLine={() => {}}
                    agentPresence={presence}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    title: {
        paddingHorizontal: theme.space.s24,
        paddingTop: theme.space.s20,
        color: theme.colors.text.primary,
    },
    meta: {
        paddingHorizontal: theme.space.s24,
        paddingTop: theme.space.s4,
        paddingBottom: theme.space.s12,
        color: theme.colors.text.secondary,
    },
    body: {
        flex: 1,
        minHeight: 0,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
}));
