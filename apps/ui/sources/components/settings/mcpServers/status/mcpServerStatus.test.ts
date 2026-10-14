import { describe, expect, it, vi } from 'vitest';
import { McpServerCatalogEntryV1Schema, type McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { materializeSavedSecretResources } from '@/sync/engine/settings/materializeSavedSecretResources';
import { SavedSecretSchema } from '@/sync/domains/settings/savedSecretTypes';
import { applySavedSecretCatalogPage, invalidateSavedSecretCatalog, resetSavedSecretCatalogSnapshotsForTests, resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

import { pickMostBlockingCapabilityStatus, presentCapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';

import { mcpServerMachineStatuses, mcpServerStatus, type McpServerStatusInput } from './mcpServerStatus';

const remote: McpServerCatalogEntryV1 = McpServerCatalogEntryV1Schema.parse({
    id: 'sentry', name: 'sentry', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
    remote: { url: 'https://mcp.sentry.dev/mcp', headers: {}, auth: { kind: 'oauth' } },
});
const local: McpServerCatalogEntryV1 = McpServerCatalogEntryV1Schema.parse({
    id: 'postgres', name: 'postgres', transport: 'stdio', createdAt: 1, updatedAt: 1,
    stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
    env: { DATABASE_URL: { t: 'template', template: 'postgres://app:{password}@db/app', vars: { password: { t: 'savedSecret', secretId: 'pg-pass' } } } },
});
const personalSecret = SavedSecretSchema.parse({ id: 'pg-pass', name: 'Postgres', kind: 'password',
    encryptedValue: { _isSecretValue: true, value: 'test-value' }, createdAt: 1, updatedAt: 1 });
const NO_SECRETS = { resolveReference: (ref: string) => resolveSavedSecretReference(null, [], ref) };

function input(overrides: Partial<McpServerStatusInput>): McpServerStatusInput {
    return {
        entry: local,
        signIn: null,
        tests: {},
        machines: [{ machineId: 'mbp', name: 'MacBook Pro', online: true }],
        savedSecretCatalog: { resolveReference: ref => resolveSavedSecretReference(null, [personalSecret], ref) },
        fixes: { signIn: vi.fn(), reconnect: vi.fn(), grantAccess: vi.fn(), addKey: vi.fn(), howToFix: vi.fn(), tryAgain: vi.fn() },
        ...overrides,
    };
}

const headline = (statuses: ReturnType<typeof mcpServerStatus>) => {
    const top = pickMostBlockingCapabilityStatus(statuses, 'row');
    return top ? presentCapabilityStatus(top, 'row').pill?.label ?? null : null;
};

describe('mcpServerStatus', () => {
    it('uses Saved Secret catalog references and availability for direct and template bindings', async () => {
        const ref = formatSharedSavedSecretRefV1('bound-key');
        const entry = McpServerCatalogEntryV1Schema.parse({ ...local,
            env: { TOKEN: { t: 'savedSecret', secretId: ref } },
            transport: 'http', stdio: undefined,
            remote: { url: 'https://mcp.example.test', headers: { Authorization: {
                t: 'template', template: 'Bearer {key}', vars: { key: { t: 'savedSecret', secretId: ref } },
            } } },
        });
        const secret = SavedSecretCatalogEntryV1Schema.parse({ ref, source: 'shared_resource', relationship: 'owner',
            name: 'Existing key', kind: 'apiKey', revision: 1, materialStatus: 'ready',
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } });
        const scope = { serverId: 'mcp-status', accountId: 'owner' };
        const produced = await materializeSavedSecretResources({ resources: [{ resourceId: 'bound-key',
            encryptionMode: 'plain', entry: secret, recipientEnvelope: null,
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'bound-key', mode: 'plain',
                content: { v: 1, name: 'Existing key', kind: 'apiKey', value: 'test-value' } }),
        }], decryptDataKeyEnvelope: async () => null });
        const available = {
            resolveReference: (reference: string) => resolveSavedSecretReference(scope, [], reference) };
        try {
            applySavedSecretCatalogPage({ scope, ...produced, observedAt: 1 });
            expect(headline(mcpServerStatus(input({ entry, savedSecretCatalog: available })))).toBeNull();
            // Metadata alone is not proof of usable material (e.g. a just-acknowledged resource).
            applySavedSecretCatalogPage({ scope, ...produced, materializedSecrets: [], observedAt: 2 });
            expect(headline(mcpServerStatus(input({ entry, savedSecretCatalog: available })))).toBe('Needs a key');
            for (const entries of [[], [{ ...secret, materialStatus: 'temporarily_unavailable' as const }],
                [{ ...secret, capabilities: { ...secret.capabilities, use: false } }]]) {
                applySavedSecretCatalogPage({ scope, ...produced, entries, observedAt: 3 });
                expect(headline(mcpServerStatus(input({ entry, savedSecretCatalog: available })))).toBe('Needs a key');
            }
            applySavedSecretCatalogPage({ scope, ...produced, observedAt: 4 });
            invalidateSavedSecretCatalog(scope);
            expect(headline(mcpServerStatus(input({ entry, savedSecretCatalog: available })))).toBe('Needs a key');
        } finally { resetSavedSecretCatalogSnapshotsForTests(); }
    });

    it('is quiet for a healthy server', () => {
        const statuses = mcpServerStatus(input({ tests: { mbp: { ok: true, toolCount: 41, checkedAt: 1 } } }));
        expect(headline(statuses)).toBeNull();
    });

    it('says each degraded state with its one fix', () => {
        expect(headline(mcpServerStatus(input({ entry: remote, signIn: { state: 'not_connected' } })))).toBe('Needs sign-in');
        expect(headline(mcpServerStatus(input({ entry: remote, signIn: { state: 'needs_more_access' } })))).toBe('Needs more access');
        const expired = mcpServerStatus(input({ entry: remote, signIn: { state: 'expired', reason: 'expired', at: 'Oct 10' } }));
        expect(pickMostBlockingCapabilityStatus(expired)).toMatchObject({ kind: 'expired', detail: 'Oct 10', fix: { kind: 'reconnect' } });
        expect(headline(mcpServerStatus(input({ savedSecretCatalog: NO_SECRETS })))).toBe('Needs a key');
        expect(headline(mcpServerStatus(input({ tests: { mbp: { ok: false, errorCode: 'spawn_failed', runtimeMissing: 'uv', checkedAt: 1 } } }))))
            .toBe('Can’t run on MacBook Pro');
        expect(headline(mcpServerStatus(input({ tests: { mbp: { ok: false, errorCode: 'exited', checkedAt: 1 } } })))).toBe('Stopped on MacBook Pro');
        expect(headline(mcpServerStatus(input({ machines: [{ machineId: 'win', name: 'Windows desktop', online: false, lastSeen: 'Oct 9' }] }))))
            .toBe('Offline');
    });

    it('lets the more blocking problem lead when there are two', () => {
        const statuses = mcpServerStatus(input({
            savedSecretCatalog: NO_SECRETS,
            machines: [
                { machineId: 'mbp', name: 'MacBook Pro', online: true },
                { machineId: 'win', name: 'Windows desktop', online: false },
            ],
            tests: { mbp: { ok: false, errorCode: 'exited', checkedAt: 1 } },
        }));
        expect(pickMostBlockingCapabilityStatus(statuses)?.kind).toBe('error');
        const keyOverOffline = mcpServerStatus(input({ savedSecretCatalog: NO_SECRETS, machines: [{ machineId: 'win', name: 'Windows desktop', online: false }] }));
        expect(pickMostBlockingCapabilityStatus(keyOverOffline)?.kind).toBe('key');
    });

    it('keys machine statuses by machine id, so two machines with one name stay apart', () => {
        const byMachine = mcpServerMachineStatuses(input({
            machines: [{ machineId: 'a', name: 'nl2', online: true }, { machineId: 'b', name: 'nl2', online: true }],
            tests: { b: { ok: false, errorCode: 'exited', checkedAt: 1 } },
        }));
        expect(byMachine.has('a')).toBe(false);
        expect(byMachine.get('b')?.kind).toBe('error');
    });
});
