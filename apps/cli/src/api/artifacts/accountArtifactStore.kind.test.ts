import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createAccountArtifactStore, encodeAccountArtifactListCursor } from './accountArtifactStore';

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
function store(supported = true) {
  const input = { credentials: { token: 'synthetic-token', encryption: null },
    getAccountEncryptionMode: async () => 'plain' as const,
    resolveServerFeaturesSnapshot: () => ({ status: 'ready' as const, features: FeaturesResponseSchema.parse({
      features: { artifacts: { queryHints: { enabled: supported } } }, capabilities: {},
    }) }) };
  return createAccountArtifactStore(input);
}
describe('Account Artifact coarse kind transport', () => {
  beforeEach(() => { get.mockReset(); post.mockReset(); });

  it('sends classification for create, update, binary upload and restore', async () => {
    const current = row(artifactId, skillHeader, 1);
    get.mockImplementation(async (url: string) => ({ status: 200, data: new URL(url).pathname.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 1, body: current.body, createdAt: 1, sizeBytes: 8 }], retentionCount: 10 }
      : current }));
    post.mockImplementation(async (_url: string, input: unknown) => {
      const wire = Buffer.isBuffer(input)
        ? decodeArtifactUploadMetadataV1(input.subarray(0, input.indexOf(10)))
        : input;
      expect(wire).toEqual(expect.objectContaining(Buffer.isBuffer(input)
        ? { artifactKind: 'v1:other:ordinary.v1' } : { kind: 'v1:skill:prompt_bundle.v2' }));
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

  it('omits unsupported optional hints on normal create, update, binary upload and restore without refusing content', async () => {
    const current = row(artifactId, skillHeader, 1);
    get.mockImplementation(async (url: string) => ({ status: 200, data: new URL(url).pathname.endsWith('/revisions')
      ? { revisions: [{ bodyVersion: 1, body: current.body, createdAt: 1, sizeBytes: 8 }], retentionCount: 10 } : current }));
    post.mockImplementation(async (_url: string, input: unknown) => {
      const upload = Buffer.isBuffer(input);
      const wire = upload ? decodeArtifactUploadMetadataV1(input.subarray(0, input.indexOf(10))) : input;
      expect(wire).not.toHaveProperty(upload ? 'artifactKind' : 'kind');
      return { status: 200, data: { id: artifactId, success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    const artifacts = store(false);
    await artifacts.create({ artifactId, header: skillHeader, body: 'new' });
    await expect(artifacts.update({ artifactId, header: skillHeader, body: 'new', expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
      .resolves.toMatchObject({ ok: true });
    await artifacts.create({ artifactId, header: { kind: 'ordinary.v1' }, binary: { bytes: new Uint8Array([1, 2]), mime: 'application/octet-stream' } });
    await expect(artifacts.update({ artifactId, header: { kind: 'ordinary.v1' }, binary: { bytes: new Uint8Array([3, 4]), mime: 'application/octet-stream' },
      expectedRevision: { headerVersion: 1, bodyVersion: 1 } })).resolves.toMatchObject({ ok: true });
    await expect(artifacts.revisions.restore({ artifactId, bodyVersion: 1, expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
      .resolves.toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(5);
  });

  it('preserves private content when a supported optional discriminator cannot fit its metadata column', async () => {
    const header = { kind: 'x'.repeat(192), title: 'Private content remains valid' };
    const current = row(artifactId, header, 1);
    get.mockResolvedValue({ status: 200, data: current });
    post.mockImplementation(async (_url: string, wire: unknown) => {
      expect(wire).not.toHaveProperty('kind');
      return { status: 200, data: { id: artifactId, success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    const artifacts = store();
    await expect(artifacts.create({ artifactId, header, body: 'Private body' })).resolves.toMatchObject({ artifactId });
    await expect(artifacts.update({ artifactId, header, body: 'Private body', expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
      .resolves.toMatchObject({ ok: true });
  });

  it('reads only classified skill pages and retains filtered pagination', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => row(`skill-${i}`, skillHeader, 501 - i));
    const queries: URLSearchParams[] = [];
    get.mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      queries.push(query);
      if (query.has('unclassified')) return { status: 200, data: { items: [], hasUnclassified: false } };
      expect(query.get('kind')).toBe('skill');
      return { status: 200, data: { items: query.has('cursor') ? rows.slice(500) : rows.slice(0, 500), hasUnclassified: false } };
    });
    const page = await store().list({ coarseKind: 'skill', limit: 1 });
    expect(page.items.map(item => item.artifactId)).toEqual(['skill-0']);
    expect(page.coverage).toBe('complete');
    expect(page.nextCursor).toBe(encodeAccountArtifactListCursor({ artifactId: 'skill-0', updatedAt: 501 }));
    expect(queries).toHaveLength(1);
  });

  it('keeps unknown membership partial without metadata writes or an inventory fallback', async () => {
    const known = row('known', skillHeader, 1);
    const older = row('unclassified', skillHeader, 502);
    const kinds: Array<string | null> = [];
    get.mockImplementation(async (url: string) => {
      const query = new URL(url).searchParams;
      kinds.push(query.get('kind') ?? query.get('unclassified'));
      expect(query.has('kind') || query.has('unclassified')).toBe(true);
      return { status: 200, data: { items: query.has('unclassified') ? [older] : [known], hasUnclassified: true } };
    });
    post.mockResolvedValue({ status: 409, data: { success: false, error: 'version-mismatch' } });
    const artifacts = store();
    const first = await artifacts.list({ coarseKind: 'skill', limit: 1 });
    expect(first.items.map(item => item.artifactId)).toEqual(['known']);
    expect(first.coverage).toBe('partial');
    expect(kinds).toEqual(['skill']);
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a filtered response that omits its completeness witness', async () => {
    get.mockResolvedValue({ status: 200, data: { items: [] } });
    await expect(store().list({ coarseKind: 'skill', limit: 1 })).rejects.toMatchObject({ code: 'list_failed' });
  });

  it('refuses an unfiltered response missing authenticated Artifact authority', async () => {
    // Retained ciphertext from server-v0.2.16-preview.1
    // (22ac8263cfdbcdb845441b9044ff18199cf7652e) is valid stored data.
    // Missing current Home authority must still be refused before opening it.
    get.mockImplementation(async (url: string) => {
      expect(new URL(url).searchParams.has('kind')).toBe(false);
      return { status: 200, data: [{ id: 'retained-0.2',
        header: 'AAEBAQEBAQEBAQEBAQ3D1uj43px+uLGuchVFGVDEkm6RfN1IfDZnIg4T0WCK4Ih8wul2qaIqCzhu40TM8/10hyBxnIk+zjfCKuxZp+HAkzJVLPYUHU1qOQ7EUGS6LvI+dmsnbtYcvYynDW3Ibd9W',
        dataEncryptionKey: 'AKwBsiCehjVPuFMje13g9PqxPH/L9DOmHAGTaWF/7PELBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEFp2vL9F4qtFp456Ip/CLBk3sduq0hPJdydpvcpyDvxcC/u5pBQ8RJx6w/6IzrX2B',
        headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }] };
    });
    await expect(store().list({ limit: 1 }))
      .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
  });
});
