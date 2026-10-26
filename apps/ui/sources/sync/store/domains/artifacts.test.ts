import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { ApprovalRequestV1Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { isOpenApprovalInboxArtifact } from '@/sync/domains/artifacts/approvalArtifacts';
import { createArtifactsDomain, type ArtifactsDomain } from './artifacts';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { decryptArtifactListItem, decryptArtifactWithBody, decryptSocketNewArtifactUpdate } from '@/sync/engine/artifacts/syncArtifacts';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { doesArtifactInventorySelectionCover, isArtifactInventoryLoaded, isArtifactInventoryReady } from '@/sync/domains/artifacts/artifactInventory';

function createHarness() {
    return createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
}

function artifact(id: number): Extract<DecryptedArtifact, { isDecrypted: true }> {
    return {
        id: `artifact-${id}`, title: `Artifact ${id}`, updatedAt: id, createdAt: id,
        headerVersion: 1, seq: id, isDecrypted: true, draft: false,
    };
}

describe('createArtifactsDomain', () => {
    it('keeps settled receipts during open-only reconciliation and never certifies full approval membership', () => {
        const store = createHarness();
        const approval = (id: number, status: string) => ({ ...artifact(id),
            rawHeader: { kind: 'approval_request.v1', approvalStatus: status, sessionId: 's1' } });
        const settled = approval(1, 'executed'), missingOpen = approval(2, 'open'), currentOpen = approval(3, 'open');
        store.getState().applyArtifacts([settled, missingOpen]);
        store.getState().applyArtifacts([currentOpen], store.getState().artifacts, 'inboxOpen');
        const state = store.getState();
        expect(state.artifacts[settled.id]).toBe(settled);
        expect(state.artifacts[missingOpen.id]).toBeUndefined();
        expect(state.artifacts[currentOpen.id]).toBe(currentOpen);
        expect(isArtifactInventoryLoaded(state, 'inboxOpen')).toBe(true);
        expect(isArtifactInventoryLoaded(state, ['approval_request.v1'])).toBe(false);
        expect(isArtifactInventoryLoaded(state)).toBe(false);
        expect(doesArtifactInventorySelectionCover('inboxOpen', ['approval_request.v1'])).toBe(false);
        expect(doesArtifactInventorySelectionCover({ approvalSessionIds: ['s1'] }, 'inboxOpen')).toBe(false);
        store.getState().applyArtifacts([settled], state.artifacts, { approvalSessionIds: ['s1'] });
        expect(store.getState().artifacts[settled.id]).toBe(settled);
        expect(store.getState().artifactInventoryKindsLoaded).toEqual([]);
    });
    it('uses readable browser membership for listed kinds, never private kinds or true full membership', () => {
        const state = { ...createHarness().getState(), artifactBrowserLoaded: true };
        expect(isArtifactInventoryLoaded(state, ['prompt_bundle.v2', 'acme.future-document'])).toBe(true);
        expect(isArtifactInventoryLoaded(state, ['approval_request.v1'])).toBe(false);
        expect(isArtifactInventoryLoaded(state)).toBe(false);
        expect(isArtifactInventoryLoaded(state, 'browserListed')).toBe(true);
        expect(isArtifactInventoryReady(state, 'browserListed')).toBe(true);
        expect(doesArtifactInventorySelectionCover(undefined, 'browserListed')).toBe(true);
        expect(doesArtifactInventorySelectionCover('browserListed', undefined)).toBe(false);
        expect(doesArtifactInventorySelectionCover('browserListed', ['prompt_bundle.v2', 'acme.future-document'])).toBe(true);
        expect(doesArtifactInventorySelectionCover('browserListed', ['approval_request.v1'])).toBe(false);
        expect(doesArtifactInventorySelectionCover(['markdown', 'prompt_bundle.v2'], ['prompt_bundle.v2'])).toBe(true);
        expect(doesArtifactInventorySelectionCover(['markdown', 'prompt_bundle.v2'], 'browserListed')).toBe(false);
        expect(doesArtifactInventorySelectionCover(['markdown'], ['approval_request.v1'])).toBe(false);
    });

    it('reconciles browser absence while preserving private opaque rows and concurrent arrivals', () => {
        const store = createHarness();
        expect(store.getState()).toMatchObject({ artifactBrowserLoaded: false });
        const listed = (id: number, kind?: string) => ({ ...artifact(id), access: 'owner' as const,
            header: { title: 'Document', ...(kind ? { kind } : {}) }, rawHeader: { title: 'Document', ...(kind ? { kind } : {}) } });
        const privateOpaque: DecryptedArtifact = { id: 'private', title: null, header: null, rawHeader: null, storageMode: 'e2ee', kindHint: 'approval_request.v1',
            isDecrypted: false, headerVersion: 1, createdAt: 1, updatedAt: 1, seq: 1,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        store.getState().applyArtifacts([listed(1, 'markdown'), listed(2, 'acme.unknown'), listed(3), listed(6), privateOpaque]);
        const baseline = store.getState().artifacts;
        store.getState().updateArtifact({ ...listed(2, 'acme.unknown'), headerVersion: 2 });
        store.getState().deleteArtifact('artifact-3');
        store.getState().addArtifact(listed(4));
        store.getState().applyArtifacts([listed(3), listed(5)], baseline, 'browserListed');
        const state = store.getState();
        expect(Object.keys(state.artifacts).sort()).toEqual(['artifact-2', 'artifact-4', 'artifact-5', 'private']);
        expect(state.artifacts.private).toBe(privateOpaque);
        expect(state.artifactBrowserLoaded).toBe(true);
        expect(state.artifactsLoaded).toBe(false);
        expect(state.artifactInventoryKindsLoaded).toEqual([]);
        store.getState().applyArtifacts(Object.values(state.artifacts).filter(row => row.id !== 'private'), state.artifacts, 'browserListed');
        expect(store.getState()).toBe(state);
    });

    it('keeps full structural membership but withdraws browser counts for opaque observations and arrivals', () => {
        const store = createHarness();
        expect(store.getState()).toMatchObject({ artifactBrowserLoaded: false });
        const listed = { ...artifact(1), access: 'owner' as const, header: { title: 'Document', kind: 'markdown' },
            rawHeader: { title: 'Document', kind: 'markdown' } };
        store.getState().applyArtifacts([listed], store.getState().artifacts);
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(true);
        const opaque: DecryptedArtifact = { id: 'opaque', title: null, header: null, rawHeader: null, storageMode: 'plain', kindHint: 'markdown',
            isDecrypted: false, headerVersion: 1, createdAt: 1, updatedAt: 1, seq: 1,
            availability: { kind: 'locked', reason: 'invalid_stored_content' } };
        store.getState().applyArtifacts([listed, opaque], store.getState().artifacts, 'browserListed', 'unreadable');
        expect(store.getState().artifactsLoaded).toBe(true);
        expect(isArtifactInventoryReady(store.getState(), 'browserListed')).toBe(false);
        store.getState().deleteArtifact(opaque.id);
        store.getState().applyArtifacts([listed], store.getState().artifacts, 'browserListed');
        const baseline = store.getState().artifacts;
        store.getState().addArtifact({ ...opaque, kindHint: 'approval_request.v1' });
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(true);
        store.getState().updateArtifact({ ...opaque, headerVersion: 2 });
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
        store.getState().applyArtifacts([listed], baseline, 'browserListed');
        expect(store.getState().artifacts.opaque).toMatchObject({ headerVersion: 2 });
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
        store.getState().deleteArtifact(opaque.id);
        store.getState().applyArtifacts([listed], store.getState().artifacts, 'browserListed');
        const beforeUnknown = store.getState().artifacts;
        const { kindHint: _kindHint, ...unclassified } = opaque;
        store.getState().addArtifact({ ...unclassified, id: 'unknown' });
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
        store.getState().applyArtifacts([listed], beforeUnknown, 'browserListed');
        expect(store.getState().artifacts.unknown).toBeDefined();
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
    });

    it('preserves an unchanged unresolved opaque row without certifying complete browser counts', () => {
        const store = createHarness();
        const opaque: DecryptedArtifact = { id: 'opaque-private-or-removed', title: null, header: null, rawHeader: null, storageMode: 'e2ee', isDecrypted: false,
            headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        const listed = { ...artifact(1), header: { title: 'Document', kind: 'markdown' },
            rawHeader: { title: 'Document', kind: 'markdown' }, access: 'owner' as const };
        store.getState().applyArtifacts([opaque, listed]);
        const baseline = store.getState().artifacts;
        store.getState().applyArtifacts([listed], baseline, 'browserListed');
        expect(store.getState().artifacts[opaque.id]).toBe(opaque);
        expect(isArtifactInventoryLoaded(store.getState(), 'browserListed')).toBe(false);
        expect(isArtifactInventoryLoaded(store.getState())).toBe(false);
    });

    it.each(['partial', 'unreadable'] as const)('fences %s observations and reconciles absence only after exhaustion', publication => {
        const store = createHarness();
        const unseen: DecryptedArtifact = { ...artifact(1), access: 'owner', rawHeader: { kind: 'prompt_doc.v2' } };
        const deleted = artifact(3);
        store.getState().applyArtifacts([unseen, deleted]);
        const baseline = store.getState().artifacts;
        store.getState().deleteArtifact(deleted.id);
        const locked: DecryptedArtifact = { id: 'opaque', title: null, header: null, createdAt: 2, updatedAt: 2,
            headerVersion: 1, seq: 2, storageMode: 'plain', isDecrypted: false,
            availability: { kind: 'locked', reason: 'invalid_stored_content' } };
        const kinds = ['prompt_doc.v2'];
        store.getState().applyArtifacts([locked, deleted], baseline, kinds, publication);
        const state = store.getState();
        expect(state.artifacts[unseen.id]).toBe(publication === 'unreadable' ? undefined : unseen);
        expect(state.artifacts[deleted.id]).toBeUndefined();
        expect(state.artifacts.opaque).toBe(locked);
        expect(state.artifactInventoryUnreadyCount).toBe(1);
        expect(state.artifactInventoryKindsLoaded).toEqual([]);
        expect(isArtifactInventoryLoaded(state, kinds)).toBe(false);
        expect(isArtifactInventoryReady(state, kinds)).toBe(publication === 'unreadable');
        expect(isArtifactInventoryReady(state)).toBe(false);
        store.getState().applyArtifacts([locked, deleted], baseline, kinds, publication);
        expect(store.getState()).toBe(state);
    });

    it('reconciles exact-kind membership without evicting other kinds or claiming a full inventory', () => {
        const store = createHarness();
        const doc = (id: number) => ({ ...artifact(id), header: { kind: 'prompt_doc.v2', title: 'Prompt' }, rawHeader: { kind: 'prompt_doc.v2' } });
        const unrelated = { ...artifact(9), header: { kind: 'markdown', title: 'Unrelated' }, rawHeader: { kind: 'markdown' } };
        store.getState().applyArtifacts([doc(1), doc(2), doc(3), unrelated]);
        const baseline = store.getState().artifacts;
        store.getState().updateArtifact({ ...doc(2), headerVersion: 2, title: 'Concurrent change' });
        store.getState().deleteArtifact(doc(3).id);
        store.getState().addArtifact(doc(4));
        store.getState().applyArtifacts([doc(3), doc(5)], baseline, ['prompt_doc.v2']);
        expect(Object.keys(store.getState().artifacts).sort()).toEqual(['artifact-2', 'artifact-4', 'artifact-5', 'artifact-9']);
        expect(store.getState().artifacts['artifact-9']).toBe(unrelated);
        expect(store.getState().artifactsLoaded).toBe(false);
        expect(store.getState().artifactInventoryKindsLoaded).toEqual(['prompt_doc.v2']);
        const current = store.getState();
        store.getState().applyArtifacts(Object.values(current.artifacts).filter(row => row.rawHeader?.kind === 'prompt_doc.v2'),
            current.artifacts, ['prompt_doc.v2']);
        expect(store.getState()).toBe(current);
        store.getState().applyArtifacts(Object.values(current.artifacts), current.artifacts);
        expect(store.getState().artifactsLoaded).toBe(true);
    });
    it('publishes skill inventory only for changed skill revisions and tracks incomplete inventory through removal', () => {
        const store = createHarness();
        const skills = Array.from({ length: 139 }, (_, i) => ({ ...artifact(i),
            header: { title: `Skill ${i}`, kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' },
            rawHeader: { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1' }, access: 'owner' as const, bodyVersion: 1 }));
        const documents = Array.from({ length: 1000 }, (_, i) => ({ ...artifact(i + 139),
            header: { title: 'Document', kind: 'markdown' }, rawHeader: { kind: 'markdown' }, access: 'owner' as const }));
        store.getState().applyArtifacts([...skills, ...documents]);
        const before = store.getState().artifactSkillRevisions;
        let notifications = 0;
        const off = store.subscribe((state, previous) => { if (state.artifactSkillRevisions !== previous.artifactSkillRevisions) notifications++; });
        try {
            for (const document of documents.slice(0, 10)) store.getState().updateArtifact({ ...document, bodyVersion: 2 });
            expect(notifications).toBe(0);
            expect(Object.keys(before)).toHaveLength(139);
            expect(store.getState().artifactInventoryUnreadyCount).toBe(0);
            store.getState().updateArtifact({ ...skills[0]!, bodyVersion: 2 });
            expect(notifications).toBe(1);
            expect(store.getState().artifactSkillRevisions[skills[0]!.id]).toBe('artifact-0@1:2');
            store.getState().addArtifact({ id: 'locked-role', kindHint: 'role.v1', title: null,
                headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'e2ee', isDecrypted: false,
                availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
            expect(store.getState().artifactInventoryUnreadyCount).toBe(0);
            store.getState().addArtifact(artifact(2000));
            expect(store.getState().artifactInventoryUnreadyCount).toBe(1);
            store.getState().deleteArtifact('artifact-2000');
            expect(store.getState().artifactInventoryUnreadyCount).toBe(0);
            store.getState().deleteArtifact(skills[0]!.id);
            expect(Object.keys(store.getState().artifactSkillRevisions)).toHaveLength(138);
            const readStartedWith = store.getState().artifacts;
            store.getState().applyArtifacts([], readStartedWith);
            expect(store.getState().artifactSkillRevisions).toEqual({});
            expect(store.getState().artifactInventoryUnreadyCount).toBe(0);
        } finally { off(); }
    });
    it('retains unchanged Artifact slices when exact board or workflow reads hydrate or revise a body', () => {
        const store = createHarness();
        const head = { ...artifact(1), storageMode: 'plain', access: 'owner', ownerAccountId: 'owner',
            bodyVersion: 1, header: { title: 'Board', kind: 'work-board.v1', sessions: ['session'] },
            rawHeader: { title: 'Board', kind: 'work-board.v1', sessions: ['session'] }, sessions: ['session'],
            storageIdentity: { contentKeyEnvelope: 'plain', provenanceKeyEnvelope: null } } satisfies Extract<DecryptedArtifact, { isDecrypted: true }>;
        store.getState().applyArtifacts([head]);
        store.getState().updateArtifact({ ...structuredClone(head), body: 'Loaded board' });
        const loaded = store.getState().artifacts[head.id];
        expect(loaded.header).toBe(head.header);
        expect(loaded.rawHeader).toBe(head.rawHeader);
        expect(loaded.sessions).toBe(head.sessions);
        expect(loaded.storageIdentity).toBe(head.storageIdentity);
        const before = store.getState();
        const notify = vi.fn();
        const off = store.subscribe(notify);
        try {
            store.getState().updateArtifact(structuredClone(loaded));
            expect(store.getState()).toBe(before);
            expect(notify).not.toHaveBeenCalled();
            if (!loaded.isDecrypted) throw new Error('Expected readable board');
            store.getState().updateArtifact({ ...structuredClone(loaded), bodyVersion: 2, body: 'Revised board' });
            expect(store.getState().artifacts[head.id].header).toBe(head.header);
            expect(store.getState().artifacts[head.id].body).toBe('Revised board');
            expect(notify).toHaveBeenCalledTimes(1);
        } finally { off(); }
    });

    it('keeps opened content when an inventory adds exact header evidence without changing key custody', () => {
        const store = createHarness();
        const loaded = { ...artifact(1), storageMode: 'e2ee' as const, access: 'owner' as const, ownerAccountId: 'owner',
            bodyVersion: 1, body: 'Opened body', rawHeader: { title: 'Artifact 1' },
            storageIdentity: { contentKeyEnvelope: 'content', provenanceKeyEnvelope: null } };
        store.getState().applyArtifacts([loaded]);
        const head = { ...loaded, body: undefined,
            storageIdentity: { ...loaded.storageIdentity, header: 'exact stored header' } };
        store.getState().applyArtifacts([head]);
        expect(store.getState().artifacts[loaded.id]?.body).toBe('Opened body');
        store.getState().applyArtifacts([{ ...head,
            storageIdentity: { ...head.storageIdentity, contentKeyEnvelope: 'rotated' } }]);
        expect(store.getState().artifacts[loaded.id]?.body).toBeUndefined();
    });

    it('does not claim inventory readiness for a targeted body publication', () => {
        const store = createHarness();
        store.getState().applyArtifacts([{ ...artifact(1), body: 'Demanded approval' }]);
        expect(store.getState().artifactsLoaded).toBe(false);
        expect(store.getState().artifacts['artifact-1']?.body).toBe('Demanded approval');
    });

    it('reconciles full inventory membership while preserving writes and deletes since the read began', () => {
        const store = createHarness();
        store.getState().applyArtifacts([artifact(1), artifact(2), artifact(3)]);
        const readStartedWith = store.getState().artifacts;
        store.getState().updateArtifact({ ...artifact(2), headerVersion: 2 });
        store.getState().addArtifact(artifact(4));
        store.getState().deleteArtifact('artifact-3');
        store.getState().applyArtifacts([artifact(3), artifact(5)], readStartedWith);
        expect(store.getState().artifactsLoaded).toBe(true);
        expect(Object.keys(store.getState().artifacts).sort()).toEqual(['artifact-2', 'artifact-4', 'artifact-5']);
        expect(store.getState().artifacts['artifact-2']?.headerVersion).toBe(2);
        const before = store.getState();
        store.getState().applyArtifacts([], before.artifacts);
        expect(store.getState().artifacts).toEqual({});
        expect(store.getState().artifactsStorageRevision).toBe(before.artifactsStorageRevision + 1);
    });
    it('retains HTTP access and ownership across content-only socket creation and revision echoes without granting initial events', async () => {
        const store = createHarness();
        const decode = (version: number) => decryptSocketNewArtifactUpdate({
            artifactId: 'socket-artifact', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Socket document' }),
            body: encodePlainArtifactStoredContent({ body: 'Revision content' }),
            headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version,
            encryption: null, artifactDataKeys: new Map(),
        });
        const initial = await decode(1);
        if (!initial) throw new Error('Expected readable socket Artifact');
        store.getState().addArtifact(initial);
        expect(store.getState().artifacts[initial.id]?.access).toBeUndefined();
        expect(store.getState().artifacts[initial.id]?.ownerAccountId).toBeUndefined();
        store.getState().applyArtifacts([{ ...initial, access: 'owner', ownerAccountId: 'owner' }]);
        store.getState().addArtifact(initial);
        expect(store.getState().artifacts[initial.id]).toMatchObject({ access: 'owner', ownerAccountId: 'owner' });
        const revised = await decode(2);
        if (!revised) throw new Error('Expected readable revised Artifact');
        store.getState().addArtifact(revised);
        expect(store.getState().artifacts[initial.id]).toMatchObject({ access: 'owner', ownerAccountId: 'owner', bodyVersion: 2 });
        store.getState().applyArtifacts([{ ...revised, access: 'view', ownerAccountId: 'different-owner' }]);
        expect(store.getState().artifacts[initial.id]).toMatchObject({ access: 'view', ownerAccountId: 'different-owner' });
    });
    it('retains decoded E2EE content only while revision and exact key custody remain unchanged', async () => {
        const store = createHarness();
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const key = new Uint8Array(32).fill(8);
        const codec = new ArtifactEncryption(key);
        const wrap = () => encryption.encryptEncryptionKey(key).then(value => encodeBase64(value));
        const encrypted: Artifact = { id: 'encrypted', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
            header: await codec.encryptHeader({ title: 'Encrypted' }), body: await codec.encryptBody({ body: 'Private' }),
            dataEncryptionKey: await wrap(), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const params = { encryption, artifactDataKeys: new Map() };
        const opened = await decryptArtifactWithBody({ ...params, artifact: encrypted });
        if (!opened) throw new Error('Expected opened Artifact');
        store.getState().applyArtifacts([opened]);
        const before = store.getState();
        const publications = vi.fn();
        store.subscribe(publications);
        const echo = await decryptArtifactListItem({ ...params, artifact: { ...encrypted, body: undefined } });
        if (!echo) throw new Error('Expected list header');
        store.getState().applyArtifacts([echo]);
        console.info('B07 E2EE unchanged-head publications:', publications.mock.calls.length);
        expect(store.getState()).toBe(before);
        expect(publications).toHaveBeenCalledTimes(0);
        const rotated = await decryptArtifactListItem({ ...params, artifact: { ...encrypted, body: undefined, dataEncryptionKey: await wrap() } });
        if (!rotated) throw new Error('Expected rotated list header');
        store.getState().applyArtifacts([rotated]);
        expect(store.getState().artifacts.encrypted?.body).toBeUndefined();
        expect(publications).toHaveBeenCalledTimes(1);
    });
    it('retains an opened plain body and row identity through an unchanged header-only echo', () => {
        const store = createHarness();
        const opened: DecryptedArtifact = { ...artifact(1), storageMode: 'plain', access: 'owner',
            ownerAccountId: 'owner', bodyVersion: 2, body: 'Already opened content',
            provenance: { savedBy: { kind: 'person', accountId: 'owner' } } };
        store.getState().applyArtifacts([opened]);
        const before = store.getState();
        const notify = vi.fn();
        store.subscribe(notify);

        const { provenance: _provenance, ...headerOnly } = structuredClone(opened);
        store.getState().applyArtifacts([{ ...headerOnly, body: undefined }]);
        console.info('B07 plain unchanged-head publications:', notify.mock.calls.length);

        expect(store.getState().artifacts[opened.id]?.body).toBe(opened.body);
        expect(store.getState().artifacts[opened.id]?.provenance).toEqual(opened.provenance);
        expect(store.getState().artifacts[opened.id]).toBe(opened);
        expect(store.getState()).toBe(before);
        expect(notify).not.toHaveBeenCalled();
    });

    it('retains demanded provenance without a body only while exact revision and custody remain unchanged', () => {
        const store = createHarness();
        const provenance = { savedBy: { kind: 'person' as const, accountId: 'owner' } };
        const opened: DecryptedArtifact = { ...artifact(1), storageMode: 'e2ee', access: 'owner',
            ownerAccountId: 'owner', bodyVersion: 2, provenance,
            storageIdentity: { contentKeyEnvelope: 'content', provenanceKeyEnvelope: 'private' } };
        store.getState().applyArtifacts([opened]);
        const before = store.getState();
        const { provenance: _provenance, ...head } = opened;
        store.getState().applyArtifacts([head]);
        expect(store.getState()).toBe(before);
        store.getState().applyArtifacts([{ ...head, provenance: undefined }]);
        expect(store.getState().artifacts[opened.id]?.provenance).toBeUndefined();
        expect(Object.hasOwn(store.getState().artifacts[opened.id], 'provenance')).toBe(true);
        const cleared = store.getState();
        store.getState().applyArtifacts([head]);
        expect(store.getState()).toBe(cleared);
        store.getState().applyArtifacts([opened]);
        store.getState().applyArtifacts([{ ...head, storageIdentity: { ...head.storageIdentity!, provenanceKeyEnvelope: 'rotated' } }]);
        expect(store.getState().artifacts[opened.id]?.provenance).toBeUndefined();
    });

    it.each([
        { bodyVersion: 3 },
        { headerVersion: 2 },
        { storageMode: 'e2ee' as const },
        { access: 'view' as const },
        { ownerAccountId: 'another-owner' },
    ])('does not retain opened content after an incoming authority or revision change: %j', (change) => {
        const store = createHarness();
        const opened: DecryptedArtifact = { ...artifact(1), storageMode: 'plain', access: 'owner',
            ownerAccountId: 'owner', bodyVersion: 2, body: 'Private content' };
        store.getState().applyArtifacts([opened]);
        store.getState().applyArtifacts([{ ...opened, ...change, body: undefined }]);
        expect(store.getState().artifacts[opened.id]?.body).toBeUndefined();
    });

    it('publishes the loaded transition once and suppresses empty, identical and decoded no-ops', () => {
        const store = createHarness();
        const notify = vi.fn();
        store.subscribe(notify);
        store.getState().applyArtifacts([], store.getState().artifacts);
        expect(notify).toHaveBeenCalledTimes(1);
        store.getState().applyArtifacts([], store.getState().artifacts);
        expect(notify).toHaveBeenCalledTimes(1);
        const board = { ...artifact(1), header: { kind: 'work-board.v1', title: 'Board' } };
        store.getState().addArtifact(board);
        const before = store.getState();
        const boardChanged = vi.fn();
        store.subscribe((state) => { if (state.artifacts[board.id] !== before.artifacts[board.id]) boardChanged(); });
        notify.mockClear();
        store.getState().applyArtifacts([board]);
        store.getState().updateArtifact(structuredClone(board));
        store.getState().addArtifact(structuredClone(board));
        store.getState().deleteArtifact('missing');
        expect(store.getState()).toBe(before);
        expect(notify).not.toHaveBeenCalled();
        expect(boardChanged).not.toHaveBeenCalled();
        for (const change of [{ body: 'new body' }, { access: 'view' as const }, { headerVersion: 2 },
            { publicAudience: 'unknown' as const }, { publicAudience: 'none' as const }]) {
            const current = store.getState().artifacts[board.id];
            if (!current?.isDecrypted) throw new Error('Expected readable Board');
            store.getState().updateArtifact({ ...current, ...change });
        }
        expect(notify).toHaveBeenCalledTimes(5);
        const unrelated = artifact(2);
        store.getState().addArtifact(unrelated);
        store.getState().updateArtifact({ ...store.getState().artifacts[board.id]!, updatedAt: 5 });
        expect(store.getState().artifacts[unrelated.id]).toBe(unrelated);
    });

    it('keeps an old open approval discoverable through list hydration, catch-up and resolution beyond 500 heads', () => {
        const store = createHarness();
        const approval = ApprovalRequestV1Schema.parse({
            v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
        });
        const head: DecryptedArtifact = { ...artifact(0), header: buildApprovalRequestArtifactHeaderV1(approval),
            body: JSON.stringify(approval), bodyVersion: 1 };
        const openApprovals = () => Object.values(store.getState().artifacts).filter(isOpenApprovalInboxArtifact);
        store.getState().applyArtifacts([head, ...Array.from({ length: 550 }, (_, index) => artifact(index + 1))]);
        expect(Object.keys(store.getState().artifacts)).toHaveLength(551);
        expect(openApprovals()).toEqual([head]);
        store.getState().applyArtifacts([artifact(600)]);
        expect(openApprovals()).toEqual([head]);
        const resolved = { ...approval, status: 'executed' as const };
        store.getState().updateArtifact({ ...head, header: buildApprovalRequestArtifactHeaderV1(resolved),
            body: JSON.stringify(resolved), bodyVersion: 2 });
        expect(openApprovals()).toEqual([]);
        store.setState({ artifacts: {}, artifactsLoaded: false });
        store.getState().applyArtifacts([artifact(700)]);
        expect(openApprovals()).toEqual([]);
    });

    it('does not reopen a settled approval when an earlier header or body read arrives late', () => {
        const store = createHarness();
        const open = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const old: DecryptedArtifact = { ...artifact(1), header: buildApprovalRequestArtifactHeaderV1(open),
            body: JSON.stringify(open), headerVersion: 1, bodyVersion: 1 };
        const settled = ApprovalRequestV1Schema.parse({ ...open, status: 'executed', updatedAtMs: 2,
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {} } });
        const current: DecryptedArtifact = { ...old, header: buildApprovalRequestArtifactHeaderV1(settled),
            body: JSON.stringify(settled), headerVersion: 2, bodyVersion: 2 };
        store.getState().applyArtifacts([current]);
        const before = store.getState();
        store.getState().applyArtifacts([{ ...old, body: undefined }]);
        store.getState().applyArtifacts([old]);
        store.getState().addArtifact(old);
        expect(store.getState()).toBe(before);
        expect(isOpenApprovalInboxArtifact(store.getState().artifacts[old.id]!)).toBe(false);
    });
});
