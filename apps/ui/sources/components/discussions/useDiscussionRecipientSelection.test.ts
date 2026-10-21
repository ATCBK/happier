import { afterEach, describe, expect, it } from 'vitest';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { useDiscussionDraft } from './useDiscussionDraft';
import { useDiscussionRecipientSelection } from './useDiscussionRecipientSelection';

afterEach(() => { standardCleanup(); resetSessionDraftRepositoryForTests(); });

describe('Discussion recipient chip model', () => {
    it('multi-selects admitted concrete identities with equal labels and restores them independently of the current roster', async () => {
        const scope = { serverId: 'recipient-home', accountId: 'owner' };
        const address = { kind: 'discussion' as const, discussionId: 'discussion' };
        const label = () => 'Same label';
        const roster = DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'discussion', ownerAccountId: 'owner', access: 'owner',
            grants: [{ principal: { kind: 'account', accountId: 'same-id' }, accessLevel: 'edit', createdByAccountId: 'owner', createdAt: 1, display: { name: 'Same label' } }],
            participants: [{ participant: { kind: 'session', sessionId: 'same-id' }, answerPolicy: 'when_addressed', createdAt: 1 },
                ...['bound', 'unbound'].map(slot => ({ participant: { kind: 'model', participantSlotId: slot },
                    sessionId: slot === 'bound' ? 'bound-session' : null, answerPolicy: 'when_addressed', createdAt: 1,
                    launch: { executionTarget: { serverId: scope.serverId, machineId: 'machine' }, directory: { kind: 'path', path: '/workspace' },
                        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                        configuration: { mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
                            permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {} } } }))] });
        const hook = await renderHook(({ currentRoster }) => {
            const draft = useDiscussionDraft({ scope, address });
            return { draft, selection: useDiscussionRecipientSelection({ draft, roster: currentRoster, label }) };
        }, { initialProps: { currentRoster: roster as typeof roster | null } });
        expect(hook.getCurrent().selection.targets.map(target => target.id)).toEqual(['account:owner', 'account:same-id', 'session:same-id', 'session:bound-session']);
        act(() => hook.getCurrent().selection.toggle('account:same-id'));
        act(() => hook.getCurrent().selection.toggle('session:same-id'));
        expect(hook.getCurrent().selection.selectedIds).toEqual(['account:same-id', 'session:same-id']);
        expect(hook.getCurrent().draft.recipients).toEqual([{ kind: 'account', accountId: 'same-id' }, { kind: 'session', sessionId: 'same-id' }]);
        const stable = hook.getCurrent().selection;
        await hook.rerender({ currentRoster: roster });
        expect(hook.getCurrent().selection).toBe(stable);
        act(() => hook.getCurrent().draft.setText('Typing does not rebuild recipients'));
        expect(hook.getCurrent().selection).toBe(stable);
        act(() => hook.getCurrent().selection.toggle('session:outsider'));
        expect(hook.getCurrent().selection).toBe(stable);
        await hook.rerender({ currentRoster: null });
        expect(hook.getCurrent().selection.targets).toEqual([]);
        expect(hook.getCurrent().draft.recipients).toHaveLength(2);
        await hook.rerender({ currentRoster: roster });
        act(() => hook.getCurrent().selection.toggle('session:same-id'));
        expect(hook.getCurrent().selection.selectedIds).toEqual(['account:same-id']);
        act(() => hook.getCurrent().selection.clear());
        expect(hook.getCurrent().draft.recipients).toEqual([]);
        await hook.unmount();
    });
});
