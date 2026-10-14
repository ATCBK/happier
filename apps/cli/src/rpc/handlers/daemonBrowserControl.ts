import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonBrowserControlDispatchRequestV1Schema, DaemonBrowserControlDispatchResponseV1Schema, DaemonBrowserViewListRequestV1Schema, DaemonBrowserViewListResponseV1Schema } from '@happier-dev/protocol/browser/control/v1';
import type { DaemonBrowserControlDispatchResponseV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { BrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';

// W2-A-1 / A3: expose the existing `createBrowserDaemonControlRoutes` broker as a UI-reachable
// machine-scoped RPC. The human-owner control surface (streamed/sidecar view reload/stop/navigate)
// supplies a real `sendDaemonCommand` transport that routes a `BrowserCommandV1` here, through the
// SAME control broker the agent execution-run dispatch uses (MC-6 — one daemon control owner, no
// parallel path). The route is owner-scoped (account+machine, direct_ephemeral) — the user-initiated
// UI and automation callers retain verified ingress authority and request cancellation;
// control and confidentiality decisions stay with the shared Browser owner.
export type DaemonBrowserControlHandlerOptions = Readonly<{
    browserControl?: BrowserDaemonControlRoutes | null;
}>;

export function registerDaemonBrowserControlHandler(
    rpc: RpcHandlerRegistrar,
    options: DaemonBrowserControlHandlerOptions = {},
): void {
    rpc.registerHandler(RPC_METHODS.DAEMON_BROWSER_VIEW_LIST, async (raw: unknown) => {
        const request = DaemonBrowserViewListRequestV1Schema.parse(raw);
        if (!options.browserControl) throw new Error('Browser control runtime is unavailable');
        return DaemonBrowserViewListResponseV1Schema.parse({ protocolVersion: 1,
            views: options.browserControl.listViews(request.browserSessionId) });
    });
    rpc.registerHandler(
        RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
        async (raw: unknown, context?: RpcHandlerContext): Promise<DaemonBrowserControlDispatchResponseV1> => {
            const request = DaemonBrowserControlDispatchRequestV1Schema.parse(raw);
            if (!options.browserControl) {
                throw new Error('Browser control runtime is unavailable');
            }
            const result = await options.browserControl.dispatchCommand(request.command, {
                authority: context?.callerAuthority ?? 'account_automation',
                signal: context?.signal,
            });
            return DaemonBrowserControlDispatchResponseV1Schema.parse({
                protocolVersion: 1,
                result,
            });
        },
    );
}
