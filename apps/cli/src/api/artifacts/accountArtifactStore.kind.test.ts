import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { createAccountArtifactStore, encodeAccountArtifactListCursor } from './accountArtifactStore';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { get, post } }));

const skillHeader = { kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', title: 'Skill' };
const artifactId = '11111111-1111-4111-8111-111111111111';
function row(id: string, header: Readonly<Record<string, unknown>>, updatedAt: number) {
  return { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(header),
    body: encodePlainArtifactStoredContent({ body: 'original' }), headerVersion: 1, bodyVersion: 1,
    seq: updatedAt, createdAt: updatedAt, updatedAt };
}
function store() {
  return createAccountArtifactStore({ credentials: { token: 'synthetic-token', encryption: null },
    getAccountEncryptionMode: async () => 'plain' });
}
function advertise(kindFiltering: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    features: kindFiltering === undefined ? {} : { artifacts: { kindFiltering: { enabled: kindFiltering } } }, capabilities: {},
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
}

describe('Account Artifact coarse kind transport', () => {
  beforeEach(() => { get.mockReset(); post.mockReset(); resetServerFeaturesClientForTests(); });
  afterEach(() => { vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

  it.each([true, undefined, 'true'])('negotiates classification for create, update, binary upload and restore (advertised=%s)', async enabled => {
    advertise(enabled);
    const current = row(artifactId, skillHeader, 1);
    get.mockImplementation(async (url: string) => ({ status: 200, data: new URL(url).pathname.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 1, body: current.body, createdAt: 1, sizeBytes: 8 }], retentionCount: 10 }
      : current }));
    post.mockImplementation(async (_url: string, input: unknown) => {
      const wire = Buffer.isBuffer(input)
        ? decodeArtifactUploadMetadataV1(input.subarray(0, input.indexOf(10)))
        : input;
      expect(wire).toEqual(expect.objectContaining(enabled === true
        ? Buffer.isBuffer(input) ? { artifactKind: 'other' } : { kind: 'skill' }
        : {}));
      if (enabled !== true) {
        expect(wire).not.toHaveProperty('artifactKind');
        if (!Buffer.isBuffer(input)) expect(wire).not.toHaveProperty('kind');
      }
      return { status: 200, data: { id: artifactId, success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    const artifacts = store();
    await artifacts.create({ artifactId, header: skillHeader, body: 'new' });
    await artifacts.update({ artifactId, header: skillHeader, body: 'new', expectedRevision: { headerVersion: 1, bodyVersion: 1 } });
    await artifacts.create({ artifactId, header: { kind: 'ordinary.v1' }, binary: { bytes: new Uint8Array([1, 2]), mime: 'application/octet-stream' } });
    await artifacts.update({ artifactId, header: { kind: 'ordinary.v1' }, binary: { bytes: new Uint8Array([3, 4]), mime: 'application/octet-stream' },
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } });
    await expect(artifacts.revisions.restore({ artifactId, bodyVersion: 1, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
      .resolves.toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(5);
  });

  it('reads only classified skill pages and retains filtered pagination', async () => {
    advertise(true);
    const rows = Array.from({ length: 501 }, (_, i) => row(`skill-${i}`, skillHeader, 501 - i));
    const queries: URLSearchParams[] = [];
    get.mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      queries.push(query);
      expect(query.get('kind')).toBe('skill');
      return { status: 200, data: { items: query.has('cursor') ? rows.slice(500) : rows.slice(0, 500), hasUnclassified: false } };
    });
    const page = await store().list({ coarseKind: 'skill', limit: 1 });
    expect(page.items.map(item => item.artifactId)).toEqual(['skill-0']);
    expect(page.coverage).toBe('complete');
    expect(page.nextCursor).toBe(encodeAccountArtifactListCursor({ artifactId: 'skill-0', updatedAt: 501 }));
    expect(queries).toHaveLength(2);
    expect(queries[1].get('cursor')).toBe(encodeAccountArtifactListCursor({ artifactId: 'skill-499', updatedAt: 2 }));
  });

  it('restarts the full scan while unclassified rows remain before applying the caller limit', async () => {
    advertise(true);
    const known = row('known', skillHeader, 1);
    const older = row('unclassified', skillHeader, 502);
    const fullRows = [older, ...Array.from({ length: 499 }, (_, i) => row(`other-${i}`, { kind: 'ordinary.v1' }, 501 - i)), known];
    const kinds: Array<string | null> = [];
    get.mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      kinds.push(query.get('kind'));
      return { status: 200, data: query.has('kind') ? { items: [known], hasUnclassified: true }
        : query.has('cursor') ? fullRows.slice(500) : fullRows.slice(0, 500) };
    });
    const artifacts = store();
    const first = await artifacts.list({ coarseKind: 'skill', limit: 1 });
    expect(first.items.map(item => item.artifactId)).toEqual(['unclassified']);
    expect(first.coverage).toBe('complete');
    expect(kinds).toEqual(['skill', null, null]);
    const next = await artifacts.list({ coarseKind: 'skill', limit: 1, cursor: first.nextCursor });
    expect(next.items.map(item => item.artifactId)).toEqual(['known']);
    expect(next.nextCursor).toBeUndefined();
  });

  it.each([undefined, 'true'])('uses the full scan without a new query against unsupported or malformed feature bits (%s)', async enabled => {
    advertise(enabled);
    get.mockImplementation(async (url: string) => {
      expect(new URL(url).searchParams.has('kind')).toBe(false);
      return { status: 200, data: [row('ordinary', { kind: 'ordinary.v1' }, 2), row('skill', skillHeader, 1)] };
    });
    const page = await store().list({ coarseKind: 'skill', kind: 'prompt_bundle.v2', limit: 1 });
    expect(page.items.map(item => item.artifactId)).toEqual(['skill']);
    expect(page.coverage).toBe('complete');
  });

  it('refuses a filtered response that omits its completeness witness', async () => {
    advertise(true);
    get.mockResolvedValue({ status: 200, data: { items: [] } });
    await expect(store().list({ coarseKind: 'skill', limit: 1 })).rejects.toMatchObject({ code: 'list_failed' });
  });

  it('refuses the released 0.2 header envelope without inventing missing Artifact authority', async () => {
    advertise(undefined);
    // server-v0.2.16-preview.1 (22ac8263cfdbcdb845441b9044ff18199cf7652e)
    // artifactsRoutes.ts lists only these fields. Ciphertext is the existing
    // captured 0.2 writer vector; the absent authority fields are the deciding seam.
    get.mockImplementation(async (url: string) => {
      expect(new URL(url).searchParams.has('kind')).toBe(false);
      return { status: 200, data: [{ id: 'retained-0.2',
        header: 'AAEBAQEBAQEBAQEBAQ3D1uj43px+uLGuchVFGVDEkm6RfN1IfDZnIg4T0WCK4Ih8wul2qaIqCzhu40TM8/10hyBxnIk+zjfCKuxZp+HAkzJVLPYUHU1qOQ7EUGS6LvI+dmsnbtYcvYynDW3Ibd9W',
        dataEncryptionKey: 'AKwBsiCehjVPuFMje13g9PqxPH/L9DOmHAGTaWF/7PELBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEFp2vL9F4qtFp456Ip/CLBk3sduq0hPJdydpvcpyDvxcC/u5pBQ8RJx6w/6IzrX2B',
        headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }] };
    });
    await expect(store().list({ coarseKind: 'skill', limit: 1 }))
      .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
  });
});
