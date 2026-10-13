import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readSkillDirectoryInputV1 } from './skillsDirectoryInputAdapter';

it('reads nested bytes and the actual executable mode at the filesystem boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-skill-input-'));
  try {
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'SKILL.md'), '---\nname: sample\n---\nBody');
    await writeFile(join(dir, 'scripts', 'run'), '#!/bin/sh\nexit 0');
    await chmod(join(dir, 'scripts', 'run'), 0o755);
    const files = await readSkillDirectoryInputV1(dir);
    expect(files.map(file => file.path).sort()).toEqual(['SKILL.md', 'scripts/run']);
    expect(files.find(file => file.path === 'scripts/run')).toMatchObject({ contentKind: 'utf8', unixMode: 0o755 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
