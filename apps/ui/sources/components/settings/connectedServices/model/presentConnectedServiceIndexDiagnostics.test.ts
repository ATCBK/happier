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
    it('keeps an answered available service usable when its plugin reports an unrelated runtime diagnostic', () => {
        const entry: ConnectedServiceRegistryEntry = { serviceId: 'openai-codex',
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
            connectCommand: '', supportsOauth: true, executable: true, projectionStatus: 'ready',
            availability: { state: 'available', reason: 'resolved' }, diagnostics: ['plugin_external_session_source_refused'] };
        const result = presentConnectedServiceIndexDiagnostics({ entry });
        expect(result.primary).toBeNull();
        expect(result.supportDetails).toBe(t('settingsPlugins.diagnosticsSnapshotFooter'));
        const index = buildConnectedServicesIndexModel({
            transport: 'advertised-v4', entries: [entry], qualifiedAccounts: [], qualifiedGroups: [], legacyServices: [],
            defaultAccountByServiceKey: {}, resolveLabel: () => 'ChatGPT', resolveFallbackEntry: () => null,
            loadingLabel: t('common.loading'), presentDiagnostics: candidate => presentConnectedServiceIndexDiagnostics({ entry: candidate }),
        });
        expect(index.connectable.map(service => service.service)).toEqual([entry.service]);
    });
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

    it('speaks one message per service: a conflict is not joined to the read-failure notice the page already shows', () => {
        const entry: ConnectedServiceRegistryEntry = {
            serviceId: 'custom-service', service: { pluginId: 'acme.service', localId: 'custom-service' },
            connectCommand: '', supportsOauth: false, executable: false, projectionStatus: 'stale',
            projectionConflicts: [{ kind: 'identity_divergence', descriptorIdentity: 'owner-id', serviceIds: ['custom-service'] }],
            availability: { state: 'blocked', reason: 'unresolved' }, diagnostics: ['plugin_unavailable'],
        };
        const result = presentConnectedServiceIndexDiagnostics({ entry });
        expect(result.primary).toBe(t('connectedServicesSettings.identityConflict'));
        expect(result.primary).not.toContain(' · ');
        // The disclosure keeps every distinct fact; the headline is only the one that needs the user first.
        expect(result.supportDetails).toContain(presentConnectedServiceRegistryReadFailure(null));
    });

    it('keeps an ordinary saved identity quiet while no machine has supplied a descriptor', () => {
        expect(presentConnectedServiceIndexDiagnostics({ entry: {
            serviceId: 'custom-service', connectCommand: '', supportsOauth: false,
        } })).toEqual({ primary: null, supportDetails: null });
    });
});
