import { describe, expect, it } from 'vitest';
import { DaemonProviderConnectionViewV1Schema } from '@happier-dev/protocol/rpc';

import { presentProviderConnection } from './presentation';
import { providerModelConnectionTitle } from '@/providers/models/providerModelConnectionTitle';

const base = DaemonProviderConnectionViewV1Schema.parse({
    connectionId: 'pc_a', contributionKey: 'acme/a', displayName: 'Acme', providerName: 'Acme', icon: null,
    role: 'default' as const, displayNameMode: 'automatic' as const, sourceStatus: 'available' as const,
    grants: { accountEnabled: true, enabledMachineIds: [] }, scope: 'account' as const,
    probeCapability: 'none' as const, manualModelPolicy: 'allowed' as const, compatibility: [],
    credential: null,
    endpoints: [],
    authorized: true, authorizationError: null, revision: 0,
    runtime: { health: 'available' as const, modelCount: 3, checkedAt: 1 },
});

describe('provider connection presentation', () => {
    it('collapses only one automatic default to the provider name', () => {
        expect(presentProviderConnection(base).title).toBe('Acme');
        expect(presentProviderConnection({ ...base, role: 'named', displayName: 'Work' }).subtitle)
            .toContain('Acme');
    });

    it('keeps a custom source identity once while distinguishing separately named connections', () => {
        const custom = { ...base, role: 'named' as const, displayNameMode: 'custom' as const };
        expect(presentProviderConnection(custom)).toMatchObject({ title: 'Acme', subtitle: '' });
        expect(providerModelConnectionTitle({ providerName: 'Acme', connectionName: 'Acme',
            connectionRole: 'named', connectionDisplayNameMode: 'custom' })).toBe('Acme');
        expect(providerModelConnectionTitle({ providerName: 'Acme', connectionName: 'Work',
            connectionRole: 'named', connectionDisplayNameMode: 'custom' })).toBe('Acme · Work');
        expect(presentProviderConnection({ ...custom, displayName: 'Work' })).toMatchObject({ title: 'Work', subtitle: 'Acme' });
    });

    it('keeps source availability and endpoint health distinct', () => {
        expect(presentProviderConnection({ ...base, sourceStatus: 'unavailable' }).status).toBe('sourceUnavailable');
        expect(presentProviderConnection({
            ...base, authorized: false,
            authorizationError: { v: 1, code: 'provider_endpoint_unreachable', retryable: true, action: 'retry' },
        }).status).toBe('unreachable');
        expect(presentProviderConnection({
            ...base, runtime: { ...base.runtime, health: 'partial' },
        }).status).toBe('partial');
    });
});
