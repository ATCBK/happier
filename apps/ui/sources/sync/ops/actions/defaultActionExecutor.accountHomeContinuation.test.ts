import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec, listActionSpecsForSurface } from '@happier-dev/protocol/actions/actionSpecs';
import type { CurrentUiContextResolvedCommand } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// Recipient-envelope APIs are network boundaries and are not used by this local continuation.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Continuation reached recipient-envelope API'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { registerCurrentUiContextActionPort } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
const { createCurrentUiContextVoiceToolPort } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
let unregister: (() => void) | undefined;

describe('authenticated Account Home continuation Action', () => {
    beforeEach(async () => { await harness.reset(); setRuntimeFetch(harness.request); });
    afterEach(() => { unregister?.(); unregister = undefined; resetRuntimeFetch(); standardCleanup(); });

    it('persists an Agent request in the same Account and runs the current mounted continuation only after its human decision', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://continuation-home.test',
            serverIdentityId: 'continuation-home', accountId: 'alice' });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice' };
        let effects = 0;
        const retirement = new AbortController();
        const command: CurrentUiContextResolvedCommand = { id: 'current-ui:continuation', retirementSignal: retirement.signal,
            command: { kind: 'accountHomeContinuation', operation: 'refresh',
                account: { scope, isCurrent: () => !retirement.signal.aborted, onRetire: () => ({ dispose() {} }) },
                invoke: async () => { effects += 1; return { status: 'completed' }; } } };
        unregister = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
            invocationSurface: surface, hostAction,
            reader: { readCurrentUiContext: () => ({ navigation: { area: 'account', screen: 'continuation' },
                commands: [{ id: command.id, title: 'Refresh Homes' }] }),
                resolveCurrentUiCommand: id => id === command.id && !retirement.signal.aborted ? command : null,
                subscribe: () => () => {} },
            readProjection: () => EMPTY_PLUGIN_UI_PROJECTION, readNavigationBinding: () => null,
        }));
        const executor = createDefaultActionExecutor();
        const spec = getActionSpec('account.home_continuation.invoke');
        expect(listActionSpecsForSurface('agent')).toContain(spec);
        expect(listActionSpecsForSurface('mcp')).toContain(spec);
        expect(listActionSpecsForSurface('api')).not.toContain(spec);
        expect(spec.requiredAuthority).toBe('present_user');
        expect(await executor.execute(spec.id, { operation: 'refresh', commandId: command.id, credential: 'must-not-be-durable' }, {
            surface: 'agent', serverId, expectedAccountId: 'alice',
        })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(effects).toBe(0);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        const request = await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, {
            surface: 'agent', authority: 'account_automation', serverId, expectedAccountId: 'alice', actionRequestId: 'home-refresh-request',
        });
        expect(request, JSON.stringify(request)).toMatchObject({ ok: true });
        if (!request.ok) throw new Error(request.error);
        const created = ActionApprovalRequestCreatedResultSchema.parse(request.result);
        expect(created.actionId).toBe('account.home_continuation.invoke');
        expect(effects).toBe(0);
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(created.artifactId) ?? 'null'))
            .toMatchObject({ actionId: created.actionId, actionArgs: { operation: 'refresh', commandId: command.id },
                executionOriginV1: { accountId: 'alice' } });
        const decision = await executor.execute('approval.request.decide', { artifactId: created.artifactId, decision: 'approve' }, {
            surface: 'ui', serverId, expectedAccountId: 'alice',
        });
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(effects).toBe(1);

        const stale = await executor.execute('account.home_continuation.invoke', { operation: 'refresh', commandId: command.id }, {
            surface: 'agent', serverId, expectedAccountId: 'alice', actionRequestId: 'home-stale-refresh-request',
        });
        if (!stale.ok) throw new Error(stale.error);
        const staleApproval = ActionApprovalRequestCreatedResultSchema.parse(stale.result);
        retirement.abort();
        expect(await executor.execute('approval.request.decide', { artifactId: staleApproval.artifactId, decision: 'approve' }, {
            surface: 'ui', serverId, expectedAccountId: 'alice',
        })).toMatchObject({ ok: true, result: { status: 'failed' } });
        expect(effects).toBe(1);
    });
});
