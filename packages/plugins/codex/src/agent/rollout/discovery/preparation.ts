import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod/mini';

import type { ExternalSessionContentSearchControl } from '@happier-dev/plugin-sdk/sessions/file-stores';

type DirectoryEntry = Pick<Dirent, 'name' | 'isDirectory' | 'isFile' | 'isSymbolicLink'>;
const RefSchema = z.strictObject({ home: z.number().check(z.int(), z.nonnegative()), path: z.string() });
const FileMetadataSchema = z.strictObject({ mtimeMs: z.number(), birthtimeMs: z.number(), generation: z.string() });
const RootInventorySchema = z.strictObject({
  home: z.number().check(z.int(), z.nonnegative()),
  requestedIds: z.array(z.string()),
  sourceGeneration: z.array(z.string()),
  afterPath: z.nullable(z.string()),
  complete: z.boolean(),
  files: z.array(z.strictObject({
    ref: RefSchema, matchingIds: z.array(z.string()), generation: z.string(), sortMs: z.number(), mtimeMs: z.number(),
  })),
});
const PreparationSchema = z.strictObject({
  roots: z.string(),
  directories: z.array(z.strictObject({ ref: RefSchema, generation: z.string(), entries: z.array(z.strictObject({ name: z.string(), kind: z.enum(['directory', 'file', 'other']) })) })),
  files: z.array(z.strictObject({ ref: RefSchema, metadata: FileMetadataSchema })),
  identities: z.array(z.strictObject({ ref: RefSchema, value: z.nullable(z.strictObject({ id: z.optional(z.string()), session_id: z.optional(z.string()) })) })),
  rootInventories: z.optional(z.array(RootInventorySchema)),
});
export type CodexRolloutPreparationState = z.infer<typeof PreparationSchema>;

function safeRelativePath(value: string): boolean {
  return !isAbsolute(value) && !(sep === '\\' && (value.includes('\\') || /^[A-Za-z]:/u.test(value)))
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !part.includes('\0'));
}

export function parseCodexRolloutPreparationState(value: unknown): CodexRolloutPreparationState | null {
  const parsed = PreparationSchema.safeParse(value);
  if (!parsed.success) return null;
  const state = parsed.data;
  const uniqueRefs = (entries: readonly Readonly<{ ref: z.infer<typeof RefSchema> }>[]) =>
    new Set(entries.map(({ ref }) => `${ref.home}:${ref.path}`)).size === entries.length;
  return [state.directories, state.files, state.identities].every(uniqueRefs)
    && [...state.directories, ...state.files, ...state.identities].every(({ ref }) => safeRelativePath(ref.path))
    && state.directories.every(({ entries }) => entries.every(({ name }) => safeRelativePath(name) && !name.includes('/')))
    && (state.rootInventories ?? []).every(inventory => (inventory.afterPath === null || safeRelativePath(inventory.afterPath))
      && inventory.files.every(file => file.ref.home === inventory.home && safeRelativePath(file.ref.path)
        && file.matchingIds.every(id => inventory.requestedIds.includes(id))))
    ? state : null;
}

function changed(): never {
  const error = new Error('Codex rollout preparation source changed; refresh the candidate list.');
  Object.assign(error, { code: 'codex_candidate_source_changed' });
  throw error;
}

/** Query-local native I/O facts, never title/body text or an authority for paths. */
export class CodexRolloutPreparation {
  readonly state: CodexRolloutPreparationState;
  private invalidated = false;
  private readonly directories = new Map<string, CodexRolloutPreparationState['directories'][number]>();
  private readonly files = new Map<string, CodexRolloutPreparationState['files'][number]>();
  private readonly identities = new Map<string, CodexRolloutPreparationState['identities'][number]>();

  constructor(private readonly homes: readonly string[], readonly control: ExternalSessionContentSearchControl,
    state?: CodexRolloutPreparationState, private readonly assertActive: () => void = () => {}, private readonly sourceChanged: () => never = changed) {
    const roots = createHash('sha256').update(JSON.stringify(homes)).digest('base64url');
    if (state && state.roots !== roots) this.invalidate();
    if (state && [...state.directories, ...state.files, ...state.identities].some(({ ref }) => ref.home >= homes.length)) this.invalidate();
    if (state?.rootInventories?.some(inventory => inventory.home >= homes.length)) this.invalidate();
    this.state = state ?? { roots, directories: [], files: [], identities: [] };
    for (const entry of this.state.directories) this.directories.set(this.key(entry.ref), entry);
    for (const entry of this.state.files) this.files.set(this.key(entry.ref), entry);
    for (const entry of this.state.identities) this.identities.set(this.key(entry.ref), entry);
  }

  /** Only selected families and a native frontier survive an interrupted inventory. */
  rootInventory(homePath: string, requestedIds: readonly string[], sourceGeneration: readonly string[]): z.infer<typeof RootInventorySchema> {
    const home = this.homes.indexOf(homePath);
    if (home < 0) return this.invalidate();
    const inventories = this.state.rootInventories ??= [];
    const remembered = inventories.find(inventory => inventory.home === home);
    if (remembered) {
      if (JSON.stringify(remembered.sourceGeneration) !== JSON.stringify(sourceGeneration)) this.invalidate();
      if (requestedIds.every(id => remembered.requestedIds.includes(id))) return remembered;
      inventories.splice(inventories.indexOf(remembered), 1);
    }
    const inventory = { home, requestedIds: [...requestedIds], sourceGeneration: [...sourceGeneration],
      afterPath: null, complete: false, files: [] } satisfies z.infer<typeof RootInventorySchema>;
    inventories.push(inventory);
    return inventory;
  }

  private key(ref: z.infer<typeof RefSchema>): string { return `${ref.home}:${ref.path}`; }

  invalidate(): never { this.invalidated = true; return this.sourceChanged(); }

  assertNotYielded(): void {
    if (this.invalidated) this.sourceChanged();
    this.control.assertNotYielded();
  }

  private ref(path: string): z.infer<typeof RefSchema> {
    for (let home = 0; home < this.homes.length; home += 1) {
      const rel = relative(this.homes[home]!, resolve(path)).split(sep).join('/');
      if (safeRelativePath(rel) && /^(?:sessions|archived_sessions)(?:\/|$)/u.test(rel)) return { home, path: rel };
    }
    return this.invalidate();
  }

  /** The home is admitted again each invocation. Only its native root may be linked. */
  async authorize(path: string): Promise<void> {
    this.assertActive();
    const ref = this.ref(path);
    const parts = ref.path.split('/');
    let current = join(this.homes[ref.home]!, parts[0]!);
    for (const part of parts.slice(1)) {
      current = join(current, part);
      const metadata = await lstat(current).catch(() => null);
      if (metadata?.isSymbolicLink()) this.invalidate();
    }
    const root = await realpath(join(this.homes[ref.home]!, parts[0]!)).catch(() => null);
    const physical = await realpath(path).catch(() => null);
    if (root && physical) {
      const rel = relative(root, physical);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) this.invalidate();
    }
    this.assertActive();
  }

  async readDirectory(path: string): Promise<DirectoryEntry[]> {
    await this.authorize(path);
    const ref = this.ref(path);
    const key = this.key(ref);
    let remembered = this.directories.get(key);
    const generation = async () => {
      const metadata = await stat(path, { bigint: true }).catch(() => null);
      // Entries are a query-local snapshot. New children can wait for the next
      // scan; only replacement/removal invalidates this directory's identity.
      return metadata ? `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}` : 'missing';
    };
    if (remembered && remembered.generation !== await generation()) this.invalidate();
    if (!remembered) {
      await this.control.prepare(async () => {
        if (remembered) return true;
        this.assertActive();
        const before = await generation();
        const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
        this.assertActive();
        remembered = { ref, generation: before, entries: entries.filter((entry) => !entry.isSymbolicLink()).map((entry) => ({
          name: String(entry.name), kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        })) };
        this.state.directories.push(remembered);
        this.directories.set(key, remembered);
        return false;
      });
    }
    return remembered!.entries.map(({ name, kind }) => ({ name,
      isDirectory: () => kind === 'directory', isFile: () => kind === 'file', isSymbolicLink: () => false }));
  }

  async readMetadata(path: string): Promise<z.infer<typeof FileMetadataSchema>> {
    await this.authorize(path);
    const ref = this.ref(path);
    const key = this.key(ref);
    let remembered = this.files.get(key);
    if (remembered) {
      const current = await stat(path).catch(() => this.invalidate());
      this.assertActive();
      if (`${current.dev}:${current.ino}:${Math.trunc(current.birthtimeMs)}` !== remembered.metadata.generation) this.invalidate();
      // Keep the captured inventory order when a live rollout is appended.
      // Its fresh content/coverage is checked by the transcript source owner.
      return remembered.metadata;
    }
    if (!remembered) {
      await this.control.prepare(async () => {
        if (remembered) return true;
        this.assertActive();
        const metadata = await stat(path);
        this.assertActive();
        remembered = { ref, metadata: { mtimeMs: metadata.mtimeMs, birthtimeMs: metadata.birthtimeMs,
          generation: `${metadata.dev}:${metadata.ino}:${Math.trunc(metadata.birthtimeMs)}` } };
        this.state.files.push(remembered);
        this.files.set(key, remembered);
        return false;
      });
    }
    return remembered!.metadata;
  }

  async readSessionIdentity(path: string, read: () => Promise<{ id?: string; session_id?: string } | null>): Promise<{ id?: string; session_id?: string } | null> {
    await this.authorize(path);
    const ref = this.ref(path);
    const key = this.key(ref);
    let remembered = this.identities.get(key);
    if (remembered) {
      // Cursor facts guide traversal only. Re-read the native immutable head
      // through its existing physical-file cache before accepting membership.
      const current = await read();
      this.assertActive();
      if (current?.id !== remembered.value?.id || current?.session_id !== remembered.value?.session_id
        || (current === null) !== (remembered.value === null)) this.invalidate();
    }
    if (!remembered) {
      await this.control.prepare(async () => {
        if (remembered) return true;
        const metadata = await read();
        this.assertActive();
        remembered = { ref, value: metadata ? { ...(metadata.id === undefined ? {} : { id: metadata.id }),
          ...(metadata.session_id === undefined ? {} : { session_id: metadata.session_id }) } : null };
        this.state.identities.push(remembered);
        this.identities.set(key, remembered);
        return false;
      });
    }
    return remembered!.value;
  }
}
