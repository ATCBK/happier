import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createCliActionDeps } from './createCliActionDeps';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

const boundary = await vi.hoisted(async () => {
  const { createTempDir } = await import('@/testkit/fs/tempDir');
  const taskHome = await createTempDir('happier-skills-read-');
  vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
  return { taskHome, get: vi.fn() };
});
vi.mock('axios', () => ({ default: { get: boundary.get } }));

describe('CLI skills.read real dependencies', () => {
  beforeEach(() => { resetActiveAccountSettingsSnapshotForTests(); boundary.get.mockReset(); });
  afterAll(async () => { const { removeTempDir } = await import('@/testkit/fs/tempDir');
    await removeTempDir(boundary.taskHome); vi.unstubAllEnvs(); });
  it('reads the session manifest then decrypts the selected Artifact through the real store', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { computePromptBundleDigestV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryDigests');
    const skillMd = '---\nname: review\ndescription: Review\n---\nFull instructions';
    const body = { v: 1 as const, createdAtMs: 1, updatedAtMs: 1, entries: [
      { path: 'SKILL.md', contentBase64: Buffer.from(skillMd).toString('base64'), contentKind: 'utf8' as const },
      { path: 'references/note.bin', contentBase64: 'AAEC/w==', contentKind: 'binary' as const, unixMode: 0o755 },
    ] };
    const sessionDir = join(boundary.taskHome, 'skills', 'sessions', 'active-session');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ items: [
      { skillId: 'selected', name: 'review', digest: computePromptBundleDigestV1(body) },
    ] }));
    boundary.get.mockImplementation(async (url: string) => ({ status: 200, data:
      url.endsWith('/v1/artifacts/selected') ? { id: 'selected', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } : { mode: 'plain', updatedAt: 1 },
    }));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const executor = createActionExecutor(createCliActionDeps({ token, credentials: { token, encryption: null },
      sessionId: 'active-session', serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' }));
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'active-session', file: 'references/note.bin' },
      { surface: 'mcp', authority: 'account_automation' })).toMatchObject({ ok: true, result: {
        skillId: 'selected', skillMd, file: { contentBase64: 'AAEC/w==', unixMode: 0o755 },
      } });
    const reads = boundary.get.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts/selected')).length;
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'absent-session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(boundary.get.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts/selected'))).toHaveLength(reads);
  });
});
