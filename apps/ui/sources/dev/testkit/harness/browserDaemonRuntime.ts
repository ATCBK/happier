import { vi } from 'vitest';
import type { RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';
import type { FeaturesResponseSchema } from '@happier-dev/protocol';

type View = Readonly<{ browserSessionId: string; viewId: string }>;
type ReverseClient = Readonly<{
    hasConnectedClientRpcHandler(method: string): boolean;
    callConnectedClientRpc(method: string, payload: unknown,
        options?: Readonly<{ timeoutMs?: number; signal?: AbortSignal; onIssued?: () => void }>): Promise<
            Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; error?: string; errorCode?: string }>>;
}>;

/** Load real daemon owners under Vitest without rooting CLI aliases in the UI compiler program. */
export async function loadBrowserDaemonRuntimeForTests() {
    const runtimeSource = '../../../../../cli/src/daemon/runtimeActionExecutor';
    const reverseSource = '../../../../../cli/src/daemon/browser/automation/reverseDispatch';
    const [runtime, reverse] = await Promise.all([
        vi.importActual<{ createDaemonRuntimeActionExecutor(input: Readonly<{
            env: Readonly<Record<string, string | undefined>>;
            resolveRouteOwners(): Readonly<{ browserUiAutomation?: Readonly<{
                ownsAutomationView(view: View): boolean; uiAutomation: RuntimeActionExecute;
            }> }>;
            resolveServerFeaturesSnapshot(): Readonly<{ status: 'ready'; features: ReturnType<typeof FeaturesResponseSchema.parse> }>;
        }>): RuntimeActionExecute }>(runtimeSource),
        vi.importActual<{ createBrowserAutomationReverseDispatcher(input: Readonly<{
            getMachineClient(): ReverseClient | null | undefined;
        }>): RuntimeActionExecute }>(reverseSource),
    ]);
    return { ...runtime, ...reverse };
}
