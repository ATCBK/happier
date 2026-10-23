import { describe, expect, it } from 'vitest';
import { deriveArtifactCoarseKindV1, deriveArtifactKindV1, deriveArtifactStoredKindV1, tryDeriveArtifactStoredKindV1, decodeArtifactKindV1, ArtifactStoredKindV1Schema,
  frameArtifactKindWriteBatchesV1, ArtifactKindWriteBatchInputV1Schema, ArtifactKindWriteBatchResponseV1Schema,
  ArtifactKindCoverageV1Schema } from './artifactKindV1.js';

describe('Artifact coarse kind', () => {
  it('indexes library families without disclosing private header fields', () => {
    expect(deriveArtifactCoarseKindV1({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', title: 'private' })).toBe('skill');
    expect(deriveArtifactCoarseKindV1({ kind: 'prompt_bundle.v2', bundleSchemaId: 'generic.v1' })).toBe('prompt');
    expect(deriveArtifactCoarseKindV1({ kind: 'prompt_doc.v2' })).toBe('prompt');
    expect(deriveArtifactCoarseKindV1({ kind: 'plugin.ui.archive' })).toBe('plugin_ui');
    expect(deriveArtifactCoarseKindV1({ kind: 'work-board.v1', v: 1, title: 'private' })).toBe('work_board');
    expect(deriveArtifactCoarseKindV1({ kind: 'widget-area-layout.v1', title: 'private' })).toBe('widget_area_layout');
    expect(deriveArtifactCoarseKindV1({ kind: 'widget-definition.v1', title: 'private' })).toBe('widget_definition');
    expect(deriveArtifactCoarseKindV1({ kind: 'widget-layout-fragment.v1', title: 'private' })).toBe('widget_layout_fragment');
    expect(deriveArtifactCoarseKindV1({ kind: 'memory_doc.v1' })).toBe('other');
    expect(deriveArtifactCoarseKindV1({ kind: 'future.unknown' })).toBe('other');
    expect(deriveArtifactCoarseKindV1({})).toBe('other');
  });

  it('retains malformed skill identity for the content reader to refuse truthfully', () => {
    expect(deriveArtifactCoarseKindV1({ kind: 'broken', bundleSchemaId: 'skills.skill_md_v1' })).toBe('skill');
  });
});
describe('Artifact exact kind hints', () => {
  it('omits only an unrepresentable optional hint while preserving strict explicit writer admission', () => {
    const header = { kind: 'x'.repeat(184) };
    expect(tryDeriveArtifactStoredKindV1(header)).toBeUndefined();
    expect(() => deriveArtifactStoredKindV1(header)).toThrow(RangeError);
    expect(ArtifactStoredKindV1Schema.safeParse(`v1:other:${header.kind}`).success).toBe(false);
    expect(tryDeriveArtifactStoredKindV1({})).toBe('v1:other:');
    expect(tryDeriveArtifactStoredKindV1({ kind: 'workflow-definition.v1' })).toBe('v1:other:workflow-definition.v1');
  });
  it('distinguishes derived complete coverage from partial positive legacy demand', () => {
    expect(ArtifactKindCoverageV1Schema.parse({ status: 'complete', unclassifiedCount: 0 })).toEqual({ status: 'complete', unclassifiedCount: 0 });
    expect(ArtifactKindCoverageV1Schema.parse({ status: 'partial', unclassifiedCount: 35000, reason: 'unclassified_legacy_rows' }).unclassifiedCount).toBe(35000);
    for (const coverage of [{ status: 'complete', unclassifiedCount: 1 },
      { status: 'partial', unclassifiedCount: 0, reason: 'unclassified_legacy_rows' },
      { status: 'partial', unclassifiedCount: 1.5, reason: 'unclassified_legacy_rows' },
      { status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows', header: 'private' }]) {
      expect(ArtifactKindCoverageV1Schema.safeParse(coverage).success).toBe(false);
    }
  });
  it('frames real inventory demand in one byte-budgeted batch without changing retained identities or ordered outcomes', () => {
    const items = Array.from({ length: 35000 }, (_, index) => ({ artifactId: `retained/${index}`,
      kind: 'v1:other:account_notice.v1', expectedHeaderVersion: 1 }));
    const framed = frameArtifactKindWriteBatchesV1(items);
    expect(framed).toHaveLength(1);
    expect(ArtifactKindWriteBatchInputV1Schema.parse(framed[0]).items).toEqual(items);
    expect(frameArtifactKindWriteBatchesV1([])).toEqual([]);
    expect(ArtifactKindWriteBatchResponseV1Schema.parse({ items: [
      { artifactId: 'retained/1', success: true },
      { artifactId: 'retained/2', success: false, error: 'version-mismatch' },
    ] }).items.map(item => item.artifactId)).toEqual(['retained/1', 'retained/2']);
    expect(ArtifactKindWriteBatchResponseV1Schema.safeParse({ items: [
      { artifactId: 'retained/2', success: false, error: 'version-mismatch', currentHeader: 'private' },
    ] }).success).toBe(false);
  });
  it('keeps exact header kinds independent of coarse bundle priority and admits legacy writes', () => {
    expect(deriveArtifactKindV1({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', title: 'Private' }))
      .toEqual({ kind: 'skill', kindHint: 'prompt_bundle.v2' });
    expect(deriveArtifactStoredKindV1({ kind: 'account_notice.v1' })).toBe('v1:other:account_notice.v1');
    expect(decodeArtifactKindV1('v1:other:account_notice.v1')).toEqual({ kind: 'other', kindHint: 'account_notice.v1', classified: true });
    expect(decodeArtifactKindV1('v1:other:')).toEqual({ kind: 'other', kindHint: null, classified: true });
    expect(decodeArtifactKindV1('other')).toEqual({ kind: 'other', kindHint: null, classified: false });
    expect(decodeArtifactKindV1(null)).toEqual({ kind: null, kindHint: null, classified: false });
    expect(ArtifactStoredKindV1Schema.safeParse('v1:unknown:role.v1').success).toBe(false);
    expect(ArtifactStoredKindV1Schema.safeParse('other').success).toBe(true);
    expect(decodeArtifactKindV1('v1:other:vendor:role.v1').kindHint).toBe('vendor:role.v1');
    expect(deriveArtifactStoredKindV1({ kind: 'x'.repeat(182) })).toHaveLength(191);
    expect(() => deriveArtifactStoredKindV1({ kind: 'x'.repeat(183) })).toThrow(RangeError);
    expect(ArtifactStoredKindV1Schema.safeParse(`v1:other:${'x'.repeat(183)}`).success).toBe(false);
    expect(ArtifactStoredKindV1Schema.safeParse(deriveArtifactStoredKindV1({ kind: '💡'.repeat(182) })).success).toBe(true);
  });
});
