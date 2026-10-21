import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';

import { createTrackAgentEditsController, type TrackAgentEditsEffects, type TrackWrite } from './trackAgentEditsController';

function filePath(resource: unknown): string | null {
    if (!resource || typeof resource !== 'object') return null;
    const value = resource as Record<string, unknown>;
    return value.kind === 'file' && typeof value.path === 'string' ? value.path : null;
}

export type TrackFileOpen = (
    target: Readonly<SessionAddress & { kind: 'session'; path: string }>,
    options: Readonly<{ intent: 'preview'; present: false; anchorSource: 'file' }>,
    programmaticToken: symbol,
) => void;

/**
 * The scope composition supplies P3's useSessionLiveFileWrites result and P4's dirty-path set.
 * The hook consumes those authorities; it does not derive tool state or editor dirtiness.
 */
export function useTrackAgentEdits(params: Readonly<{
    scopeId: string;
    sessionAddress: SessionAddress;
    /** Foreground scope availability; deliberately independent of agent/session activity. */
    active: boolean;
    sessionActive: boolean;
    writes: ReadonlyMap<string, TrackWrite>;
    dirtyPaths: ReadonlySet<string>;
    reducedMotion: boolean;
    revealRegion: TrackAgentEditsEffects['revealRegion'];
    /** Bound to useWorkspaceFileOpener().open by the scope composition; it owns async outcomes. */
    openFile: TrackFileOpen;
}>) {
    const pane = useAppPaneScope(params.scopeId);
    const [enabled, setEnabled] = useLocalSettingMutable('filesTrackAgentEdits');
    const current = React.useRef(params);
    current.current = params;
    const addressKey = sessionAddressKey(params.sessionAddress);
    const controller = React.useMemo(() => createTrackAgentEditsController({
        // The open carries no anchor: the File page resolves the region and scrolls there on Track's reveal.
        openPreview: (target, token) => {
            current.current.openFile({ kind: 'session', ...current.current.sessionAddress, path: target.path }, {
                intent: 'preview', present: false, anchorSource: 'file',
            }, token);
        },
        revealRegion: (...args) => current.current.revealRegion(...args),
        reducedMotion: () => current.current.reducedMotion,
    }), [addressKey, params.scopeId]);
    const details = pane.scopeState?.details;
    const activeTab = details?.tabs.find((tab) => tab.key === details.activeTabKey);
    const previewTab = details?.tabs.find((tab) => tab.isPreview && !tab.isPinned);
    const activePath = filePath(activeTab?.resource);
    const previewPath = filePath(previewTab?.resource);
    React.useLayoutEffect(() => {
        controller.update({ enabled, sessionActive: params.sessionActive, sessionId: params.sessionAddress.sessionId, writes: params.writes,
            dirtyPaths: params.dirtyPaths, activePath, previewPath });
    }, [activePath, controller, enabled, params.dirtyPaths, params.sessionActive, params.sessionAddress.sessionId, params.writes, previewPath]);
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const toggle = React.useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);
    const keyboardHandlers = React.useMemo(() => params.active ? { 'files.track.toggle': toggle } : {}, [params.active, toggle]);
    useKeyboardShortcutHandlers(keyboardHandlers);
    return React.useMemo(() => ({ ...snapshot, setEnabled, toggle, pause: controller.pause, resume: controller.resume }),
        [controller, setEnabled, snapshot, toggle]);
}

export type TrackAgentEditsModel = ReturnType<typeof useTrackAgentEdits>;
