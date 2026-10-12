import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPromptDocInLibrary,
  createPromptBundleInLibrary,
  updatePromptDocInLibrary,
} from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { PromptDocArtifactHeaderV1Schema, PromptDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import { PromptStackEntryV1Schema, type PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { withUiPromptLibraryArtifactReader, withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';
import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
// Every case uses this real lazy production graph. Load it during collection,
// so shared-worker transformation time is not charged to an Artifact operation.
await import('@/sync/ops/actions/actionAccountContext');

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(() => { home?.dispose(); home = undefined; });

function entry(artifactId: string, overrides: Partial<PromptStackEntryV1> = {}): PromptStackEntryV1 {
  return PromptStackEntryV1Schema.parse({ id: artifactId, ref: { kind: 'doc', artifactId },
    enabled: true, placement: 'system_append', ...overrides });
}

async function documents() {
  home = await createPlainArtifactHomeFixture('https://prompt-stack-composition.test');
  const serverId = home.home.id;
  const ids = await withUiPromptLibraryArtifactStore(async store => {
    const result: Record<string, string> = {};
    for (const title of ['coding', 'profile', 'voice']) {
      result[title] = (await createPromptDocInLibrary({ store, request: { title, markdown: 'Hello from ' + title }, nowMs: () => 1 })).artifactId;
    }
    return result;
  }, { serverId });
  return { serverId, ids };
}

describe('UI prompt-stack input and qualified Artifact composition', () => {
  it('reads a real produced document again for the next preparation instead of retaining its old body', async () => {
    const { serverId, ids } = await documents();
    const resolve = () => withUiPromptLibraryArtifactReader(reader => resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', accountEntries: [entry(ids.coding!)], ...reader,
    }), { serverId });
    expect((await resolve()).blocks).toEqual(['Hello from coding']);
    await withUiPromptLibraryArtifactStore(async store => {
      const current = await store.read(ids.coding!);
      if (!current?.body) throw new Error('Expected produced prompt document');
      expect(PromptDocArtifactHeaderV1Schema.parse(current.header)).toMatchObject({ kind: 'prompt_doc.v2' });
      expect(PromptDocBodyV1Schema.parse(JSON.parse(current.body))).toMatchObject({ markdown: 'Hello from coding' });
      await updatePromptDocInLibrary({ store, request: { artifactId: ids.coding!, title: 'coding',
        markdown: 'Second current text', expectedRevision: current.revision }, nowMs: () => 2 });
    }, { serverId });
    expect((await resolve()).blocks).toEqual(['Second current text']);
  });

  it('normalizes stored coding/voice/profile stacks and preserves enabled and placement decisions', async () => {
    const { serverId, ids } = await documents();
    const coding = entry(ids.coding!);
    const profile = entry(ids.profile!);
    const voice = entry(ids.voice!);
    const promptStacksV1 = { v: 1, surfaces: {
      coding: [{ ...coding, futureAnnotation: { source: 'retained' } }, entry(ids.voice!, { id: 'disabled', enabled: false }),
        entry(ids.voice!, { id: 'insert', placement: 'composer_insert' })],
      voice: [voice], profilesById: { p1: [profile] },
    } };
    for (const [surface, expected] of [
      ['coding', ['Hello from coding', 'Hello from profile']],
      ['voice', ['Hello from voice', 'Hello from profile']],
    ] as const) {
      const result = await withUiPromptLibraryArtifactReader(reader => resolvePromptStackSystemAppendBlocksV1({
        surface, promptStacksV1, profileId: 'p1', ...reader,
      }), { serverId });
      expect(result.blocks).toEqual(expected);
    }
    const disabled = await withUiPromptLibraryArtifactReader(reader => resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', promptStacksV1: { v: 1, surfaces: { coding: [
        entry(ids.coding!, { enabled: false }), entry(ids.profile!, { placement: 'composer_insert' }),
      ] } }, ...reader,
    }), { serverId });
    expect(disabled.blocks).toEqual([]);
  });

  it('decodes a real SKILL.md bundle and applies the stored prompt budget through the UI adapter', async () => {
    const { serverId, ids } = await documents();
    const bundle = await withUiPromptLibraryArtifactStore(store => createPromptBundleInLibrary({ store,
      request: { title: 'Review', bundleSchemaId: 'skills.skill_md_v1', entries: [{ path: 'SKILL.md',
        contentBase64: Buffer.from('# Skill').toString('base64'), contentKind: 'utf8' }] }, nowMs: () => 1,
    }), { serverId });
    const result = await withUiPromptLibraryArtifactReader(reader => resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', promptStacksV1: { v: 1, surfaces: { coding: [
        entry(ids.coding!, { maxChars: 5 }),
        entry(bundle.artifactId, { ref: { kind: 'bundle', artifactId: bundle.artifactId }, placement: 'skill_instructions' }),
      ] } }, ...reader,
    }), { serverId });
    expect(result.blocks).toEqual(['Hello', '# Skill']);
  });
});
