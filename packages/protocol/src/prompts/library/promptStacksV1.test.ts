import { describe, expect, it } from 'vitest';

import predecessorPickerStack from '../../../fixtures/0.2-picker-skill-instructions-stack.json';
import { decodeBase64 } from '../../crypto/base64.js';
import { PromptBundleBodyV1Schema } from './promptBundleSchemas.js';
import { PromptPlacementV1Schema } from './promptPlacementV1.js';
import { applyPromptStackIntentV1, PromptStackEntryV1Schema, PromptStackIntentV1Schema, PromptStacksV1Schema } from './promptStacksV1.js';
import { ProjectSourceAttachmentIntentV1Schema } from '../../projects/sources/projectSourceV1.js';
import { openPromptLibraryContentV1, sealPromptLibraryContentV1 } from './promptLibraryRowsV1.js';
import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1.js';

describe('PromptStacksV1Schema', () => {
  it('admits only system append for new entries while keeping all predecessor placements readable', () => {
    const legacy = ['skill_instructions', 'provider_asset', 'composer_insert'];
    for (const placement of legacy) {
      expect(PromptPlacementV1Schema.safeParse(placement).success).toBe(false);
      expect(PromptStackIntentV1Schema.safeParse({ kind: 'attach', entry: {
        id: placement, ref: { kind: 'doc', artifactId: placement }, enabled: true, placement,
      } }).success).toBe(false);
      expect(ProjectSourceAttachmentIntentV1Schema.safeParse({ kind: 'attach', attachment: { purpose: 'context', entry: {
        id: placement, ref: { kind: 'bundle', artifactId: placement }, enabled: true, placement,
      } } }).success).toBe(false);
    }
    const parsed = PromptStacksV1Schema.parse({ future: true, surfaces: { coding: legacy.map(placement => ({
      id: placement, ref: { kind: 'bundle', artifactId: placement, future: true }, enabled: true,
      placement, future: true,
    })) } });
    expect(parsed.surfaces.coding.map(entry => entry.placement)).toEqual(legacy);
    expect(parsed.surfaces.coding[0]).not.toHaveProperty('future');
    expect(parsed.surfaces.coding[0]?.ref).not.toHaveProperty('future');
    const row = { promptStack: parsed.surfaces.coding };
    const changed = applyPromptStackIntentV1(row, { kind: 'set_enabled', entryId: 'composer_insert', enabled: false });
    expect(changed.ok && changed.row.promptStack.map(entry => entry.placement)).toEqual(legacy);
    const attached = applyPromptStackIntentV1(row, PromptStackIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'new', ref: { kind: 'doc', artifactId: 'new' }, enabled: true, placement: 'system_append',
    } }));
    expect(attached.ok && attached.row.promptStack.map(entry => entry.placement)).toEqual([...legacy, 'system_append']);
    if (!attached.ok) throw new Error('Expected current attach to preserve the stored row');
    const content = sealPromptLibraryContentV1({ mode: 'plain', material: null,
      record: { key: 'coding', value: { v: 1, scope: { kind: 'coding' }, entries: [...attached.row.promptStack] } } });
    const reopened = openPromptLibraryContentV1({ key: 'coding', mode: 'plain', material: null, content });
    expect(reopened).toMatchObject({ status: 'opened', record: { key: 'coding', value: {
      entries: [...parsed.surfaces.coding, expect.objectContaining({ id: 'new', placement: 'system_append' })],
    } } });
  });
  it('defaults to empty stacks when missing', () => {
    const parsed = PromptStacksV1Schema.parse({});
    expect(parsed).toEqual({
      v: 1,
      surfaces: {
        coding: [],
        voice: [],
        profilesById: {},
      },
    });
  });

  it('parses stack entries with defaults', () => {
    const parsed = PromptStacksV1Schema.parse({
      v: 1,
      surfaces: {
        coding: [
          {
            id: 'e1',
            ref: { kind: 'doc', artifactId: 'a1' },
          },
        ],
      },
    });

    expect(parsed.surfaces.coding[0]).toEqual({
      id: 'e1',
      ref: { kind: 'doc', artifactId: 'a1' },
      enabled: true,
      placement: 'system_append',
    });
  });

  it('reopens the predecessor picker skill placement and drops only the retired edit annotation', () => {
    const parsed = PromptStacksV1Schema.parse({ v: 1, surfaces: { coding: [
      { id: 'skill', ref: { kind: 'bundle', artifactId: 'skill-doc' }, enabled: true,
        placement: 'skill_instructions', editPolicy: 'agent_may_propose_requires_approval' },
      { id: 'required', ref: { kind: 'doc', artifactId: 'instructions', serverId: 'home' },
        enabled: true, placement: 'system_append', required: true },
    ] } });
    expect(parsed.surfaces.coding.map(entry => entry.placement)).toEqual(['skill_instructions', 'system_append']);
    expect(parsed.surfaces.coding[0]).not.toHaveProperty('editPolicy');
    expect(parsed.surfaces.coding[1]).toMatchObject({ required: true, ref: { serverId: 'home' } });
  });

  it('reads, writes and reopens captured 0.2 custody without pasting its skill between neighboring documents', async () => {
    // The vector comes from the real predecessor picker callback, not current types.
    const migrated = PromptStacksV1Schema.parse(predecessorPickerStack.stacks);
    const expectedEntries = predecessorPickerStack.stacks.surfaces.coding.map(({ editPolicy: _retired, ...entry }) => entry);
    expect(migrated.surfaces.coding).toEqual(expectedEntries);

    // Full-row retention differs from admitting a new attach operand.
    const currentWrite = {
      ...migrated,
      surfaces: {
        ...migrated.surfaces,
        coding: migrated.surfaces.coding.map(entry => PromptStackEntryV1Schema.parse(entry)),
      },
    };
    const reopened = PromptStacksV1Schema.parse(JSON.parse(JSON.stringify(currentWrite)));
    expect(reopened).toEqual({
      ...predecessorPickerStack.stacks,
      surfaces: { ...predecessorPickerStack.stacks.surfaces, coding: expectedEntries },
    });
    expect(reopened.surfaces.coding.map(entry => entry.placement))
      .toEqual(['system_append', 'skill_instructions', 'system_append']);
    expect(PromptStackEntryV1Schema.safeParse(predecessorPickerStack.stacks.surfaces.coding[1]).success).toBe(false);

    const bundle = predecessorPickerStack.artifacts[1];
    const bundleBody = PromptBundleBodyV1Schema.parse(JSON.parse(bundle.body));
    const skillMarkdown = new TextDecoder().decode(decodeBase64(bundleBody.entries[0].contentBase64, 'base64')).trim();
    expect(skillMarkdown).toContain('# Happier Session Control (CLI JSON)');
    const expectedBlocks = [
      'Before the skill: preserve the working tree.',
      'After the skill: report the checks actually run.',
    ];
    for (const stacks of [migrated, reopened]) {
      const blocks = await resolvePromptStackSystemAppendBlocksV1({
        surface: 'coding',
        promptStacksV1: stacks,
        readArtifact: async ref => predecessorPickerStack.artifacts.find(artifact => artifact.id === ref.artifactId) ?? null,
      });
      expect(blocks.blocks).toEqual(expectedBlocks);
    }
  });

});
