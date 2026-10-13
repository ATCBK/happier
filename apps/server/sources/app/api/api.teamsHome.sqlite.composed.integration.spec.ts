import Fastify from 'fastify';
import { io as connectSocket, type Socket } from 'socket.io-client';
import type { Server as SocketServer } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccountDisplayProfileV1Schema, HomeAccountListResultV1Schema, HomeSettingsProjectionV1Schema, resolveAccountDisplayLabelV1 } from '@happier-dev/protocol';
import { AccountNameUpdateResponseV1Schema } from '@happier-dev/protocol/account/profile';
import { TeamInvitationAcceptResultV1Schema, TeamInvitationCreateResultV1Schema, TeamInvitationsPageV1Schema, TeamMemberRemoveResultV1Schema, TeamMembersPageV1Schema, TeamSummaryV1Schema, TeamsPageV1Schema } from '@happier-dev/protocol/teams';

import { auth } from '@/app/auth/auth';
import { linkIdentityInTx } from '@/app/auth/providers/accountIdentityLifecycle';
import { startSocket } from '@/app/api/socket';
import { registerApiRoutes } from '@/app/api/api';
import { createHomeConnectionDescriptorContinuityStoreForServer } from '@/app/features/homeConnectionDescriptorContinuity';
import { resetHomeConnectionDescriptorRevisionOwnerForTests } from '@/app/features/homeConnectionDescriptorPublication';
import { registerAuthEmailApplicationLinkTarget } from '@/app/auth/email/resolveAuthEmailDelivery';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { resolveApiRateLimitPluginOptions } from '@/app/api/utils/apiRateLimitPolicy';
import { eventRouter } from '@/app/events/eventRouter';
import { initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { readHomeConfigEnv } from '@/app/home/settings/homeSettings';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';

/** Real HTTP, Socket.IO, authentication, transactions and projection consumers over disposable SQLite. */
describe('Teams/Home journeys through the production API root', () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof Fastify>;
    let endpoint: string;
    const sockets: Socket[] = [];

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-teams-home-composed-', initAuth: true, initEncrypt: true, initFiles: true,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '0' },
        });
        await initializeServerIdentityCache();
        app = Fastify({ logger: false });
        app.register(import('@fastify/rate-limit'), resolveApiRateLimitPluginOptions(process.env));
        enableSchemaValidation(app);
        const routes = app.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
        enableAuthentication(routes);
        startSocket(routes);
        registerApiRoutes(routes, {
            homeConnectionDescriptorContinuityStore: createHomeConnectionDescriptorContinuityStoreForServer(process.env),
        });
        endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 120_000);

    afterAll(async () => {
        for (const socket of sockets) socket.disconnect();
        if (app?.machineDaemonPresence) await (app.machineDaemonPresence as SocketServer).close();
        if (app) await app.close();
        eventRouter.clearIo();
        registerAuthEmailApplicationLinkTarget(null);
        resetHomeConnectionDescriptorRevisionOwnerForTests();
        if (harness) await harness.close();
    });

    afterEach(async () => {
        for (const socket of sockets.splice(0)) socket.disconnect();
        harness.restoreEnv();
        resetHomeConnectionDescriptorRevisionOwnerForTests();
        await db.homeAdministrationEvent.deleteMany();
        await db.homeSettings.deleteMany();
        await db.team.deleteMany();
        await db.account.deleteMany();
    });

    async function account(homeRole: 'owner' | 'member' = 'member') {
        const row = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain', homeRole } });
        const token = await auth.createToken(row.id, undefined, {
            kind: 'account', authority: 'present_user', authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
        });
        return { id: row.id, token };
    }

    async function post(token: string, path: string, input: unknown) {
        return fetch(`${endpoint}${path}`, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(input),
        });
    }

    async function invitedMember() {
        // Explicit ingress facts belong to this disposable, listening Home.
        Object.assign(process.env, { HAPPIER_CANONICAL_SERVER_URL: endpoint, HAPPIER_PUBLIC_SERVER_URL: endpoint, HAPPIER_WEBAPP_URL: 'https://app.example.test' });
        const owner = await account('owner');
        const member = await account();
        const created = await post(owner.token, '/v1/teams/create', { v: 1, name: 'Invited Team', initialOwnerAccountId: owner.id, requestKey: crypto.randomUUID() });
        expect(created.status).toBe(200);
        const team = TeamSummaryV1Schema.parse(await created.json());
        const response = await post(owner.token, '/v1/teams/invitations/create', {
            v: 1, teamId: team.id, role: 'member', historyAccess: 'from_membership', recipientEmail: null, requestKey: crypto.randomUUID(),
        });
        expect(response.status).toBe(200);
        const invitation = TeamInvitationCreateResultV1Schema.parse(await response.json());
        expect(typeof invitation.joinUrl).toBe('string');
        if (invitation.joinUrl === null) throw new Error('Home did not publish an invitation link');
        const token = new URL(invitation.joinUrl).pathname.split('/').at(-1)!;
        const stored = await db.teamInvitation.findUniqueOrThrow({ where: { id: invitation.invitation.id } });
        // A failed assertion must not print the live bearer.
        expect(JSON.stringify(stored).includes(token)).toBe(false);
        const accepted = await post(member.token, '/v1/team-invitations/accept', { v: 1, token });
        expect(accepted.status).toBe(200);
        expect(TeamInvitationAcceptResultV1Schema.parse(await accepted.json())).toMatchObject({ outcome: 'joined', teamId: team.id });
        return { owner, member, team, invitation };
    }

    it('creates an invitation, accepts it and lists the resulting member through the production API root', async () => {
        const { owner, member, team, invitation } = await invitedMember();
        const membersResponse = await post(owner.token, '/v1/teams/members/list', { v: 1, teamId: team.id, filter: 'all' });
        expect(membersResponse.status).toBe(200);
        const members = TeamMembersPageV1Schema.parse(await membersResponse.json());
        expect(members.items.map(row => row.accountId).sort()).toEqual([owner.id, member.id].sort());
        expect(members.items.find(row => row.accountId === member.id)).toMatchObject({ role: 'member', status: 'active' });
        const invitationsResponse = await post(owner.token, '/v1/teams/invitations/list', { v: 1, teamId: team.id, state: 'accepted', cursor: null, limit: 1 });
        expect(invitationsResponse.status).toBe(200);
        const invitations = TeamInvitationsPageV1Schema.parse(await invitationsResponse.json());
        expect(invitations.items.find(row => row.id === invitation.invitation.id)).toMatchObject({ state: 'accepted', acceptedByAccountId: member.id });
    });

    it('leaves a Team through the production API root and withdraws membership, directory visibility and counts', async () => {
        const { owner, member, team } = await invitedMember();
        const before = await post(member.token, '/v1/teams/list', { v: 1, scope: 'member', archived: 'active' });
        expect(before.status).toBe(200);
        expect(TeamsPageV1Schema.parse(await before.json()).items.map(row => row.id)).toContain(team.id);
        const refusedOwner = await post(owner.token, '/v1/teams/members/leave', { v: 1, teamId: team.id });
        expect(refusedOwner.status).toBe(409);
        expect(await refusedOwner.json()).toEqual({ error: 'team_owner_transfer_required' });
        const left = await post(member.token, '/v1/teams/members/leave', { v: 1, teamId: team.id });
        expect(left.status).toBe(200);
        expect(TeamMemberRemoveResultV1Schema.parse(await left.json())).toMatchObject({ status: 'removed' });
        expect(await db.teamMembership.count({ where: { teamId: team.id, accountId: member.id } })).toBe(0);
        const after = await post(member.token, '/v1/teams/list', { v: 1, scope: 'member', archived: 'active' });
        expect(after.status).toBe(200);
        expect(TeamsPageV1Schema.parse(await after.json()).items.map(row => row.id)).not.toContain(team.id);
        const summary = await post(owner.token, '/v1/teams/get', { v: 1, teamId: team.id });
        expect(summary.status).toBe(200);
        expect(TeamSummaryV1Schema.parse(await summary.json()).counts?.members).toBe(1);
    });

    it('stores trimmed and cleared names without Friends and publishes committed names to the real socket and strict readers', async () => {
        const self = await account('owner');
        const other = await account();
        const updates: unknown[] = [];
        const publishedName = (name: string) => updates.some(value => {
            if (!value || typeof value !== 'object') return false;
            const body: unknown = Reflect.get(value, 'body');
            return body !== null && typeof body === 'object' && Reflect.get(body, 't') === 'update-account'
                && Reflect.get(body, 'name') === name;
        });
        const socket = connectSocket(endpoint, {
            path: '/v1/updates', transports: ['websocket'], reconnection: false, autoConnect: false,
            auth: { token: self.token, clientType: 'user-scoped', clientPurpose: 'sync' },
        });
        sockets.push(socket);
        socket.on('update', (value: unknown) => updates.push(value));
        const connected = new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('connect_error', reject);
        });
        socket.connect();
        await connected;
        await expect.poll(() => eventRouter.getConnections(self.id)?.size ?? 0).toBe(1);

        const created = await post(self.token, '/v1/teams/create', {
            v: 1, name: 'Name projection', initialOwnerAccountId: self.id, requestKey: crypto.randomUUID(),
        });
        expect(created.status).toBe(200);
        const team = TeamSummaryV1Schema.parse(await created.json());
        const response = await post(self.token, '/v1/account/profile', { name: '  Captain  ' });
        expect(response.status).toBe(200);
        expect(AccountNameUpdateResponseV1Schema.parse(await response.json())).toMatchObject({ name: 'Captain', firstName: 'Captain', lastName: null });
        expect((await db.account.findUniqueOrThrow({ where: { id: self.id } })).name).toBe('Captain');
        await expect.poll(() => publishedName('Captain')).toBe(true);
        expect(updates).toContainEqual(expect.objectContaining({
            body: expect.objectContaining({ t: 'update-account', id: self.id, name: 'Captain', firstName: 'Captain', lastName: null }),
        }));

        const membersResponse = await post(self.token, '/v1/teams/members/list', { v: 1, teamId: team.id, filter: 'all' });
        expect(membersResponse.status).toBe(200);
        const members = TeamMembersPageV1Schema.parse(await membersResponse.json());
        const member = members.items.find(row => row.accountId === self.id);
        expect(member).toBeDefined();
        expect(resolveAccountDisplayLabelV1(AccountDisplayProfileV1Schema.parse(member!.account))).toBe('Captain');
        const peopleResponse = await post(self.token, '/v1/home/accounts/list', { limit: 1 });
        expect(peopleResponse.status).toBe(200);
        const people = HomeAccountListResultV1Schema.parse(await peopleResponse.json());
        expect(people.items[0]?.accountId).toBe(self.id);
        expect(resolveAccountDisplayLabelV1(people.items[0]!.profile)).toBe('Captain');

        expect((await post(self.token, '/v1/account/profile', { name: 'Other', accountId: other.id })).status).toBe(400);
        expect((await db.account.findUniqueOrThrow({ where: { id: other.id } })).name).toBeNull();
        expect((await db.account.findUniqueOrThrow({ where: { id: self.id } })).name).toBe('Captain');
        const cleared = await post(self.token, '/v1/account/profile', { name: '  ' });
        expect(cleared.status).toBe(200);
        expect(AccountNameUpdateResponseV1Schema.parse(await cleared.json())).toMatchObject({ name: null, firstName: null, lastName: null });
        expect((await db.account.findUniqueOrThrow({ where: { id: self.id } })).name).toBeNull();
        const username = await post(self.token, '/v1/account/username', { username: 'othername' });
        expect(username.status).toBe(400);
        expect(await username.json()).toEqual({ error: 'friends-disabled' });

        // Fail COMMIT, not the profile UPDATE: SQLite's deferred FK admits the
        // callback's writes but prevents their transaction becoming durable.
        // These objects exist only in this harness's disposable database.
        await db.$executeRawUnsafe('CREATE TABLE NameCommitFailure (accountId TEXT REFERENCES Account(id) DEFERRABLE INITIALLY DEFERRED)');
        await db.$executeRawUnsafe("CREATE TRIGGER NameCommitFailureTrigger AFTER UPDATE OF name ON Account WHEN NEW.name = 'Uncommitted name' BEGIN INSERT INTO NameCommitFailure(accountId) VALUES ('missing-account-for-commit-test'); END");
        try {
            const failed = await post(self.token, '/v1/account/profile', { name: 'Uncommitted name' });
            expect(failed.status).toBe(500);
            expect((await db.account.findUniqueOrThrow({ where: { id: self.id } })).name).toBeNull();
            const recovery = await post(self.token, '/v1/account/profile', { name: 'Recovery name' });
            expect(recovery.status).toBe(200);
            // A later committed update is the barrier on the same ordered
            // Socket.IO stream; no sleep or invented observation cutoff.
            await expect.poll(() => publishedName('Recovery name')).toBe(true);
            expect(publishedName('Uncommitted name')).toBe(false);
        } finally {
            await db.$executeRawUnsafe('DROP TRIGGER NameCommitFailureTrigger');
            await db.$executeRawUnsafe('DROP TABLE NameCommitFailure');
        }
    });

    it('fills an empty name from identity presentation and preserves a self-set name', async () => {
        const self = await account();
        const intent = { accountId: self.id, provider: 'mtls', providerUserId: crypto.randomUUID(), providerLogin: null,
            profile: {}, presentation: { name: '  Provider Full Name  ', username: null } };
        await inTx(tx => linkIdentityInTx(tx, intent));
        expect((await db.account.findUniqueOrThrow({ where: { id: self.id } })).name).toBe('Provider Full Name');
        expect((await post(self.token, '/v1/account/profile', { name: 'Captain' })).status).toBe(200);
        await inTx(tx => linkIdentityInTx(tx, intent));
        expect((await db.account.findUniqueOrThrow({ where: { id: self.id } })).name).toBe('Captain');
    });

    it('keeps People role and folded-label order across real HTTP keyset pages', async () => {
        const owner = await account('owner');
        await db.account.update({ where: { id: owner.id }, data: { name: 'Zulu' } });
        const rows = [
            { id: 'people-member-z', homeRole: 'member' as const, name: 'Zulu' },
            { id: 'people-member-b', homeRole: 'member' as const, name: 'aLPHa' },
            { id: 'people-admin-z', homeRole: 'admin' as const, name: 'Zulu' },
            { id: 'people-member-a', homeRole: 'member' as const, name: 'Alpha' },
            { id: 'people-admin-a', homeRole: 'admin' as const, name: 'Alpha' },
            { id: 'people-member-unnamed', homeRole: 'member' as const, name: null },
        ];
        for (const row of rows) await db.account.create({ data: { ...row, publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
            const response = await post(owner.token, '/v1/home/accounts/list', { limit: 2, cursor });
            expect(response.status).toBe(200);
            const page = HomeAccountListResultV1Schema.parse(await response.json());
            ids.push(...page.items.map(row => row.accountId));
            expect(new Set(ids).size).toBe(ids.length);
            cursor = page.nextCursor;
        } while (cursor !== null);
        expect(ids).toEqual([owner.id, 'people-admin-a', 'people-admin-z', 'people-member-a', 'people-member-b', 'people-member-z', 'people-member-unnamed']);
    });

    it('writes Home settings through HTTP and reads the overlay with flavour defaults and S3 applicability declarations', async () => {
        const owner = await account('owner');
        for (const [flavor, backend] of [['light', 'local'], ['full', 's3']] as const) {
            harness.resetEnv({ HAPPIER_SERVER_FLAVOR: flavor, HAPPIER_FILES_BACKEND: '', HAPPY_FILES_BACKEND: '' });
            const response = await post(owner.token, '/v1/home/settings/get', {});
            expect(response.status).toBe(200);
            const read = HomeSettingsProjectionV1Schema.parse(await response.json());
            expect(read.entries.find(row => row.key === 'HAPPIER_FILES_BACKEND')).toMatchObject({
                value: backend, source: 'default', declaration: { default: backend },
            });
            expect(read.entries.find(row => row.key === 'S3_HOST')?.declaration?.appliesWhen).toEqual({ key: 'HAPPIER_FILES_BACKEND', values: ['s3'] });
        }
        harness.resetEnv({ HAPPIER_AUTH_EMAIL_SMTP_HOST: '', HAPPIER_FILES_BACKEND: '', HAPPY_FILES_BACKEND: '' });
        const initial = await post(owner.token, '/v1/home/settings/get', {});
        const initialRead = HomeSettingsProjectionV1Schema.parse(await initial.json());
        const saved = await post(owner.token, '/v1/home/settings/set', {
            expectedRevision: initialRead.revision, values: { HAPPIER_AUTH_EMAIL_SMTP_HOST: 'smtp.home.example', HAPPIER_FILES_BACKEND: 's3' },
        });
        expect(saved.status).toBe(200);
        const written = HomeSettingsProjectionV1Schema.parse(await saved.json());
        expect(written.revision).toBe(initialRead.revision + 1);
        expect(written.entries.find(row => row.key === 'HAPPIER_AUTH_EMAIL_SMTP_HOST')).toMatchObject({ value: 'smtp.home.example', source: 'home', fixed: false });
        expect((await readHomeConfigEnv({})).HAPPIER_AUTH_EMAIL_SMTP_HOST).toBe('smtp.home.example');
        const reread = await post(owner.token, '/v1/home/settings/get', {});
        expect(HomeSettingsProjectionV1Schema.parse(await reread.json())).toEqual(written);
        harness.restoreEnv();
    });
});
