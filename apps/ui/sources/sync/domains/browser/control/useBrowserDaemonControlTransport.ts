import * as React from 'react';

import { createBrowserDaemonControlCommandSender, type BrowserDaemonControlCommandSender } from './machineRpc';

/**
 * Resolve a stable `sendDaemonCommand` transport for a browser surface (W2-A-1 / A3).
 *
 * Returns a memoized result-bearing sender keyed on `(machineId, serverId)` so daemon-authoritative
 * views (`chromiumSidecar`/`streamedBrowserSurface`) dispatch reload/stop/navigate through the daemon
 * control broker over machine RPC. Returns `undefined` when the surface has no resolved machine/server
 * context, so the control adapter falls back to its honest `browser_control_route_unavailable` state
 * rather than dispatching against an unknown machine.
 */
export function useBrowserDaemonControlTransport(
    input: Readonly<{
        machineId?: string | null;
        serverId?: string | null;
    }>,
): BrowserDaemonControlCommandSender | undefined {
    const machineId = input.machineId?.trim() ?? '';
    const serverId = input.serverId?.trim() ?? '';
    const binding = React.useMemo(() => {
        if (!machineId || !serverId) {
            return undefined;
        }
        const lifetime = { controller: new AbortController() };
        const send = createBrowserDaemonControlCommandSender({ machineId, serverId,
            get signal() { return lifetime.controller.signal; } });
        return { lifetime, send };
    }, [machineId, serverId]);
    React.useEffect(() => {
        if (!binding) return;
        // React may replay the effect after cleanup while keeping the same sender.
        if (binding.lifetime.controller.signal.aborted) binding.lifetime.controller = new AbortController();
        return () => binding.lifetime.controller.abort();
    }, [binding]);
    return binding?.send;
}
