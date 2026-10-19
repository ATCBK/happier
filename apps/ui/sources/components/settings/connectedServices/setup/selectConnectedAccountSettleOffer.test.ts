import { describe, expect, it } from 'vitest';

import { selectConnectedAccountSettleOffer } from './selectConnectedAccountSettleOffer';

const CHATGPT = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;

function pool(groupId: string, fields: Readonly<{ displayName?: string | null; active?: string | null; members: readonly string[]; defaultFor?: readonly string[] }>) {
    return {
        ref: { service: CHATGPT, groupId },
        displayName: fields.displayName ?? null,
        activeConnectedAccountId: fields.active ?? null,
        members: fields.members.map((connectedAccountId, index) => ({ v: 1, connectedAccountId, priority: index, enabled: true })),
        defaultFor: fields.defaultFor ?? [],
    } as never;
}

const LABELS: Readonly<Record<string, string>> = { personal: 'Personal', team: 'Team' };
const labelFor = (accountId: string) => LABELS[accountId] ?? null;
const agentDefault = { agentTitle: 'OpenCode', agentId: 'opencode' };

describe('selectConnectedAccountSettleOffer', () => {
    it('offers the pool an agent signs in through, naming that agent and the account it uses now', () => {
        const offer = selectConnectedAccountSettleOffer({
            account: { service: CHATGPT, accountId: 'bot' },
            pools: [
                pool('spare', { displayName: 'Spare', members: ['team'] }),
                pool('codex', { displayName: 'Codex pool', active: 'personal', members: ['personal', 'team'], defaultFor: ['Codex'] }),
            ],
            agentDefault,
            labelFor,
        });
        expect(offer).toEqual({ kind: 'pool', groupId: 'codex', poolName: 'Codex pool', agentTitle: 'Codex', activeLabel: 'Personal' });
    });

    it('never offers a pool the account is already in', () => {
        const offer = selectConnectedAccountSettleOffer({
            account: { service: CHATGPT, accountId: 'bot' },
            pools: [pool('codex', { displayName: 'Codex pool', active: 'bot', members: ['bot'], defaultFor: ['Codex'] })],
            agentDefault,
            labelFor,
        });
        expect(offer).toEqual({ kind: 'agentDefault', ...agentDefault });
    });

    it('falls back to making it an agent’s default only where the service has no pool', () => {
        expect(selectConnectedAccountSettleOffer({
            account: { service: CHATGPT, accountId: 'bot' },
            pools: [],
            agentDefault,
            labelFor,
        })).toMatchObject({ kind: 'agentDefault', agentTitle: 'OpenCode' });
        expect(selectConnectedAccountSettleOffer({
            account: { service: CHATGPT, accountId: 'bot' },
            pools: [],
            agentDefault: null,
            labelFor,
        })).toBeNull();
    });

    it('offers a pool no agent defaults to by its name alone', () => {
        const offer = selectConnectedAccountSettleOffer({
            account: { service: CHATGPT, accountId: 'bot' },
            pools: [pool('spare', { members: ['team'] })],
            agentDefault,
            labelFor,
        });
        expect(offer).toEqual({ kind: 'pool', groupId: 'spare', poolName: 'spare', agentTitle: null, activeLabel: null });
    });
});
