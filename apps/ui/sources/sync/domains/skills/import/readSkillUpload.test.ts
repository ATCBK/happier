import { describe, expect, it } from 'vitest';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { readSkillUpload } from './readSkillUpload';

const text = (value: string) => new TextEncoder().encode(value);
const SKILL_MD = text('---\nname: release-notes\ndescription: Draft release notes.\n---\nWrite the notes.\n');

async function zipOf(entries: readonly Readonly<{ path: string; body: Uint8Array; mode?: number }>[]): Promise<Uint8Array> {
    const { BlobWriter, Uint8ArrayReader, ZipWriter } = await import('@zip.js/zip.js');
    const writer = new ZipWriter(new BlobWriter('application/zip'));
    for (const entry of entries) {
        await writer.add(entry.path, new Uint8ArrayReader(entry.body), entry.mode === undefined ? { useWebWorkers: false } : {
            useWebWorkers: false,
            // Unix-made archives keep the mode in the high half of the external attributes.
            externalFileAttributes: (0o100000 | entry.mode) << 16 >>> 0,
            versionMadeBy: (3 << 8) | 20,
        } as never);
    }
    return new Uint8Array(await (await writer.close()).arrayBuffer());
}

describe('readSkillUpload', () => {
    it('gives a mode-less folder file that starts with #! the script mode, and other files the plain mode', async () => {
        const result = await readSkillUpload({ kind: 'folder', files: [
            { path: 'release-notes/SKILL.md', bytes: SKILL_MD },
            { path: 'release-notes/scripts/collect.sh', bytes: text('#!/bin/sh\necho hi\n') },
            { path: 'release-notes/template.md', bytes: text('# Notes\n') },
        ] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const byPath = new Map(result.files.map((file) => [file.path, file]));
        // The picked folder's own name is not part of the skill's paths.
        expect([...byPath.keys()].sort()).toEqual(['SKILL.md', 'scripts/collect.sh', 'template.md']);
        expect(byPath.get('scripts/collect.sh')?.unixMode).toBe(0o755);
        expect(byPath.get('template.md')?.unixMode).toBe(0o644);
        expect(new TextDecoder().decode(decodeBase64(byPath.get('SKILL.md')!.contentBase64))).toContain('name: release-notes');
    });

    it('refuses a zip whose file name cannot be saved on every machine, naming the file', async () => {
        const bytes = await zipOf([
            { path: 'SKILL.md', body: SKILL_MD },
            { path: 'notes:draft.md', body: text('x') },
        ]);
        await expect(readSkillUpload({ kind: 'zip', name: 'release-notes.zip', bytes }))
            .resolves.toEqual({ ok: false, error: { code: 'invalid_name', file: 'notes:draft.md' } });
    });

    it('keeps a zip entry’s Unix mode and refuses an upload with no SKILL.md', async () => {
        const kept = await readSkillUpload({ kind: 'zip', name: 'tool.zip', bytes: await zipOf([
            { path: 'tool/SKILL.md', body: SKILL_MD, mode: 0o644 },
            { path: 'tool/run', body: text('echo no shebang'), mode: 0o755 },
        ]) });
        expect(kept.ok && kept.files.find((file) => file.path === 'run')?.unixMode).toBe(0o755);
        await expect(readSkillUpload({ kind: 'folder', files: [{ path: 'a/readme.md', bytes: text('x') }] }))
            .resolves.toEqual({ ok: false, error: { code: 'no_skill' } });
    });

    it('reads a folder or zip of several skills as one file set, each skill folder keeping its own SKILL.md', async () => {
        const second = text('---\nname: orm-setup\ndescription: Set up the ORM.\n---\nSet it up.\n');
        const folder = await readSkillUpload({ kind: 'folder', files: [
            { path: 'skills/release-notes/SKILL.md', bytes: SKILL_MD },
            { path: 'skills/release-notes/template.md', bytes: text('# Notes\n') },
            { path: 'skills/orm-setup/SKILL.md', bytes: second },
        ] });
        expect(folder.ok && folder.files.map((file) => file.path).sort()).toEqual(
            ['orm-setup/SKILL.md', 'release-notes/SKILL.md', 'release-notes/template.md']);
        const zipped = await readSkillUpload({ kind: 'zip', name: 'pack.zip', bytes: await zipOf([
            { path: 'release-notes/SKILL.md', body: SKILL_MD },
            { path: 'orm-setup/SKILL.md', body: second },
            { path: 'README.md', body: text('A pack') },
        ]) });
        expect(zipped.ok && zipped.files.map((file) => file.path).sort()).toEqual(
            ['README.md', 'orm-setup/SKILL.md', 'release-notes/SKILL.md']);
    });

    it('names the file of a skill inside a several-skill upload that cannot be saved everywhere', async () => {
        await expect(readSkillUpload({ kind: 'folder', files: [
            { path: 'a/SKILL.md', bytes: SKILL_MD },
            { path: 'b/SKILL.md', bytes: SKILL_MD },
            { path: 'b/notes:draft.md', bytes: text('x') },
        ] })).resolves.toEqual({ ok: false, error: { code: 'invalid_name', file: 'b/notes:draft.md' } });
    });
});
