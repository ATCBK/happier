import { describe, expect, it } from 'vitest';
import { readSiblingSkillPathsV1, readSkillOutsideReferencesV1 } from './skillReferencesV1.js';

const skill = (body: string) =>
  `---\nname: review\ndescription: Reviews.\n---\n${body}`;

describe('skill outside references', () => {
  it('flags a link and an inline path that climb out of the skill folder', () => {
    const markdown = skill(
      'Follow [the checklist](../../shared/checklist.md).\n\nAlso run `../scripts/lint.sh`.',
    );
    expect(readSkillOutsideReferencesV1(markdown, ['SKILL.md'])).toEqual([
      '../../shared/checklist.md',
      '../scripts/lint.sh',
    ]);
  });

  it('does not flag a file or folder the bundle has', () => {
    const markdown = skill(
      'See [reference](reference.md), [scripts](./scripts/) and `./notes/a.md`.',
    );
    expect(
      readSkillOutsideReferencesV1(markdown, [
        'SKILL.md',
        'reference.md',
        'scripts/run.sh',
        'notes/a.md',
      ]),
    ).toEqual([]);
  });

  it('flags a missing file inside the folder', () => {
    const markdown = skill(
      'See [reference](reference.md#top) and [again](reference.md).',
    );
    expect(readSkillOutsideReferencesV1(markdown, ['SKILL.md'])).toEqual([
      'reference.md',
    ]);
  });

  it('ignores urls, anchors, absolute paths, fenced examples and bare prose paths', () => {
    const markdown = skill(
      [
        '[site](https://example.com/a.md) [mail](mailto:a@b.c) [top](#top) [root](/docs/a.md) [home](~/x.md)',
        'Edit `src/index.ts` and `$HOME/notes.md`, then read src/other.md.',
        'Write `./config.yaml`, run `../tools/run PLAN_FILE`, or add `[docs](./docs/README.md)`.',
        '```md',
        'See [example](../outside.md) and `../outside.sh`.',
        '```',
      ].join('\n'),
    );
    expect(readSkillOutsideReferencesV1(markdown, ['SKILL.md'])).toEqual([]);
  });

  it('reads definitions, angle-bracket targets and link titles', () => {
    const markdown = skill(
      '[a][1] [b](<../my notes.md>) [c](../c.md "Title")\n\n[1]: ../shared/a.md',
    );
    expect(readSkillOutsideReferencesV1(markdown, ['SKILL.md'])).toEqual([
      '../my notes.md',
      '../c.md',
      '../shared/a.md',
    ]);
  });
});

describe('sibling skill folders a skill refers to', () => {
  it('names the sibling folder whether the reference points at its SKILL.md, the folder, or a file inside it', () => {
    expect(
      readSiblingSkillPathsV1('prisma-cli', [
        '../prisma-orm-setup/SKILL.md',
        '../prisma-orm-setup/',
        '../prisma-orm-setup/references/a.md',
        '../prisma-mongodb-upgrade',
      ]),
    ).toEqual(['prisma-orm-setup', 'prisma-mongodb-upgrade']);
  });

  it('resolves against the skill folder inside a nested source tree', () => {
    expect(readSiblingSkillPathsV1('skills/a', ['../b/SKILL.md', '../../shared/c/SKILL.md'])).toEqual(['skills/b', 'shared/c']);
  });

  it('names no sibling for a single file, a file inside the skill, or a path above the source tree', () => {
    expect(readSiblingSkillPathsV1('skills/a', ['../README.md', 'missing.md', 'references/missing.md'])).toEqual([]);
    expect(readSiblingSkillPathsV1('', ['../b/SKILL.md'])).toEqual([]);
    expect(readSiblingSkillPathsV1('a', ['../../b/SKILL.md'])).toEqual([]);
  });
});
