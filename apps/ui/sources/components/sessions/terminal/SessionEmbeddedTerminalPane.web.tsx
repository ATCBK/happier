import * as React from 'react';
import { View } from 'react-native';

import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane.web';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';

import { SESSION_PRIMARY_TERMINAL_INSTANCE_ID } from './embeddedTerminalDocking';
import { useSessionTerminalIdentity, type SessionTerminalIdentity } from './sessionTerminalMode';
import { useSessionEmbeddedTerminalPaneModel, type SessionEmbeddedTerminalPaneProps } from './useSessionEmbeddedTerminalPaneModel';

export type { SessionEmbeddedTerminalPaneProps } from './useSessionEmbeddedTerminalPaneModel';

export const SessionEmbeddedTerminalPane = React.memo(function SessionEmbeddedTerminalPaneWeb(props: SessionEmbeddedTerminalPaneProps) {
    const terminalIdentity = useSessionTerminalIdentity({
        ...props,
        terminalInstanceId: props.currentDockLocation === 'details'
            ? props.terminalInstanceId ?? SESSION_PRIMARY_TERMINAL_INSTANCE_ID
            : props.terminalInstanceId,
    });
    return <SessionEmbeddedTerminalPaneContent key={terminalIdentity.terminalKey} {...props} terminalIdentity={terminalIdentity} />;
});

const SessionEmbeddedTerminalPaneContent = React.memo(function SessionEmbeddedTerminalPaneContent(props: SessionEmbeddedTerminalPaneProps & Readonly<{ terminalIdentity: SessionTerminalIdentity }>) {
    const model = useSessionEmbeddedTerminalPaneModel(props);
    const workspaceScope = useWorkspaceScopeForSession(props.sessionId, props.terminalIdentity.serverId);
    const askSelection = React.useMemo(() => workspaceScope
        ? { scopeId: props.scopeId, workspaceScope, sessionId: props.sessionId } : null,
    [props.scopeId, props.sessionId, workspaceScope]);
    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <EmbeddedTerminalPane
                title={model.title}
                focused={props.focused}
                findSurfaceId={model.findSurfaceId}
                chrome={props.chrome}
                machineName={props.machineName}
                controller={model.controller}
                terminalRef={model.terminalRendererRef}
                onRequestClose={props.onRequestClose}
                testIdPrefix={model.testIdPrefix}
                nativeSurfaceKey={model.terminalKey}
                toolbarActionsStart={model.toolbarActionsStart}
                askSelection={askSelection}
            />
        </View>
    );
});

export default SessionEmbeddedTerminalPane;
