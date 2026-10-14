import { describe, expect, it } from 'vitest';

import {
  PromptArtifactRefV1Schema,
  PromptArtifactRefV1StoredSchema,
  PromptDocArtifactRefV1Schema,
} from './promptArtifactRefsV1.js';
import { MemoryDocReadInputV1Schema, MemoryMutationResultV1Schema } from './memoryActionsV1.js';
import { SessionInstructionsSetInputV1Schema, buildSessionInstructionsContextIntentV1 } from '../../actions/sessionStateFieldActions.js';

describe('PromptArtifactRefV1Schema', () => {
  it('retains a valid Home qualifier and refuses malformed qualifiers at the canonical reference owner', () => {
    expect(PromptArtifactRefV1Schema.parse({ kind: 'doc', artifactId: 'doc', serverId: 'home' }))
      .toEqual({ kind: 'doc', artifactId: 'doc', serverId: 'home' });
    expect(PromptArtifactRefV1Schema.safeParse({ kind: 'doc', artifactId: 'doc', serverId: 12 }).success).toBe(false);
    expect(PromptArtifactRefV1Schema.safeParse({ kind: 'doc', artifactId: 'doc', serverId: '' }).success).toBe(false);
  });
  it('projects known stored reference fields while refusing additive fields in authored references', () => {
    const docParsed = PromptArtifactRefV1StoredSchema.parse({
      kind: 'doc',
      artifactId: 'doc_1',
      futureRefField: 'keep-me',
    });
    const bundleParsed = PromptArtifactRefV1StoredSchema.parse({
      kind: 'bundle',
      artifactId: 'bundle_1',
      futureRefField: 'keep-me',
    });

    expect(docParsed).toEqual({
      kind: 'doc',
      artifactId: 'doc_1',
    });
    expect(PromptArtifactRefV1Schema.safeParse({ kind: 'doc', artifactId: 'doc_1', futureRefField: 'keep-me' }).success).toBe(false);
    expect(bundleParsed).toEqual({
      kind: 'bundle',
      artifactId: 'bundle_1',
    });
  });

  it('keeps prompt invocation targets doc-only', () => {
    expect(PromptDocArtifactRefV1Schema.safeParse({
      kind: 'doc',
      artifactId: 'doc_1',
    }).success).toBe(true);

    expect(PromptDocArtifactRefV1Schema.safeParse({
      kind: 'bundle',
      artifactId: 'bundle_1',
    }).success).toBe(false);
  });

  it('admits qualified document refs through memory and Instructions without weakening reference closure', () => {
    const ref = { kind: 'doc', artifactId: 'doc_1', serverId: 'home' } as const;
    expect(MemoryDocReadInputV1Schema.parse({ ref })).toEqual({ ref });
    expect(MemoryMutationResultV1Schema.parse({ ok: true, artifactId: ref.artifactId, factId: 'fact', ref,
      attachment: 'attached' }).ref).toEqual(ref);
    const target = { sessionId: 'session', serverId: 'home', expectedMetadataRevision: 1 };
    expect(SessionInstructionsSetInputV1Schema.parse({ ...target, ref }).ref).toEqual(ref);
    expect(SessionInstructionsSetInputV1Schema.parse({ ...target, ref: null }).ref).toBeNull();
    expect(buildSessionInstructionsContextIntentV1(ref)).toMatchObject({ kind: 'set', entry: { ref } });
    for (const invalid of [{ ...ref, kind: 'bundle' }, { ...ref, serverId: 1 }, { ...ref, extra: true }]) {
      expect(MemoryDocReadInputV1Schema.safeParse({ ref: invalid }).success).toBe(false);
      expect(SessionInstructionsSetInputV1Schema.safeParse({ ...target, ref: invalid }).success).toBe(false);
    }
  });

  it('exports the shared artifact ref schemas from the protocol root entrypoint', async () => {
    const Protocol = await import('../../index.js');
    expect(Protocol.PromptArtifactRefV1Schema).toBe(PromptArtifactRefV1Schema);
    expect(Protocol.PromptDocArtifactRefV1Schema).toBe(PromptDocArtifactRefV1Schema);
  });
});
