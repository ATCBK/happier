import { describe, expect, it } from 'vitest';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { SkillUpdateFileV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import {
  countSkillUpdates,
  defaultSkillFileChoices,
  groupSkillUpdates,
  hasUpdatingSource,
  needsALookDestination,
  skillUpdateApplyChoices,
} from './skillsUpdatesModel';

const base = SkillListItemV1Schema.parse({
  skillId: 'pdf',
  name: 'pdf',
  description: null,
  revision: '1:1',
  rules: [],
  trust: 'text_only',
  cost: { descriptionTokens: 0, bodyTokens: 0 },
  provenance: { kind: 'written' },
  modified: false,
  updatePolicy: 'manual',
  createdAt: 1,
  migratedFromContext: false,
  userInvocable: true,
  folderId: null,
});
const ready = {
  ...base,
  skillId: 'ready',
  upstream: { state: 'update_available' as const },
};
const modified = {
  ...base,
  skillId: 'mod',
  modified: true,
  upstream: { state: 'update_available' as const },
};
const removed = {
  ...base,
  skillId: 'gone',
  upstream: { state: 'removed_from_source' as const },
};
const localEdit = { ...base, skillId: 'edit', modified: true };

const file = (
  path: string,
  mine: string | null,
  theirs: string | null,
): SkillUpdateFileV1 => ({
  path,
  mine:
    mine === null ? null : { path, contentKind: 'utf8', contentBase64: mine },
  theirs:
    theirs === null
      ? null
      : { path, contentKind: 'utf8', contentBase64: theirs },
  changed: mine !== theirs,
});

describe('skills updates', () => {
  it('puts a not-modified update in Ready and a modified one in Needs your choice, nothing else', () => {
    const groups = groupSkillUpdates([
      base,
      ready,
      modified,
      removed,
      localEdit,
    ]);
    expect(groups.ready.map((item) => item.skillId)).toEqual(['ready']);
    expect(groups.needsChoice.map((item) => item.skillId)).toEqual(['mod']);
    expect(countSkillUpdates([base, ready, modified, removed, localEdit])).toBe(
      2,
    );
  });

  it('sends Review to Updates for a waiting update and to the skill for a removed source', () => {
    expect(needsALookDestination(ready)).toBe('updates');
    expect(needsALookDestination(modified)).toBe('updates');
    expect(needsALookDestination(removed)).toBe('detail');
  });

  it('defaults each changed file and applies exactly one choice per changed file', () => {
    const files = [
      file('SKILL.md', 'a', 'b'),
      file('scripts/new.py', null, 'c'),
      file('reference.md', 'same', 'same'),
    ];
    expect(defaultSkillFileChoices(files)).toEqual({
      'SKILL.md': 'mine',
      'scripts/new.py': 'theirs',
    });
    expect(
      skillUpdateApplyChoices(files, {
        'SKILL.md': 'theirs',
        'reference.md': 'mine',
      }),
    ).toEqual({
      'SKILL.md': 'theirs',
      'scripts/new.py': 'theirs',
    });
  });

  it('only a skill added from a link or a registry has a source that can update: written, uploaded and found ones never do', () => {
    expect(hasUpdatingSource([base, { ...base, skillId: 'up', provenance: { kind: 'upload', importedAt: 1 } }])).toBe(false);
    const linked = SkillListItemV1Schema.parse({
      ...base,
      skillId: 'linked',
      provenance: { kind: 'link', url: 'https://github.com/acme/skills/tree/main/pdf', ref: { kind: 'version', version: '1.0.0' } },
    });
    expect(hasUpdatingSource([base, linked])).toBe(true);
  });
});
