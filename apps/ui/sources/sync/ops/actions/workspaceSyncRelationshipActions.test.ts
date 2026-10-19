import { describe, expect, it, vi } from 'vitest';

// Genuine boundary: the Account row sync engine that reads rows back from the Home.
const refreshProjectAccountRows = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/sync/sync', () => ({ sync: { refreshProjectAccountRows } }));

import {
    disableWorkspaceSyncRelationshipAction,
    enableWorkspaceSyncRelationshipAction,
    flushWorkspaceSyncRelationshipAction,
    terminateWorkspaceSyncRelationship,
} from './workspaceSyncRelationshipActions';

const input = { controllerMachineId: 'machine-a', relationshipId: 'relationship-a' };
const status = {
    relationshipId: 'relationship-a', controllerMachineId: 'machine-a', state: 'watching' as const,
    alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_both_in_sync' as const,
    endpointStates: { alpha: null, beta: null }, conflictCount: 0, lastCycleObservedAtMs: 1,
};

describe('workspace Sync relationship Action adapters', () => {
    it.each([
        ['workspace.sync.relationship.disable', disableWorkspaceSyncRelationshipAction,
            { v: 1 as const, relationshipId: 'relationship-a', enabled: false as const }],
        ['workspace.sync.relationship.enable', enableWorkspaceSyncRelationshipAction,
            { v: 1 as const, relationshipId: 'relationship-a', enabled: true as const }],
        ['workspace.sync.relationship.flush', flushWorkspaceSyncRelationshipAction,
            { v: 1 as const, relationshipId: 'relationship-a', status }],
        ['workspace.sync.relationship.terminate', terminateWorkspaceSyncRelationship,
            { v: 1 as const, relationshipId: 'relationship-a', terminated: true as const }],
    ] as const)('parses the strict %s producer result at the mounted consumer', async (actionId, run, output) => {
        const execute = vi.fn(async () => ({ ok: true as const, result: output }));

        await expect(run(input, null, execute)).resolves.toEqual({ ok: true, ...output });
        expect(execute).toHaveBeenCalledWith(actionId, input);
    });

    it('rejects a producer result outside the strict lifecycle schema', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: {
            v: 1, relationshipId: 'relationship-a', enabled: false, extra: true,
        } }));

        await expect(disableWorkspaceSyncRelationshipAction(input, null, execute)).resolves.toEqual({
            ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown',
        });
    });

    it.each([
        ['disable', disableWorkspaceSyncRelationshipAction, { v: 1 as const, relationshipId: 'relationship-a', enabled: false as const }],
        ['enable', enableWorkspaceSyncRelationshipAction, { v: 1 as const, relationshipId: 'relationship-a', enabled: true as const }],
        ['terminate', terminateWorkspaceSyncRelationship, { v: 1 as const, relationshipId: 'relationship-a', terminated: true as const }],
    ] as const)('reads the Account rows back after a settled %s so the list drops or updates the link', async (_name, run, output) => {
        refreshProjectAccountRows.mockClear();
        await run(input, null, async () => ({ ok: true as const, result: output }));
        expect(refreshProjectAccountRows).toHaveBeenCalledOnce();
    });

    it('does not read rows back after a refused lifecycle Action or a flush, and keeps the Action outcome if the read fails', async () => {
        refreshProjectAccountRows.mockClear();
        await terminateWorkspaceSyncRelationship(input, null, async () => ({ ok: false as const, errorCode: 'target_bootstrap_required', error: 'refused' }));
        await flushWorkspaceSyncRelationshipAction(input, null, async () => ({ ok: true as const, result: { v: 1, relationshipId: 'relationship-a', status } }));
        expect(refreshProjectAccountRows).not.toHaveBeenCalled();

        refreshProjectAccountRows.mockRejectedValueOnce(new Error('rows unavailable'));
        await expect(terminateWorkspaceSyncRelationship(input, null, async () => ({
            ok: true as const, result: { v: 1, relationshipId: 'relationship-a', terminated: true },
        }))).resolves.toMatchObject({ ok: true });
    });
});
