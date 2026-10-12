import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import type { ConnectedServiceRegistryEntry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { buildConnectedServicesIndexModel } from './buildConnectedServicesIndexModel';
import {
    presentConnectedServiceIndexDiagnosticCopy,
    presentConnectedServiceIndexDiagnostics,
    presentConnectedServiceRegistryReadFailure,
} from './presentConnectedServiceIndexDiagnostics';

describe('Connected service index read diagnostics', () => {
    it('keeps unknown boundary diagnostics on the read-failure path without disclosing boundary text', () => {
        expect(presentConnectedServiceIndexDiagnosticCopy('untrusted registry response https://private.example'))
            .toBe(presentConnectedServiceRegistryReadFailure(null));
        expect(presentConnectedServiceIndexDiagnosticCopy('missing_runtime'))
            .toBe(t('connectedServicesSettings.runtimeNotLoaded'));
    });

    it('keeps a conflicting service visible during a partial read even when no executable descriptor was admitted', () => {
        const entry: ConnectedServiceRegistryEntry = {
            serviceId: 'custom-service', service: { pluginId: 'acme.service', localId: 'custom-service' },
            connectCommand: '', supportsOauth: false, executable: false, projectionStatus: 'stale',
            projectionConflicts: [{ kind: 'identity_divergence', descriptorIdentity: 'private-owner-id', serviceIds: ['custom-service'] }],
        };
        const result = presentConnectedServiceIndexDiagnostics({ entry });
        expect(result.primary).toBe(t('connectedServicesSettings.identityConflict'));
        expect(result.supportDetails).toBe(t('connectedServicesSettings.identityConflict'));
        expect(JSON.stringify(result)).not.toContain('private-owner-id');
        const index = buildConnectedServicesIndexModel({
            transport: 'advertised-v4', entries: [entry], qualifiedAccounts: [], qualifiedGroups: [],
            legacyServices: [], defaultAccountByServiceKey: {}, resolveLabel: () => 'Custom service',
            resolveFallbackEntry: () => null, loadingLabel: t('common.loading'),
            presentDiagnostics: candidate => presentConnectedServiceIndexDiagnostics({ entry: candidate }),
        });
        expect(index.sheets).toHaveLength(1);
        expect(index.sheets[0]).toMatchObject({ statusLine: result.primary, supportDetails: result.supportDetails, canAdd: false });
    });

    it('keeps an ordinary saved identity quiet while no machine has supplied a descriptor', () => {
        expect(presentConnectedServiceIndexDiagnostics({ entry: {
            serviceId: 'custom-service', connectCommand: '', supportsOauth: false,
        } })).toEqual({ primary: null, supportDetails: null });
    });
});
