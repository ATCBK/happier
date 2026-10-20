import { describe, expect, it } from 'vitest';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { serveAccountHomes, serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { executeMachineAccessHttpAction } from './machineAccessApi';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';

describe('Machine access through the real Action front door', () => {
    it('reports a Home that is not answering yet as a read failure of the transport kind, not as an unknown failure', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-connecting.test', accountId: 'alice' }],
            route: () => undefined });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const before = storage.getState().endpointStatus;
        try {
            // The connection supervisor has concluded the Home is not answering: no transport can be acquired for it.
            storage.setState({ endpointStatus: 'offline' });
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            await expect(executeMachineAccessHttpAction({ scope, actionId: 'machines.access.grants.list',
                input: { serverId: scope.serverId, machineId: 'machine' } })).rejects.toMatchObject({ code: 'machine_access_request_failed' });
        } finally { storage.setState({ endpointStatus: before }); await home.dispose(); }
    });
    it('accepts a bound local profile target at the captured Home while rejecting another Home', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-alias.test', accountId: 'alice',
            serverIdentityId: 'srv_machine_alias' }],
            route: request => request.path.endsWith('/access') ? Response.json({ kind: 'saved',
                grant: { machineId: 'machine', principal: { kind: 'account', accountId: 'bob' }, level: 'view' },
                readiness: 'ready', canPrepareKeys: false }) : undefined });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            const input = { serverId: home.homes.machine!.profileId, machineId: 'machine', principal: { kind: 'account', accountId: 'bob' }, level: 'view' };
            expect(await executeMachineAccessHttpAction({ scope, actionId: 'machines.access.grant.set', input }))
                .toMatchObject({ kind: 'saved' });
            await expect(executeMachineAccessHttpAction({ scope, actionId: 'machines.access.grant.set', input: { ...input, serverId: 'srv_foreign_home' } }))
                .rejects.toMatchObject({ code: 'machine_access_stale_scope' });
            expect(home.requests.filter(request => request.path.endsWith('/access'))).toHaveLength(1);
        } finally { await home.dispose(); }
    });
    it('does not classify an issued permission write as replayable when its captured view retires before acknowledgement', async () => {
        let current = true;
        const home = await serveAccountHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-retired.test', accountId: 'alice' }],
            route: request => {
                if (request.path !== '/v1/machines/machine/access') return undefined;
                current = false;
                return Response.json(request.method === 'PUT' ? { kind: 'saved', grant: { machineId: 'machine',
                    principal: { kind: 'account', accountId: 'bob' }, level: 'view' }, readiness: 'ready', canPrepareKeys: false } : {
                    machineId: 'machine', custodian: { accountId: 'alice', displayName: 'Alice' },
                    access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                    canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
                });
            } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            const target = { serverId: scope.serverId, machineId: 'machine' };
            await expect(executeMachineAccessHttpAction({ scope, isCurrent: () => current,
                actionId: 'machines.access.grant.set', input: { ...target, principal: { kind: 'account', accountId: 'bob' }, level: 'view' },
            })).rejects.toMatchObject({ code: 'outcome_unknown' });
            current = true;
            await expect(executeMachineAccessHttpAction({ scope, isCurrent: () => current,
                actionId: 'machines.access.grants.list', input: target,
            })).rejects.toMatchObject({ code: 'machine_access_stale_scope' });
            expect(home.requests.filter(request => request.path.endsWith('/access')).map(request => request.method)).toEqual(['PUT', 'GET']);
        } finally { await home.dispose(); }
    });
    it('captures the qualified Home and Account for permission-only grants and leave, rejecting Edit before HTTP', async () => {
        const home = await serveActionHomes({ homes: [
            { key: 'machine', serverUrl: 'https://machine-access.test', accountId: 'alice', settings: {
                actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
                    'machines.access.grant.set': ['ui'], 'machines.access.leave': ['ui'],
                } },
            } },
            { key: 'focused', serverUrl: 'https://machine-focused.test', accountId: 'cara' },
        ], route: (request) => {
            if (request.home !== 'machine' || request.path !== '/v1/machines/machine/access') return undefined;
            // The Action owner reads committed access before classifying an Admin → View reduction.
            if (request.method === 'GET') return Response.json(MachineAccessGrantsListResponseV1Schema.parse({
                machineId: 'machine', custodian: { accountId: 'alice', displayName: 'Alice' },
                access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                canManage: true, grants: [{ machineId: 'machine', principal: { kind: 'account', accountId: 'bob' }, level: 'admin',
                    display: { name: 'Bob' }, readiness: 'ready', audience: [{ accountId: 'bob', displayName: 'Bob',
                        readiness: 'ready', reason: null, canPrepareKeys: false }], removal: { losesAccessAccountIds: ['bob'] } }],
                ownDirectGrant: false, ownAccessSources: [],
            }));
            if (request.method === 'PUT') return Response.json({ kind: 'saved', grant: { machineId: 'machine',
                principal: { kind: 'account', accountId: 'bob' }, level: 'view' }, readiness: 'ready', canPrepareKeys: false });
            if (request.method === 'DELETE') return Response.json({ kind: 'left', effectiveAccess: 'none' });
            return undefined;
        } });
        try {
            const execute = createFrontDoorActionExecute(createDefaultActionExecutor());
            const target = { serverId: home.homes.machine!.id, machineId: 'machine' };
            const context = { surface: 'ui' as const, source: 'ui_button' as const,
                serverId: target.serverId, expectedAccountId: 'alice' };
            const input = { ...target, principal: { kind: 'account', accountId: 'bob' }, level: 'view' };
            expect(await execute('machines.access.grant.set', input, context)).toEqual({ ok: true, result: {
                kind: 'saved', grant: { machineId: 'machine', principal: input.principal, level: 'view' }, readiness: 'ready', canPrepareKeys: false,
            } });
            expect(await execute('machines.access.grant.set', { ...input, level: 'edit' }, context)).toMatchObject({ ok: false });
            expect(await execute('machines.access.leave', target, context)).toMatchObject({ ok: true, result: { kind: 'left' } });
            const requests = home.requests.filter(request => request.path.endsWith('/access'));
            expect(requests.map(request => ({ home: request.home, accountId: request.accountId, body: request.body }))).toEqual([
                { home: 'machine', accountId: 'alice', body: undefined },
                { home: 'machine', accountId: 'alice', body: { principal: input.principal, level: 'view' } },
                { home: 'machine', accountId: 'alice', body: {} },
            ]);
            expect(home.requests.filter(request => request.path.includes('data-key-envelopes'))).toEqual([]);
        } finally { await home.dispose(); }
    });
});
