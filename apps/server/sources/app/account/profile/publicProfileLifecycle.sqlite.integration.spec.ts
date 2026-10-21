import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, type PublicProfileSnapshotV1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfilePublishBodyV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { db } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAccountPublicProfileRoutes } from '@/app/api/routes/account/registerAccountPublicProfileRoutes';
import { registerPublicProfileReadRoutes } from '@/app/api/routes/account/registerPublicProfileReadRoutes';
import { replaceAccountForProviderResetInTx } from '@/app/home/governance/accountReplacement';
import { setAccountStatusInTx } from '@/app/home/governance/accountLifecycle';
import { changeUsernameInTx } from '@/app/social/usernameUpdate';
import { inTx } from '@/storage/inTx';
import { resolveApiRateLimitPluginOptions } from '@/app/api/utils/apiRateLimitPolicy';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { publishPublicProfile, resumePublicProfile } from './publicProfilePublish';
import { updatePublicProfile } from './publicProfileUpdate';
import { refreshPublicProfile } from './publicProfileRefresh';
import { readPublicProfile } from './publicProfileRead';
import { pausePublicProfile } from './publicProfilePause';
import { unpublishPublicProfile } from './publicProfileUnpublish';
import { publicProfileServerDependencies as deps } from './publicProfileDependencies';

const snapshot: PublicProfileSnapshotV1 = { v: 1, computedAtMs: 2000, period: { startMs: 1000, endMs: 2000, timeZoneOffsetMinutes: 0 },
    coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: { tokens: { status: 'partial', method: 'runtime' } },
    facts: { tokens: 987654321, activeDays: 2, agentMix: [{ agentId: 'codex', share: 1, tokens: 987654321, coverage: { status: 'partial', method: 'runtime' } }] } };
const query = PublicProfilePublishBodyV1Schema.shape.query.parse(normalizeUsageQuery({
    population: 'public_eligible_personal', period: { startMs: 1000, endMs: 2000 }, timeZoneOffsetMinutes: 0,
}));
const body = () => PublicProfilePublishBodyV1Schema.parse({ policy: structuredClone(DEFAULT_PUBLIC_PROFILE_POLICY_V1), metadata: {}, projectSelections: [], query, snapshot,
    layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 });
const publicationEnv = { HAPPIER_PUBLIC_SERVER_URL: 'https://profiles.example/prefix',
    HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test', HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Test Home' };

describe('Account public profile durable lifecycle', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-public-profile-',
        env: { ...publicationEnv, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=happier-source'].filter(Boolean).join(' ') } }); }, 120_000);
    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { harness.restoreEnv(); await db.homeAdministrationEvent.deleteMany(); await db.account.deleteMany(); });

    it.each(['plain', 'e2ee'])('stores explicit disclosure without changing %s Account encryption authority or keys', async encryptionMode => {
        const account = await db.account.create({ data: { publicKey: `public-profile-${encryptionMode}`, username: `owner_${encryptionMode}`, encryptionMode,
            ...(encryptionMode === 'e2ee' ? { contentPublicKey: new Uint8Array([1, 2, 3]), contentPublicKeySig: new Uint8Array([4, 5, 6]) } : {}) } });
        const result = await publishPublicProfile(account.id, body(), publicationEnv, deps);
        expect(result.kind).toBe('updated');
        const row = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        expect(row.state).toBe('published');
        expect(JSON.parse(row.snapshotJson!).facts.tokens).toBe(987654321);
        const after = await db.account.findUniqueOrThrow({ where: { id: account.id } });
        expect(after.encryptionMode).toBe(encryptionMode);
        expect(after.contentPublicKey).toEqual(account.contentPublicKey);
        expect(after.contentPublicKeySig).toEqual(account.contentPublicKeySig);
    });

    it('remasks a stale refresh after hide, keeps layout-only Apply independent of consent, and rejects refresh after pause/unpublish', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-stale', username: 'stale_owner' } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        const hidden = body().policy;
        hidden.fields.tokens = false;
        expect((await updatePublicProfile(account.id, { policy: hidden })).kind).toBe('updated');
        const offlineLayout = { v: 1, items: [{ kind: 'widget', id: 'offline-applied', size: 'medium', frameStyle: 'plain',
            presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Applied while sources are offline' } } } }] } as const;
        expect((await updatePublicProfile(account.id, { layout: PublicProfilePublishBodyV1Schema.shape.layout.parse(offlineLayout) })).kind).toBe('updated');
        expect((await refreshPublicProfile(account.id, { query, snapshot }, publicationEnv, deps)).kind).toBe('updated');
        const row = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        expect(row.snapshotJson).not.toContain('987654321');
        expect(JSON.parse(row.policyJson!).fields.tokens).toBe(false);
        expect(JSON.parse(row.layoutJson!).items[0].id).toBe('offline-applied');
        const read = await readPublicProfile('stale_owner', publicationEnv, deps);
        expect(read.kind).toBe('published');
        expect(JSON.stringify(read)).not.toContain('987654321');
        expect((await pausePublicProfile(account.id)).kind).toBe('updated');
        expect(await refreshPublicProfile(account.id, { query, snapshot }, publicationEnv, deps)).toEqual({ kind: 'unavailable', reason: 'not_published' });
        expect((await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).state).toBe('paused');
        expect((await unpublishPublicProfile(account.id)).kind).toBe('updated');
        expect(await refreshPublicProfile(account.id, { query, snapshot }, publicationEnv, deps)).toEqual({ kind: 'unavailable', reason: 'not_published' });
        expect(await readPublicProfile('stale_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
    });

    it('keeps operator restriction after owner unpublish and refuses ordinary Account restore', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-restricted', username: 'restricted_owner' } });
        const operator = await db.account.create({ data: { publicKey: 'public-profile-operator', homeRole: 'owner' } });
        const selected = body();
        selected.query = PublicProfilePublishBodyV1Schema.shape.query.parse(normalizeUsageQuery({ ...selected.query, machines: ['owner-private-machine-scope'] }));
        await publishPublicProfile(account.id, selected, publicationEnv, deps);
        expect((await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).queryJson).toContain('owner-private-machine-scope');
        await withAuthenticatedTestApp(app => registerAccountPublicProfileRoutes(app), async app => {
            const moderate = (actorAccountId: string, operation: 'restrict' | 'restore', reason: string) => app.inject({
                method: 'POST', url: `/v1/home/public-profiles/${account.id}/${operation}`,
                headers: { 'x-test-user-id': actorAccountId }, payload: { reason },
            });
            const deniedRestriction = await moderate(account.id, 'restrict', 'owner cannot self-moderate');
            expect(deniedRestriction.statusCode).toBe(403);
            expect(deniedRestriction.json()).toEqual({ error: 'home_governance_forbidden' });
            const restricted = await moderate(operator.id, 'restrict', 'reported content');
            expect(restricted.statusCode).toBe(200);
            expect(restricted.json()).toEqual({ kind: 'updated', record: null });
            expect(await readPublicProfile('restricted_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
            await unpublishPublicProfile(account.id);
            const row = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
            expect(row.removalReason).toBe('reported content');
            expect(row.snapshotJson).toBeNull();
            expect(row.policyJson).toBeNull();
            expect(await publishPublicProfile(account.id, body(), publicationEnv, deps)).toEqual({ kind: 'unavailable', reason: 'restricted' });
            const deniedRestore = await moderate(account.id, 'restore', 'self restore');
            expect(deniedRestore.statusCode).toBe(403);
            expect(deniedRestore.json()).toEqual({ error: 'home_governance_forbidden' });
            const restored = await moderate(operator.id, 'restore', 'operator restored');
            expect(restored.statusCode).toBe(200);
            expect(restored.json()).toEqual({ kind: 'updated', record: null });
            expect(await readPublicProfile('restricted_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
            expect((await publishPublicProfile(account.id, body(), publicationEnv, deps)).kind).toBe('updated');
            expect(await db.homeAdministrationEvent.findMany({
                select: { action: true, actorAccountId: true, targetId: true, summary: true }, orderBy: { at: 'asc' },
            })).toEqual([
                { action: 'public_profile.restricted', actorAccountId: operator.id, targetId: account.id, summary: { reason: 'reported content' } },
                { action: 'public_profile.restored', actorAccountId: operator.id, targetId: account.id, summary: { reason: 'operator restored' } },
            ]);
        });
    });

    it('withdraws disclosure on identity clear and transfers only restriction during provider reset', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-reset', username: 'reset_owner', homeRole: 'owner' } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        await db.accountPublicProfile.update({ where: { accountId: account.id }, data: { removedAt: new Date(), removalReason: 'restriction survives recovery', removedByAccountId: account.id } });
        const replacementAccountId = 'public-profile-replacement';
        const replaced = await inTx(tx => replaceAccountForProviderResetInTx(tx, {
            oldAccountId: account.id, replacement: { accountId: replacementAccountId, publicKey: 'public-profile-reset-new-key' }, desiredUsername: 'reset_owner',
            retireReplacedAccountInTx: async tx => {
                const result = await setAccountStatusInTx(tx, { actorAccountId: replacementAccountId, targetAccountId: account.id, status: 'disabled', authority: 'provider_account_replacement' });
                if (result.status === 'rejected') throw new Error(result.code);
            },
        }), { isolationLevel: 'Serializable' });
        expect(replaced.status).toBe('replaced');
        const replacementProfile = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: replacementAccountId } });
        expect(replacementProfile.removalReason).toBe('restriction survives recovery');
        expect(replacementProfile.state).toBe('draft');
        expect(replacementProfile.snapshotJson).toBeNull();
        expect(replacementProfile.policyJson).toBeNull();
        expect((await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).snapshotJson).toBeNull();
        expect(await publishPublicProfile(replacementAccountId, body(), publicationEnv, deps)).toEqual({ kind: 'unavailable', reason: 'restricted' });

        const automatic = await db.account.create({ data: { publicKey: 'public-profile-identity-clear', username: 'auto_owner' } });
        await publishPublicProfile(automatic.id, body(), publicationEnv, deps);
        await inTx(tx => changeUsernameInTx(tx, automatic.id, { kind: 'identity_unlink', matchingUsername: 'auto_owner' }), { isolationLevel: 'Serializable' });
        expect(await db.accountPublicProfile.findUnique({ where: { accountId: automatic.id } })).toBeNull();
        expect(await readPublicProfile('auto_owner', publicationEnv, deps)).toEqual({ kind: 'unavailable' });
    });


    it('keeps owner recovery and revocation reachable through the production API when publication is disabled', async () => {
        harness.resetEnv({ ...publicationEnv, HAPPIER_FEATURE_ACCOUNT_PUBLIC_PROFILES__ENABLED: '0' });
        const { registerApiRoutes } = await import('@/app/api/api');
        const account = await db.account.create({ data: { publicKey: 'public-profile-api-composition', username: 'root_owner' } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        await withAuthenticatedTestApp(app => {
            app.register(import('@fastify/rate-limit'), resolveApiRateLimitPluginOptions(process.env));
            registerApiRoutes(app, { homeConnectionDescriptorContinuityStore: null });
        }, async app => {
            const headers = { 'x-test-user-id': account.id };
            const unavailable = await app.inject({ method: 'GET', url: '/v1/public/profiles/root_owner', headers: { 'if-none-match': '*' } });
            expect(unavailable.statusCode).toBe(404);
            expect(unavailable.json()).toEqual({ kind: 'unavailable' });
            expect(unavailable.headers.etag).toBeUndefined();
            const owned = await app.inject({ method: 'GET', url: '/v1/account/public-profile', headers });
            expect(owned.statusCode).toBe(200);
            expect(owned.json()).toMatchObject({ kind: 'ready', record: { state: 'published' } });
            const publish = await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish', headers, payload: body() });
            expect(publish.json()).toEqual({ kind: 'unavailable', reason: 'feature_disabled' });
            const paused = await app.inject({ method: 'POST', url: '/v1/account/public-profile/pause', headers, payload: {} });
            expect(paused.statusCode).toBe(200);
            expect(paused.json()).toMatchObject({ kind: 'updated', record: { state: 'paused' } });
            const removed = await app.inject({ method: 'DELETE', url: '/v1/account/public-profile', headers });
            expect(removed.json()).toEqual({ kind: 'updated', record: null });
        });
    });

    it('returns only the normalized configured report contact without disclosing profile existence', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-report-contact' } });
        harness.resetEnv({ HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'mailto:operator@example.test' });
        await withAuthenticatedTestApp(app => registerAccountPublicProfileRoutes(app), async app => {
            const result = await app.inject({ method: 'GET', url: '/v1/account/public-profile/report?handle=missing_owner', headers: { 'x-test-user-id': account.id } });
            expect(result.statusCode).toBe(200);
            expect(result.json().kind).toBe('ready');
            const contact = new URL(result.json().url);
            expect(contact.protocol).toBe('mailto:');
            expect(contact.pathname).toBe('operator@example.test');
            expect(contact.searchParams.get('body')).toContain('https://profiles.example/prefix/@missing_owner');
            harness.resetEnv({ HAPPIER_PUBLIC_PROFILE_REPORT_URL: 'http://unsafe.example.test' });
            const invalid = await app.inject({ method: 'GET', url: '/v1/account/public-profile/report?handle=missing_owner', headers: { 'x-test-user-id': account.id } });
            expect(invalid.json()).toEqual({ kind: 'unavailable', reason: 'report_contact_unconfigured' });
        });
    });

    it('rejects unknown symbolic field paths at the real HTTP boundary before accepting a disclosure', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-invalid-binding', username: 'binding_owner' } });
        await withAuthenticatedTestApp(app => registerAccountPublicProfileRoutes(app), async app => {
            const invalid = { ...body(), layout: { v: 1, items: [{ kind: 'widget', id: 'invalid', size: 'medium', frameStyle: 'plain',
                presentation: { kind: 'declarative', document: { version: 1, root: { kind: 'metric', label: 'Private cost',
                    data: { kind: 'value', value: { kind: 'public_profile' } }, value: { path: ['snapshot', 'facts', 'cost'], type: 'number' } } } } }] } };
            const result = await app.inject({ method: 'POST', url: '/v1/account/public-profile/publish', headers: { 'x-test-user-id': account.id }, payload: invalid });
            expect(result.statusCode).toBe(400);
            expect(await db.accountPublicProfile.findUnique({ where: { accountId: account.id } })).toBeNull();
        });
    });

    it('requires configured delivery when resuming and retains the previously applied consent and layout', async () => {
        const account = await db.account.create({ data: { publicKey: 'public-profile-resume', username: 'resume_owner' } });
        await publishPublicProfile(account.id, body(), publicationEnv, deps);
        await pausePublicProfile(account.id);
        expect(await resumePublicProfile(account.id, { query, snapshot }, {}, deps)).toEqual({ kind: 'unavailable', reason: 'public_ingress_unconfigured' });
        expect((await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } })).state).toBe('paused');
        expect((await resumePublicProfile(account.id, { query, snapshot }, publicationEnv, deps)).kind).toBe('updated');
        const resumed = await db.accountPublicProfile.findUniqueOrThrow({ where: { accountId: account.id } });
        expect(JSON.parse(resumed.policyJson!)).toEqual(body().policy);
        expect(JSON.parse(resumed.layoutJson!)).toEqual(body().layout);
        expect(JSON.parse(resumed.appearanceJson!)).toEqual(body().appearance);
    });
});
