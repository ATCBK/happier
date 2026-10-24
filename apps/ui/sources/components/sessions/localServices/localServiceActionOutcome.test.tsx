import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ActionApprovalRequestCreatedResultSchema, projectUnexpectedActionFailureV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { LocalServiceNativePrerequisiteV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';

const modalSpies = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalSpies.alert } }).module;
});

import {
    readLocalServiceActionOutcome,
    presentLocalServiceActionFailure,
    useLocalServiceActionRunner,
} from './localServiceActionOutcome';

describe('readLocalServiceActionOutcome', () => {
    it.each(['approval_canceled', 'approval_rejected', 'cancelled'])('classifies the shared policy decline as cancelled (%s)', errorCode => {
        expect(readLocalServiceActionOutcome({ ok: false, errorCode, error: errorCode }))
            .toEqual({ kind: 'cancelled' });
    });
    it('retains a strict establishment cause for existing Details and rejects extra output fields', () => {
        const establishmentFailure = { cause: 'port_in_use', port: 5173, exitCode: 1,
            sameProject: true, lastStderrLine: 'Error: listen EADDRINUSE: address already in use :::5173' };
        const result = { status: 'denied', reasonCode: 'plugin_managed_service_establishment_failed', establishmentFailure };
        const outcome = readLocalServiceActionOutcome(result);
        expect(outcome).toEqual({ kind: 'failed', reasonCode: result.reasonCode, establishmentFailure });
        expect(readLocalServiceActionOutcome({ ...result, establishmentFailure: { ...establishmentFailure, stdout: 'private' } }))
            .toEqual({ kind: 'failed', reasonCode: result.reasonCode });
        if (outcome.kind !== 'failed') throw new Error('Missing failure');
        modalSpies.alert.mockClear();
        presentLocalServiceActionFailure({ title: 'Could not start', ...outcome });
        expect(modalSpies.alert.mock.calls[0]?.[1]).toContain('5173');
        expect(modalSpies.alert.mock.calls[0]?.[1]).toContain('project');
        const buttons = modalSpies.alert.mock.calls[0]?.[2] as import('@/modal/types').AlertButton[];
        buttons.find(button => button.onPress)?.onPress?.();
        expect(modalSpies.alert.mock.calls[1]?.[1]).toContain(establishmentFailure.lastStderrLine);
        expect(modalSpies.alert.mock.calls[1]?.[1]).toContain('1');
    });
    it('retains only strict Docker prerequisite details for the failure presenter', () => {
        const prerequisite = LocalServiceNativePrerequisiteV1Schema.parse({ tool: 'docker', machineName: 'nl1', cause: 'permission_denied' });
        expect(readLocalServiceActionOutcome({ status: 'denied', reasonCode: 'native_tool_unavailable', prerequisite }))
            .toEqual({ kind: 'failed', reasonCode: 'native_tool_unavailable', prerequisite });
        expect(readLocalServiceActionOutcome({ status: 'denied', reasonCode: 'native_tool_unavailable',
            prerequisite: { ...prerequisite, stderr: 'private native output' } }))
            .toEqual({ kind: 'failed', reasonCode: 'native_tool_unavailable' });
    });
    it('retains the local-services refusal detail instead of its generic Action wrapper', () => {
        expect(readLocalServiceActionOutcome({ ok: false, errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:localServices:local_services_inventory_request_failed' }))
            .toEqual({ kind: 'failed', reasonCode: 'local_services_inventory_request_failed' });
        expect(readLocalServiceActionOutcome(new RpcError('private transport detail', RPC_ERROR_CODES.FORBIDDEN)))
            .toEqual({ kind: 'failed', reasonCode: RPC_ERROR_CODES.FORBIDDEN });
    });
    it('retains only a code-shaped Browser refusal detail, never arbitrary transport prose', () => {
        expect(readLocalServiceActionOutcome({ ok: false, errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_adapter_unavailable' }))
            .toEqual({ kind: 'failed', reasonCode: 'browser_adapter_unavailable' });
        expect(readLocalServiceActionOutcome({ ok: false, errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:private transport detail' }))
            .toEqual({ kind: 'failed', reasonCode: 'runtime_action_disabled' });
    });
    it('keeps a real Ask-first receipt pending rather than reporting a successful mutation', () => {
        const receipt = ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
            artifactId: 'service-approval', actionId: 'localServices.launcher.start' });
        expect(readLocalServiceActionOutcome(receipt)).toEqual({ kind: 'approval_pending',
            artifactId: receipt.artifactId, actionId: receipt.actionId });
        expect(readLocalServiceActionOutcome(false)).toEqual({ kind: 'failed', reasonCode: null });
    });
    it('classifies every failure shape the corridor can actually produce', () => {
        // A guard that never dispatched: no daemon code, still a failure the user must see.
        expect(readLocalServiceActionOutcome(undefined)).toEqual({ kind: 'failed', reasonCode: null });
        // The action-executor front door refusing before the daemon saw it.
        expect(readLocalServiceActionOutcome({ ok: false, errorCode: 'permission_denied' }))
            .toEqual({ kind: 'failed', reasonCode: 'permission_denied' });
        // The daemon refusing, or trying and failing.
        expect(readLocalServiceActionOutcome({ status: 'denied', reasonCode: 'policy_forbids_action' }))
            .toEqual({ kind: 'failed', reasonCode: 'policy_forbids_action' });
        expect(readLocalServiceActionOutcome({ status: 'failed', reasonCode: 'executor_failed' }))
            .toEqual({ kind: 'failed', reasonCode: 'executor_failed' });
    });

    it('does not mistake a success payload for a failure', () => {
        expect(readLocalServiceActionOutcome({ status: 'succeeded' })).toEqual({ kind: 'succeeded' });
        // A launch handler that resolves the opened target, with no envelope at all.
        expect(readLocalServiceActionOutcome({ exposureId: 'exposure-a' })).toEqual({ kind: 'succeeded' });
        expect(readLocalServiceActionOutcome(true)).toEqual({ kind: 'succeeded' });
    });
});

function renderRunner() {
    const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
    function Harness() {
        value.current = useLocalServiceActionRunner();
        return React.createElement('View');
    }
    return { value, Harness };
}

describe('useLocalServiceActionRunner', () => {
    afterEach(standardCleanup);
    beforeEach(() => modalSpies.alert.mockReset());

    it('does not settle an unknown Stop from the binding that was already running', async () => {
        const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
        function Harness() {
            value.current = useLocalServiceActionRunner({ presentation: 'inline', observedNativeBinding: true });
            return React.createElement('View');
        }
        await renderScreen(<Harness />);
        await act(async () => { await value.current?.run({ id: 'stop', failureTitle: 'Could not stop',
            action: async () => projectUnexpectedActionFailureV1(null) }); });
        expect(value.current?.failure?.reasonCode).toBe('action_outcome_unknown');
        expect(value.current?.failure?.retry).toBeNull();
    });

    it.each(['approval_canceled', 'approval_rejected', 'cancelled'])('clears pending without success or failure presentation when shared policy is declined (%s)', async errorCode => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);
        await act(async () => {
            expect(await value.current?.run({ id: 'row:declined', failureTitle: 'Could not stop',
                action: async () => ({ ok: false, errorCode, error: errorCode }) })).toBe(false);
        });
        expect(value.current?.pendingId).toBeNull();
        expect(value.current?.failure).toBeNull();
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it.each(['not_installed', 'not_running', 'permission_denied', 'unavailable'])('shows the named machine and Docker prerequisite through the existing failure dialog (%s)', async cause => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);
        await act(async () => {
            expect(await value.current?.run({ id: 'docker', failureTitle: 'Could not start api',
                action: async () => ({ status: 'denied', reasonCode: 'native_tool_unavailable',
                    prerequisite: LocalServiceNativePrerequisiteV1Schema.parse({ tool: 'docker', machineName: 'nl1', cause }) }) })).toBe(false);
        });
        const body = String(modalSpies.alert.mock.calls[0]?.[1]);
        expect(body).toContain('nl1');
        expect(body).toContain('Docker');
        if (cause !== 'unavailable') expect(body).not.toContain(cause);
        const buttons = modalSpies.alert.mock.calls[0]?.[2] as import('@/modal/types').AlertButton[];
        buttons.find(button => button.onPress)?.onPress?.();
        expect(modalSpies.alert.mock.calls[1]?.[1]).toContain('native_tool_unavailable');
    });

    it('keeps an inline failure for the owner to render instead of opening a dialog, until the next run or a dismissal', async () => {
        const value: { current: ReturnType<typeof useLocalServiceActionRunner> | null } = { current: null };
        function Harness() { value.current = useLocalServiceActionRunner({ presentation: 'inline' }); return React.createElement('View'); }
        await renderScreen(<Harness />);
        const action = vi.fn(async () => ({ status: 'denied', reasonCode: 'native_tool_unavailable',
            prerequisite: LocalServiceNativePrerequisiteV1Schema.parse({ tool: 'docker', machineName: 'nl1', cause: 'permission_denied' }) }));
        await act(async () => { await value.current?.run({ id: 'row:inline', failureTitle: 'Could not start api', action }); });
        expect(modalSpies.alert).not.toHaveBeenCalled();
        expect(value.current?.failure).toMatchObject({ title: 'Could not start api', reasonCode: 'native_tool_unavailable' });
        expect(value.current?.failure?.body).toContain('Docker');
        expect(value.current?.failure?.details).toContain('native_tool_unavailable');
        await act(async () => { value.current?.failure?.retry?.(); });
        expect(action).toHaveBeenCalledTimes(2);
        expect(value.current?.failure).not.toBeNull();
        await act(async () => { value.current?.dismissFailure(); });
        expect(value.current?.failure).toBeNull();
        await act(async () => { await value.current?.run({ id: 'row:inline', failureTitle: 'Could not start api', action: async () => ({ status: 'succeeded' }) }); });
        expect(value.current?.failure).toBeNull();
    });

    it('does not trigger success affordances or a failure alert for a pending policy approval', async () => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);
        let outcome: boolean | undefined;
        await act(async () => {
            outcome = await value.current?.run({ id: 'row:approval', failureTitle: 'Could not start',
                action: async () => ActionApprovalRequestCreatedResultSchema.parse({ kind: 'approval_request_created',
                    artifactId: 'service-approval', actionId: 'localServices.launcher.start' }) });
        });
        expect(outcome).toBe(false);
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('clears the in-flight row through the StrictMode effect replay', async () => {
        // The row spinner is driven by `pendingId`. A mounted-guard that is only ever set to
        // `false` in cleanup never recovers from React's development effect replay, so the row
        // would stay busy forever after an action the user actually completed.
        const { value, Harness } = renderRunner();
        await renderScreen(<React.StrictMode><Harness /></React.StrictMode>);

        let settle!: (result: unknown) => void;
        const dispatched = new Promise<unknown>((resolve) => { settle = resolve; });
        let pending!: Promise<boolean>;
        await act(async () => {
            pending = value.current!.run({
                id: 'row-a:menu',
                failureTitle: 'Could not terminate Vite',
                action: () => dispatched,
            });
            await Promise.resolve();
        });
        expect(value.current?.pendingId).toBe('row-a:menu');

        await act(async () => {
            settle({ status: 'succeeded' });
            await pending;
        });
        expect(value.current?.pendingId).toBeNull();
        expect(modalSpies.alert).not.toHaveBeenCalled();
    });

    it('shows one actionable failure and resolves false when the action is refused', async () => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);

        let outcome: boolean | undefined;
        await act(async () => {
            outcome = await value.current?.run({
                id: 'row-a:inline',
                failureTitle: 'Could not start Vite',
                action: async () => ({ status: 'denied', reasonCode: 'policy_forbids_action' }),
            });
        });

        expect(outcome).toBe(false);
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        const [title, body] = modalSpies.alert.mock.calls[0] ?? [];
        expect(title).toBe('Could not start Vite');
        // Failure copy remains readable; diagnostic enum codes do not appear in the primary body.
        expect(typeof body).toBe('string');
        expect(String(body).length).toBeGreaterThan(0);
        expect(String(body)).not.toContain('policy_forbids_action');
        const buttons = modalSpies.alert.mock.calls[0]?.[2] as import('@/modal/types').AlertButton[];
        buttons.find(button => button.onPress)?.onPress?.();
        expect(modalSpies.alert.mock.calls[1]?.[1]).toContain('policy_forbids_action');
        expect(value.current?.pendingId).toBeNull();
    });

    it.each(['service_not_listening', 'preview_unknown_managed_service'])('names the stopped Service and its recovery for %s', async reasonCode => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);
        await act(async () => {
            await value.current?.run({ id: 'open-again', failureTitle: 'Open again', serviceName: 'Reading desk',
                action: async () => ({ status: 'denied', reasonCode }) });
        });
        const body = modalSpies.alert.mock.calls[0]?.[1];
        expect(body).toContain('Reading desk');
        expect(body).toContain('Services');
        expect(body).not.toContain(reasonCode);
        expect(value.current?.pendingId).toBeNull();
    });

    it.each([
        new RpcError('private transport detail', RPC_ERROR_CODES.FORBIDDEN),
        'private transport detail',
        { code: RPC_ERROR_CODES.FORBIDDEN, message: 'private transport detail' },
    ])('treats a thrown transport error as the same visible failure as a returned refusal (%s)', async error => {
        const { value, Harness } = renderRunner();
        await renderScreen(<Harness />);

        let outcome: boolean | undefined;
        await act(async () => {
            outcome = await value.current?.run({
                id: 'row-a:inline',
                failureTitle: 'Could not open Vite',
                action: async () => { throw error; },
            });
        });

        expect(outcome).toBe(false);
        expect(modalSpies.alert).toHaveBeenCalledTimes(1);
        expect(modalSpies.alert.mock.calls[0]?.[1]).not.toContain(RPC_ERROR_CODES.FORBIDDEN);
        expect(modalSpies.alert.mock.calls[0]?.[1]).not.toContain('private transport detail');
        expect(value.current?.pendingId).toBeNull();
    });
});
