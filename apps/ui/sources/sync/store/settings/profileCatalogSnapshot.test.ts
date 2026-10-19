import { describe, expect, it } from 'vitest';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import * as owner from './profileCatalogSnapshot';

describe('scoped Profile publication', () => {
    it('keeps a cold checked answer display-only and never replaces retained acknowledgements with a stale read', () => {
        const scope = { serverId: 'cold-display', accountId: 'account' };
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'p', definition: { kind: 'artifact', artifactId: 'a' }, enabled: true,
            promptStack: [], secretBindings: {} });
        const ready = { status: 'ready' as const, authority: 'inactive' as const, source: 'destination' as const,
            control: null, controlRevision: 'absent' as const, records: [{ record, revision: 2 }], diagnostics: [], referenceGuardRevision: 1 };
        owner.beginProfileCatalogLoad(scope);
        owner.applyProfileCatalogSnapshot(scope, ready, true, new Map(), {}, false);
        expect(owner.getProfileCatalogSnapshot(scope)).toMatchObject({ stale: true, dataComplete: true,
            catalog: { status: 'loading' }, data: [{ revision: 2 }] });
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record: { ...record, enabled: false }, revision: 3 }, true);
        const acknowledged = owner.getProfileCatalogSnapshot(scope);
        owner.applyProfileCatalogSnapshot(scope, ready, true, new Map(), {}, false);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(acknowledged);
        owner.applyProfileCatalogSnapshot(scope, ready, false, new Map(), {}, false);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(acknowledged);
    });
    it('publishes a higher acknowledged row after transient revalidation failure without certifying the inventory', () => {
        const scope = { serverId: 'failed-revalidation-ack', accountId: 'account' };
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'p', definition: { kind: 'artifact', artifactId: 'a' }, enabled: true, promptStack: [], secretBindings: {} });
        owner.applyProfileCatalogSnapshot(scope, { status: 'ready', authority: 'inactive', source: 'destination',
            control: null, controlRevision: 'absent', records: [{ record, revision: 10 }], diagnostics: [], referenceGuardRevision: 1 }, true);
        owner.applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record: { ...record, enabled: false }, revision: 11 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toMatchObject({ source: 'destination', stale: true,
            catalog: { status: 'loading' }, data: [{ revision: 11, record: { enabled: false } }] });
    });
    it('retains row evidence from a partial inventory after empty refresh and failed revalidation', () => {
        const scope = { serverId: 'inventory-evidence', accountId: 'account' };
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'p', definition: { kind: 'artifact', artifactId: 'a' }, enabled: true, promptStack: [], secretBindings: {} });
        const catalog = { status: 'partial' as const, authority: 'inactive' as const, source: 'destination' as const,
            control: null, controlRevision: 'absent' as const, records: [{ record, revision: 10 }], diagnostics: [], referenceGuardRevision: 1 };
        owner.applyProfileCatalogSnapshot(scope, catalog, true);
        owner.applyProfileCatalogSnapshot(scope, { ...catalog, status: 'ready', records: [] }, true);
        owner.applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true);
        const empty = owner.getProfileCatalogSnapshot(scope);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 6 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(empty);
        owner.beginProfileCatalogLoad(scope);
        owner.applyProfileCatalogSnapshot(scope, { ...catalog, status: 'ready', records: [] }, true);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 10 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toEqual([]);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 11 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toMatchObject([{ revision: 11 }]);
    });
    it('retains an acknowledged Artifact body without publishing older or retired evidence', () => {
        const scope = { serverId: 'artifact-ack-home', accountId: 'account' };
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'p', definition: { kind: 'artifact', artifactId: 'a' }, enabled: true, promptStack: [], secretBindings: {} });
        const ready = { status: 'ready' as const, authority: 'inactive' as const, source: 'destination' as const, control: null, controlRevision: 'absent' as const,
            records: [{ record, revision: 1 }], diagnostics: [], referenceGuardRevision: 1 };
        const old = { artifactId: 'a', header: { kind: 'launch-profile.v1' }, body: 'old', revision: { headerVersion: 1, bodyVersion: 1 } };
        owner.applyProfileCatalogSnapshot(scope, ready, true, new Map([['a', old]]));
        const updated = { ...old, body: 'acknowledged', revision: { headerVersion: 2, bodyVersion: 2 } };
        owner.applyAcknowledgedProfileArtifact(scope, updated, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toMatchObject({ stale: true, catalog: { status: 'loading' } });
        expect(owner.getProfileCatalogSnapshot(scope)?.artifactsById.get('a')).toBe(updated);
        const acknowledged = owner.getProfileCatalogSnapshot(scope);
        owner.applyAcknowledgedProfileArtifact(scope, old, true);
        owner.applyAcknowledgedProfileArtifact(scope, { ...updated, body: 'retired', revision: { headerVersion: 3, bodyVersion: 3 } }, false);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(acknowledged);
    });
    it('publishes durable row evidence without reviving census authority or a retired Account', () => {
        const scope = { serverId: 'ack-home', accountId: 'account' };
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'p', definition: { kind: 'artifact', artifactId: 'a' }, enabled: true, promptStack: [], secretBindings: {} });
        const ready = { status: 'ready' as const, authority: 'inactive' as const, source: 'destination' as const, control: null, controlRevision: 'absent' as const,
            records: [{ record, revision: 1 }], diagnostics: [], referenceGuardRevision: 1 };
        owner.applyProfileCatalogSnapshot(scope, ready, true);
        const original = owner.getProfileCatalogSnapshot(scope);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record: { ...record, enabled: false }, revision: 2 }, false);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(original);
        owner.beginProfileCatalogLoad(scope);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record: { ...record, enabled: false }, revision: 3 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toMatchObject({ stale: true, catalog: { status: 'loading' },
            data: [{ revision: 3, record: { enabled: false } }] });
        const acknowledged = owner.getProfileCatalogSnapshot(scope);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 2 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(acknowledged);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record: null, revision: 4 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toEqual([]);
        const deleted = owner.getProfileCatalogSnapshot(scope);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 3 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toEqual([]);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record: null, revision: 4 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(deleted);
        owner.beginProfileCatalogLoad(scope);
        owner.applyProfileCatalogSnapshot(scope, { ...ready, records: [] }, true);
        const refreshedDeletion = owner.getProfileCatalogSnapshot(scope);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 3 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(refreshedDeletion);
        const otherScope = { ...scope, accountId: 'another-account' };
        owner.applyProfileCatalogSnapshot(otherScope, { ...ready, records: [] }, true);
        owner.applyAcknowledgedProfileRecord(otherScope, { id: 'p', record, revision: 2 }, true);
        expect(owner.getProfileCatalogSnapshot(otherScope)?.data).toMatchObject([{ revision: 2 }]);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 5 }, false);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(refreshedDeletion);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 5 }, true);
        const recreated = owner.getProfileCatalogSnapshot(scope);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record: null, revision: 4 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(recreated);
        owner.applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        const refused = owner.getProfileCatalogSnapshot(scope);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 5 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(refused);
        owner.applyProfileCatalogSnapshot(scope, { ...ready, records: [] }, true);
        owner.applyAcknowledgedProfileRecord(scope, { id: 'p', record, revision: 2 }, true);
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toMatchObject([{ revision: 2 }]);
    });
    it('withdraws runtime authority on refresh, retains display rows and rejects retired results', () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const record = ProfileRecordV1Schema.parse({ v: 1, id: 'p', definition: { kind: 'artifact', artifactId: 'a' }, enabled: true, promptStack: [], secretBindings: {} });
        const ready = { status: 'ready' as const, authority: 'inactive' as const, source: 'destination' as const, control: null, controlRevision: 'absent' as const,
            records: [{ record, revision: 1 }], diagnostics: [], referenceGuardRevision: 1 };
        const projection = { cleanup: { status: 'cleanup-pending' as const, reason: 'source-conflict' as const } };
        const artifacts = new Map([['a', { artifactId: 'a', header: { kind: 'launch-profile.v1' }, body: '{}' }]]);
        owner.applyProfileCatalogSnapshot(scope, ready, true, artifacts, projection);
        const initial = owner.getProfileCatalogSnapshot(scope)!;
        expect(initial).toMatchObject({ source: 'destination' });
        owner.beginProfileCatalogLoad(scope);
        expect(owner.getProfileCatalogSnapshot(scope)?.catalog.status).toBe('loading');
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toBe(initial.data);
        expect(owner.getProfileCatalogSnapshot(scope)?.dataComplete).toBe(true);
        expect(owner.getProfileCatalogSnapshot(scope)).toMatchObject({ source: 'destination' });
        expect(owner.getProfileCatalogSnapshot(scope)?.cleanup).toBe(initial.cleanup);
        owner.applyProfileCatalogSnapshot(scope, ready, false);
        expect(owner.getProfileCatalogSnapshot(scope)?.catalog.status).toBe('loading');
        owner.applyProfileCatalogSnapshot(scope, ready, true, artifacts, projection);
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toBe(initial.data);
        const restored = owner.getProfileCatalogSnapshot(scope);
        owner.applyProfileCatalogSnapshot({ serverId: 'other', accountId: 'account' }, ready, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toBe(restored);
        owner.applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true);
        expect(owner.getProfileCatalogSnapshot(scope)?.data).toBe(initial.data);
        expect(owner.getProfileCatalogSnapshot(scope)?.artifactsById).toBe(initial.artifactsById);
        expect(owner.getProfileCatalogSnapshot(scope)?.catalog.status).toBe('unavailable');
        owner.applyProfileCatalogSnapshot(scope, { ...ready, status: 'partial' }, true, artifacts);
        expect(owner.getProfileCatalogSnapshot(scope)?.dataComplete).toBe(false);
        owner.beginProfileCatalogLoad(scope);
        expect(owner.getProfileCatalogSnapshot(scope)?.dataComplete).toBe(false);
        owner.applyProfileCatalogSnapshot(scope, { status: 'unavailable', reason: 'unauthorized' }, true);
        expect(owner.getProfileCatalogSnapshot(scope)).toMatchObject({ data: null, source: null, dataComplete: false });
        expect(owner.getProfileCatalogSnapshot(scope)?.cleanup).toBeUndefined();
    });
});
