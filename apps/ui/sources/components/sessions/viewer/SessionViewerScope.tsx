import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createComputerScreenDetailsTab } from '@/components/computer/computerScreenDetailsTab';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { useSessionCockpitSurfaceNavigation } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';

import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import type { SessionViewerSource } from './sessionViewerPresentation';
import { useSessionViewerMachineId } from './useSessionViewerMachine';

/**
 * Mounts the Session's one viewer presentation owner around its panes and main column. Both
 * sources live on the Session's own machine (the Watch opener's rule); desktop dock presents the
 * same retained body in its pane (Computer in Details, Browser in the right pane). The Computer
 * is presentable whenever the Session has a Machine, reachable or not, so its viewer can say the
 * Machine isn't answering; the Browser needs a reachable one. A phone has no pane to dock into: its
 * dock is Chat's reading flow, and opening the viewer from another cockpit surface returns there.
 */
export function SessionViewerScope(
  props: React.PropsWithChildren<
    Readonly<{
      sessionId: string;
      serverId: string | null;
    }>
  >,
): React.ReactElement {
  const phone = useDeviceType() === 'phone';
  const serverId = usePreferredServerIdForSession({ sessionId: props.sessionId, serverId: props.serverId });
  const machineId =
    useSessionMachineTarget(props.sessionId, serverId)?.machineId ?? null;
  const scopeId = useDestinationPaneScopeId(
    createSessionPaneScopeId(props.sessionId, serverId ?? undefined),
  );
  const pane = useAppPaneScope(scopeId);
  const paneRef = React.useRef(pane);
  paneRef.current = pane;
  const computerMachineId = useSessionViewerMachineId(props.sessionId, serverId);
  const canPresentSource = React.useCallback(
    (source: SessionViewerSource) =>
      (source === 'computer' ? computerMachineId : machineId) !== null,
    [computerMachineId, machineId],
  );
  const surfaceNavigation = useSessionCockpitSurfaceNavigation();
  const surfaceNavigationRef = React.useRef(surfaceNavigation);
  surfaceNavigationRef.current = surfaceNavigation;
  const openDocked = React.useCallback(
    (source: SessionViewerSource) => {
      if (phone) {
        // A phone docks the viewer into Chat's reading flow; from any other cockpit surface the
        // open request reveals that surface rather than presenting a second copy beside the page.
        surfaceNavigationRef.current?.switchSurface('chat');
        return;
      }
      if (source === 'computer') {
        if (!computerMachineId) return;
        paneRef.current.openDetailsTab(
          createComputerScreenDetailsTab({
            machineId: computerMachineId,
            title: t('computerUse.presentation.tabFallback'),
          }),
          { intent: 'default' },
        );
        return;
      }
      if (!machineId) return;
      paneRef.current.openRight({ tabId: 'browser' });
      paneRef.current.setRightTab('browser');
    },
    [computerMachineId, machineId, phone],
  );
  return (
    <SessionViewerControllerProvider
      key={serverId ? sessionAddressKey({ sessionId: props.sessionId, serverId }) : props.sessionId}
      sessionId={props.sessionId}
      serverId={serverId}
      phone={phone}
      canPresentSource={canPresentSource}
      openDocked={openDocked}
    >
      {props.children}
    </SessionViewerControllerProvider>
  );
}
