import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const github = vi.hoisted(() => ({ appRequest: vi.fn(), installationRequest: vi.fn() }));
// Octokit is the genuine GitHub network boundary; lifecycle and policy owners remain real.
vi.mock('octokit', () => {
    function App() { return { octokit: { request: github.appRequest } }; }
    function Octokit() { return { request: github.installationRequest }; }
    return { App, Octokit: Object.assign(Octokit, { defaults: () => Octokit }) };
});

import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { resolveManagedIdentityNetworkPolicyInTx } from './managed/managedIdentityNetworkPolicy';
import { unlinkIdentityInTx } from './accountIdentityLifecycle';
import { createHomeGitHubAppRegistration, updateGitHubAppRegistration,
    verifyGitHubAppInstallationWithAdministratorProfile } from '@/app/integrations/github/githubManagedAppLifecycle';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('linked identity App availability comparison', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL harness');
        }
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED', '0');
        vi.stubEnv('HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED', '1');
        vi.stubEnv('GITHUB_CLIENT_ID', 'unlink-app-contract');
        vi.stubEnv('GITHUB_CLIENT_SECRET', 'unlink-app-contract');
        vi.stubEnv('GITHUB_REDIRECT_URL', 'https://home.example.test/v1/oauth/github/callback');
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', 'https://home.example.test');
        vi.stubEnv('HANDY_MASTER_SECRET', 'serialaudit-unlink-canonical-app-contract');
        initDbPostgres();
        await db.$connect();
        await initEncrypt();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    it('does not combine mutually exclusive App witnesses into a safe unlink', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain', homeRole: 'owner' } });
        const registrations: string[] = [], installations: string[] = [], providers: string[] = [], teams: string[] = [];
        try {
            for (let index = 0; index < 2; index++) {
                const created = await createHomeGitHubAppRegistration({ actorAccountId: actor.id, input: {
                    githubHost: 'https://github.com', githubAppId: BigInt('1' + Date.now() + index), githubClientId: randomUUID(),
                    secrets: { v: 1, clientSecret: 'contract-secret', privateKey: 'contract-private-key' },
                } });
                if (created.status !== 'created') throw new Error('App fixture unavailable: ' + created.status);
                const registration = await db.gitHubAppRegistration.update({ where: { id: created.registration.id },
                    data: { state: index === 0 ? 'verified' : 'draft', lastVerifiedAt: new Date() } });
                registrations.push(registration.id);
                const installation = await db.gitHubAppInstallation.create({ data: { registrationId: registration.id,
                    githubInstallationId: BigInt('2' + Date.now() + index), githubOrganizationId: BigInt('3' + Date.now() + index),
                    githubOrganizationLogin: 'contract-' + index, repositorySelection: 'all', state: 'verified',
                    verifiedPermissions: { members: 'read' }, lastVerifiedAt: new Date() } });
                installations.push(installation.id);
                const provider = await db.identityProviderInstance.create({ data: { kind: 'github_app_identity', displayName: 'Contract ' + index,
                    enabled: true, firstEnabledAt: new Date(), config: { v: 1, kind: 'github_app_identity' }, githubAppInstallationId: installation.id } });
                providers.push(provider.id);
                const team = await db.team.create({ data: { name: 'Unlink App contract ' + index, authenticationPolicy: {
                    v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'github' }, { kind: 'home_method', methodId: provider.id }],
                } } });
                teams.push(team.id);
                await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: 'member' } });
            }
            vi.stubEnv('HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS', ['github', ...providers].join(','));
            await db.accountIdentity.createMany({ data: ['github', ...providers].map(provider => ({ accountId: account.id,
                provider, providerUserId: randomUUID(), profile: {}, eligibilityStatus: 'eligible' })) });
            github.appRequest.mockImplementation(async (route: string, input: { installation_id?: number }) => {
                if (route.startsWith('POST ')) return { data: { token: 'installation-token' } };
                const installation = await db.gitHubAppInstallation.findFirstOrThrow({
                    where: { githubInstallationId: BigInt(input.installation_id!) }, include: { registration: true },
                });
                return { data: { id: Number(installation.githubInstallationId), app_id: Number(installation.registration.githubAppId),
                    account: { id: Number(installation.githubOrganizationId), login: installation.githubOrganizationLogin, type: 'Organization' },
                    repository_selection: 'all', permissions: { members: 'read' }, events: [], suspended_at: null } };
            });
            github.installationRequest.mockResolvedValue({ data: { state: 'active', role: 'admin', user: { id: 900 } } });
            const network = await inTx(tx => resolveManagedIdentityNetworkPolicyInTx(tx, { env: process.env, timeoutSeconds: 30 }));
            let schedule: Promise<void> = Promise.resolve();
            const mutate = inTx(async tx => {
                const scheduled = new Proxy(tx, { get(inner, property, receiver) {
                    if (property !== 'gitHubAppInstallation') return Reflect.get(inner, property, receiver);
                    return new Proxy(inner.gitHubAppInstallation, { get(model, method, modelReceiver) {
                        if (method !== 'findMany') return Reflect.get(model, method, modelReceiver);
                        return (query: Parameters<Tx['gitHubAppInstallation']['findMany']>[0]) => {
                            const requested = (query?.where?.id as { in?: string[] } | undefined)?.in ?? [];
                            const index = installations.indexOf(requested[0] ?? '');
                            if (index < 0) return model.findMany(query);
                            const reading = schedule.then(async () => {
                                // Disable first: there is never a point when both Teams have an alternative.
                                for (let candidate = 0; candidate < registrations.length; candidate++) {
                                    const current = await db.gitHubAppRegistration.findUniqueOrThrow({ where: { id: registrations[candidate] } });
                                    if (candidate !== index && current.state === 'verified') {
                                        expect(await updateGitHubAppRegistration({ actorAccountId: actor.id, owner: { kind: 'home' },
                                            registrationId: current.id, expectedRevision: current.revision, patch: { githubClientId: randomUUID() },
                                        })).toMatchObject({ status: 'updated' });
                                        expect(await db.gitHubAppRegistration.count({ where: { id: { in: registrations }, state: 'verified' } })).toBeLessThanOrEqual(1);
                                    }
                                }
                                const current = await db.gitHubAppRegistration.findUniqueOrThrow({ where: { id: registrations[index] } });
                                if (current.state !== 'verified') {
                                    const installation = await db.gitHubAppInstallation.findUniqueOrThrow({ where: { id: installations[index] } });
                                    const verified = await verifyGitHubAppInstallationWithAdministratorProfile({ actorAccountId: actor.id, owner: { kind: 'home' },
                                        registrationId: current.id, expectedRegistrationRevision: current.revision,
                                        expectedRegistrationSecurityRevision: current.securityRevision, expectedInstallationRevision: installation.revision,
                                        expectedNetworkPolicyFingerprint: network.fingerprint,
                                        githubInstallationId: installation.githubInstallationId, githubOrganizationId: installation.githubOrganizationId,
                                        administrator: { githubUserId: 900n, githubUserLogin: 'contract-admin' },
                                    });
                                    if (verified.status !== 'verified') throw new Error('App verification unavailable: ' + verified.status);
                                }
                                expect(await db.gitHubAppRegistration.count({ where: { id: { in: registrations }, state: 'verified' } })).toBe(1);
                                return model.findMany(query);
                            });
                            schedule = reading.then(() => undefined, () => undefined);
                            return reading;
                        };
                    } });
                } });
                await unlinkIdentityInTx(scheduled, { accountId: account.id, provider: 'github' });
            });
            await expect(mutate).rejects.toMatchObject({ reason: 'required_by_team' });
            expect(await db.accountIdentity.count({ where: { accountId: account.id, provider: 'github' } })).toBe(1);
        } finally {
            await db.team.deleteMany({ where: { id: { in: teams } } });
            await db.account.delete({ where: { id: account.id } });
            await db.identityProviderInstance.deleteMany({ where: { id: { in: providers } } });
            await db.gitHubAppInstallation.deleteMany({ where: { id: { in: installations } } });
            await db.gitHubAppRegistration.deleteMany({ where: { id: { in: registrations } } });
            await db.homeAdministrationEvent.deleteMany({ where: { actorAccountId: actor.id } });
            await db.account.delete({ where: { id: actor.id } });
        }
    });
});
