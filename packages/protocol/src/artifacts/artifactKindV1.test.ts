import { describe, expect, it } from 'vitest';
import { deriveArtifactCoarseKindV1 } from './artifactKindV1.js';

describe('Artifact coarse kind', () => {
  it('indexes library families without disclosing private header fields', () => {
    expect(deriveArtifactCoarseKindV1({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', title: 'private' })).toBe('skill');
    expect(deriveArtifactCoarseKindV1({ kind: 'prompt_bundle.v2', bundleSchemaId: 'generic.v1' })).toBe('prompt');
    expect(deriveArtifactCoarseKindV1({ kind: 'prompt_doc.v2' })).toBe('prompt');
    expect(deriveArtifactCoarseKindV1({ kind: 'plugin.ui.archive' })).toBe('plugin_ui');
    expect(deriveArtifactCoarseKindV1({ kind: 'memory_doc.v1' })).toBe('other');
    expect(deriveArtifactCoarseKindV1({ kind: 'future.unknown' })).toBe('other');
    expect(deriveArtifactCoarseKindV1({})).toBe('other');
  });

  it('retains malformed skill identity for the content reader to refuse truthfully', () => {
    expect(deriveArtifactCoarseKindV1({ kind: 'broken', bundleSchemaId: 'skills.skill_md_v1' })).toBe('skill');
  });
});
