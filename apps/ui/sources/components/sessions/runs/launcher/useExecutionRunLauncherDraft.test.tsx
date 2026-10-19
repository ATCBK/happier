import { afterEach, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useExecutionRunLauncherDraft } from './useExecutionRunLauncherDraft';

const scope = { serverId: 'launcher-home', accountId: 'launcher-account' };
const sessionId = 'delayed-launcher';
const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
const address = { kind: 'session' as const, sessionId };

afterEach(async () => { await standardCleanup(); resetSessionDraftRepositoryForTests(); });

it('adopts selection and identity arriving after mount without rewriting the hydrated field', async () => {
    let renders = 0;
    const hook = await renderHook(() => {
        renders += 1;
        return useExecutionRunLauncherDraft({ lifetime, sessionId,
            draftKey: 'conversation', createDefaultInput: () => ({ backendTargetKeys: ['agent:claude'] }) });
    });
    expect(getSessionDraftSnapshot(scope, address)).toBeNull();
    const selection = { identity: { correlationId: 'retained-correlation', inputLocalId: 'retained-input' },
        actionInput: { backendTargetKeys: ['agent:codex'], modelSelection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'chosen-model' } } };
    await act(async () => writeExistingSessionDraft({ scope, sessionId, patch: { executionRunLauncher: {
        key: 'conversation', patch: { text: 'Arrived after mount', selection },
    } } }));
    const hydrated = getSessionDraftSnapshot(scope, address);
    expect(hook.getCurrent().identity).toEqual(selection.identity);
    expect(hook.getCurrent().actionInput).toEqual(selection.actionInput);
    expect(getSessionDraftSnapshot(scope, address)).toBe(hydrated);
    const settledRenders = renders;
    await act(async () => writeExistingSessionDraft({ scope, sessionId, patch: { executionRunLauncher: {
        key: 'conversation', patch: { text: 'Typing stays in the composer leaf' },
    } } }));
    expect(renders).toBe(settledRenders);
});

it('preserves a newer explicit choice when an earlier send is accepted and isolates Account, Home and intent', async () => {
    const hook = await renderHook((props: { lifetime: typeof lifetime; draftKey: string }) => useExecutionRunLauncherDraft({
        ...props, sessionId, createDefaultInput: () => ({ modelId: 'default' }),
    }), { initialProps: { lifetime, draftKey: 'conversation' } });
    await act(async () => hook.getCurrent().setUserActionInput({ modelId: 'first' }));
    const captured = hook.getCurrent().captureSelection();
    await act(async () => hook.getCurrent().setUserActionInput({ modelId: 'newer' }));
    await act(async () => hook.getCurrent().clearAcceptedSelection(captured, { text: '', mentions: [], attachments: [] }));
    expect(hook.getCurrent().actionInput).toEqual({ modelId: 'newer' });
    for (const isolated of [
        { ...lifetime, scope: { ...scope, accountId: 'other-account' } },
        { ...lifetime, scope: { ...scope, serverId: 'other-home' } },
    ]) {
        await hook.rerender({ lifetime: isolated, draftKey: 'conversation' });
        expect(hook.getCurrent().actionInput).toEqual({ modelId: 'default' });
    }
    await hook.rerender({ lifetime, draftKey: 'plan' });
    expect(hook.getCurrent().actionInput).toEqual({ modelId: 'default' });
    await hook.rerender({ lifetime, draftKey: 'conversation' });
    expect(hook.getCurrent().actionInput).toEqual({ modelId: 'newer' });
    const accepted = hook.getCurrent().captureSelection();
    await act(async () => hook.getCurrent().clearAcceptedSelection(accepted, { text: '', mentions: [], attachments: [] }));
    expect(hook.getCurrent().actionInput).toEqual({ modelId: 'default' });
});
