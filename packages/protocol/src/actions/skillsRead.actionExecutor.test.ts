import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import * as library from '../prompts/library/promptLibraryActionOperations.js';
import { encodeBase64 } from '../crypto/base64.js';

const skillMd = '---\nname: review\ndescription: Review the current change\n---\nPrivate full skill instructions';
const entries = [
  { path: 'SKILL.md', contentBase64: encodeBase64(new TextEncoder().encode(skillMd)), contentKind: 'utf8' as const },
  { path: 'scripts/check.bin', contentBase64: 'AAEC/w==', contentKind: 'binary' as const, unixMode: 0o755 },
];

describe('skills.read Action', () => {
  it('reads only the session-resolved identity by name, with complete supporting bytes and modes', async () => {
    // The Artifact and session manifest are persistence boundaries. Admission,
    // bundle decoding and identity selection remain real.
    const executor = createActionExecutor({
      skillsRead: async request => library.readSkillInLibrary({
        request, sessionItems: request.sessionId === 'session' ? [{ skillId: 'selected', name: 'review', digest: '' }] : null,
        store: { read: async id => ({ id, revision: { headerVersion: 1, bodyVersion: 1 },
          header: { v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' },
          body: JSON.stringify({ v: 1, entries, createdAtMs: 1, updatedAtMs: 1 }) }) },
      }),
    });
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'rpc'] as const) {
      expect(await executor.execute('skills.read', { name: 'review', sessionId: 'session', file: 'scripts/check.bin' },
        { surface, authority: 'account_automation' })).toMatchObject({ ok: true, result: {
          skillId: 'selected', name: 'review', skillMd,
          files: [{ path: 'SKILL.md', bytes: new TextEncoder().encode(skillMd).length },
            { path: 'scripts/check.bin', bytes: 4, unixMode: 0o755 }],
          file: { path: 'scripts/check.bin', contentBase64: 'AAEC/w==', contentKind: 'binary', unixMode: 0o755 },
        } });
    }
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'other' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(await executor.execute('skills.read', { skillId: 'outside', sessionId: 'session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(await executor.execute('skills.read', { name: 'review' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('skills.read', { skillId: 'selected', file: '../secret' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
  });

  it('does not disclose missing, invalid or non-skill bundles', async () => {
    for (const artifact of [null, { id: 'generic', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'prompt_bundle.v2', title: 'Generic', bundleSchemaId: 'bundle.generic_v1' },
      body: JSON.stringify({ v: 1, entries, createdAtMs: 1, updatedAtMs: 1 }) }]) {
      const executor = createActionExecutor({ skillsRead: request => library.readSkillInLibrary({
        request, store: { read: async () => artifact },
      }) });
      expect(await executor.execute('skills.read', { skillId: 'generic' }, { surface: 'ui' }))
        .toMatchObject({ ok: false, errorCode: 'not_found' });
    }
  });
});
