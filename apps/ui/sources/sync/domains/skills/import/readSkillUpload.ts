import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { validatePromptBundleBodyV1AgainstSchemaId } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import type { SkillFileInputV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { readSkillUploadRootsV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

/** A file picked or dropped from a folder: its path inside the folder and its bytes; browsers carry no mode. */
export type SkillUploadFolderFile = Readonly<{ path: string; bytes: Uint8Array; unixMode?: number | null }>;

export type SkillUploadInput =
  | Readonly<{ kind: 'zip'; name: string; bytes: Uint8Array }>
  | Readonly<{ kind: 'folder'; files: readonly SkillUploadFolderFile[] }>;

export type SkillUploadError =
  | Readonly<{ code: 'invalid_name'; file: string }>
  | Readonly<{ code: 'unreadable'; file: string }>
  | Readonly<{ code: 'no_skill' }>;

export type SkillUploadResult = Readonly<{ ok: true; files: readonly SkillFileInputV1[] }> | Readonly<{ ok: false; error: SkillUploadError }>;

const SKILL_MD = 'SKILL.md';
const SHEBANG = [0x23, 0x21];

/** The skill folder's own root: when everything sits under one directory (a zipped or picked folder), drop it. */
function stripSharedRoot(paths: readonly string[]): (path: string) => string {
  if (paths.includes(SKILL_MD)) return (path) => path;
  const first = paths[0]?.split('/')[0];
  if (first === undefined || !paths.every((path) => path.startsWith(`${first}/`))) return (path) => path;
  return (path) => path.slice(first.length + 1);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Zip entries keep their Unix mode; a mode-less file (a browser folder) is a script when it starts with `#!` (IR-7). */
function resolveMode(bytes: Uint8Array, unixMode: number | null | undefined): number {
  if (unixMode != null && unixMode > 0) return unixMode & 0o777;
  return bytes[0] === SHEBANG[0] && bytes[1] === SHEBANG[1] ? 0o755 : 0o644;
}

function toSkillFiles(entries: readonly SkillUploadFolderFile[]): SkillUploadResult {
  const visible = entries.filter((entry) => !entry.path.split('/').some((segment) => segment === '__MACOSX' || segment === '.DS_Store'));
  const strip = stripSharedRoot(visible.map((entry) => entry.path));
  const files = visible.map((entry): SkillFileInputV1 => {
    const text = isUtf8Text(entry.bytes);
    return {
      path: strip(entry.path),
      contentBase64: encodeBase64(entry.bytes),
      contentKind: text ? 'utf8' : 'binary',
      unixMode: resolveMode(entry.bytes, entry.unixMode),
    };
  });
  // The bundle owner decides what a portable skill path is; its refusal names the file. A folder or zip of several
  // skills is checked skill by skill, each as the bundle it becomes.
  const roots = readSkillUploadRootsV1(files.map((file) => file.path));
  if (roots.length === 0) return { ok: false, error: { code: 'no_skill' } };
  for (const root of roots) {
    const bundle = root === '' ? files : files.filter((file) => file.path.startsWith(`${root}/`)).map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
    const checked = validatePromptBundleBodyV1AgainstSchemaId({
      bundleSchemaId: 'skills.skill_md_v1',
      body: { v: 1, entries: bundle, createdAtMs: 0, updatedAtMs: 0 },
    });
    if (!checked.ok) {
      if (checked.errorCode === 'missing_required_entry') return { ok: false, error: { code: 'no_skill' } };
      return { ok: false, error: { code: 'invalid_name', file: root === '' ? (checked.path ?? '') : `${root}/${checked.path ?? ''}` } };
    }
  }
  return { ok: true, files };
}

/** Reads an uploaded skill (a .zip or a folder) into `skills.install { source: upload }` files, locally. */
export async function readSkillUpload(input: SkillUploadInput): Promise<SkillUploadResult> {
  if (input.kind === 'folder') return toSkillFiles(input.files);
  const { BlobReader, Uint8ArrayWriter, ZipReader } = await import('@zip.js/zip.js');
  let reader: InstanceType<typeof ZipReader> | undefined;
  try {
    reader = new ZipReader(new BlobReader(new Blob([input.bytes as BlobPart])), { useWebWorkers: false });
    const entries = await reader.getEntries();
    const files: SkillUploadFolderFile[] = [];
    for (const entry of entries) {
      if (entry.directory || !('getData' in entry) || typeof entry.getData !== 'function') continue;
      const bytes = await entry.getData(new Uint8ArrayWriter());
      // Unix-made archives carry the mode in the high half of the external attributes.
      const mode = (entry.externalFileAttributes >>> 16) & 0o7777;
      files.push({ path: entry.filename, bytes, unixMode: mode > 0 ? mode : null });
    }
    return toSkillFiles(files);
  } catch {
    return { ok: false, error: { code: 'unreadable', file: input.name } };
  } finally {
    await reader?.close().catch(() => undefined);
  }
}
