import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { z } from 'zod/mini';
import { z as zMini } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { PromptBundleEntryV1Schema, validatePromptBundleBodyV1AgainstSchemaId, validateStoredPromptBundleBodyV1AgainstSchemaId, type PromptBundleEntryV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { linkDirectoryChildren } from '@happier-dev/plugin-sdk/fs';

const segment = z.string().check(z.minLength(1), z.refine(value => value !== '.' && value !== '..' && !/[\\/\0]/u.test(value)));
const digestSchema = z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/u));
export const SkillOwnerKeySchema = z.string().check(z.refine(value => {
    const parts = value.split('/');
    return (parts.length === 1 || parts.length === 3 && parts[1] === 'runs') && parts.every(part => segment.safeParse(part).success);
}));
export const EnsureSkillSessionDirInputSchema = z.strictObject({
    ownerKey: SkillOwnerKeySchema,
    items: z.array(z.strictObject({ skillId: z.string().check(z.minLength(1)), name: segment, digest: digestSchema,
        files: z.array((<T extends z.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(PromptBundleEntryV1Schema)) })),
    nativeDisables: z.array(z.strictObject({ name: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)) })),
}).check(z.refine(input => new Set(input.items.map(item => item.name)).size === input.items.length, { message: 'Delivered skill names must be unique' }));
export type SkillSessionDirItem = Readonly<{ skillId: string; name: string; digest: string; files: PromptBundleEntryV1[] }>;
export type SkillSessionItem = Readonly<{ skillId: string; name: string; digest: string }>;
export type EnsureSkillSessionDirInput = Readonly<{ ownerKey: string; items: readonly SkillSessionDirItem[];
    nativeDisables: readonly Readonly<{ name: string; path: string }>[] }>;
export const EnsureSkillSessionDirResultSchema = z.strictObject({ pluginRoot: z.string().check(z.minLength(1)), skillsRoot: z.string().check(z.minLength(1)),
    failed: z.array(z.strictObject({ skillId: z.string().check(z.minLength(1)), reason: z.literal('materialize_failed'), detail: z.optional(z.string()) })) });
export type EnsureSkillSessionDirResult = z.infer<typeof EnsureSkillSessionDirResultSchema>;
export type SkillCachePaths = Readonly<{ reliable: boolean; paths: ReadonlySet<string> }>;
const sessionManifestSchema = createStoredReadSchema(z.strictObject({ items: z.array(z.strictObject({ skillId: z.string().check(z.minLength(1)), name: segment, digest: digestSchema })) }));
type CollectionInput = Readonly<{ libraryDigests?: readonly string[] | null }>;

function errorCode(error: unknown): string {
    return error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
        ? Reflect.get(error, 'code') : 'materialize_failed';
}
async function exists(path: string): Promise<boolean> {
    try { await lstat(path); return true; }
    catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}
async function directoryEntries(path: string): Promise<string[]> {
    try { return await readdir(path); }
    catch (error) { if (errorCode(error) === 'ENOENT') return []; throw error; }
}
/** The single writer makes its immutable trees writable for retirement; never follows links. */
async function removeOwnedTree(path: string): Promise<void> {
    let info: Stats;
    try { info = await lstat(path); }
    catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
    if (!info.isSymbolicLink()) {
        await chmod(path, info.isDirectory() ? 0o700 : 0o600);
        if (info.isDirectory()) for (const name of await readdir(path)) await removeOwnedTree(join(path, name));
    }
    await rm(path, { recursive: true, force: true });
}
async function makeReadOnly(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isDirectory()) {
        for (const name of await readdir(path)) await makeReadOnly(join(path, name));
        await chmod(path, 0o555);
    } else if (!info.isSymbolicLink()) await chmod(path, info.mode & 0o111 ? 0o555 : 0o444);
}
async function readManifest(path: string): Promise<readonly SkillSessionItem[] | null> {
    try {
        const parsed = sessionManifestSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
        return parsed.success ? parsed.data.items : null;
    } catch { return null; }
}

export function createSkillStore(input: Readonly<{ happyHomeDir: string; platform?: NodeJS.Platform;
    readLibraryDigests?: () => Promise<readonly string[] | null> }>) {
    const root = join(input.happyHomeDir, 'skills'); const cache = join(root, 'cache'); const sessions = join(root, 'sessions');
    const platform = input.platform ?? process.platform;
    let pending: Promise<unknown> = Promise.resolve();
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = pending.then(operation); pending = result.catch(() => {}); return result;
    };
    const ownerDirectory = (ownerKey: string) => join(sessions, ...SkillOwnerKeySchema.parse(ownerKey).split('/'));
    const cacheDirectory = (digest: string) => join(cache, digestSchema.parse(digest).slice(7));

    const readRoots = async (): Promise<SkillCachePaths> => {
        const paths = new Set<string>();
        try {
            for (const sessionId of await directoryEntries(sessions)) {
                const sessionRoot = ownerDirectory(sessionId);
                const manifests = [join(sessionRoot, 'session.json')];
                const runs = join(sessionRoot, 'runs');
                for (const runId of await directoryEntries(runs)) manifests.push(join(ownerDirectory(`${sessionId}/runs/${runId}`), 'session.json'));
                for (const path of manifests) {
                    // A Run can be admitted before its parent's first skill plan exists.
                    if (path === manifests[0] && manifests.length > 1 && !await exists(path)) continue;
                    const items = await readManifest(path);
                    if (!items) return { reliable: false, paths };
                    paths.add(sessionRoot);
                    for (const item of items) paths.add(cacheDirectory(item.digest));
                }
            }
            return { reliable: true, paths };
        } catch { return { reliable: false, paths }; }
    };
    const readLibraryDigests = async (request: CollectionInput): Promise<readonly string[] | null> => {
        try { return request.libraryDigests !== undefined ? request.libraryDigests : await input.readLibraryDigests?.() ?? null; }
        catch { return null; }
    };
    const collect = async (libraryDigests: readonly string[]): Promise<void> => {
        const roots = await readRoots();
        if (!roots.reliable) return;
        const marked = new Set(roots.paths);
        try { for (const digest of libraryDigests) marked.add(cacheDirectory(digest)); }
        catch { return; }
        for (const name of await directoryEntries(cache)) {
            const path = join(cache, name);
            if ((name.startsWith('.staging-') || /^[a-f0-9]{64}$/u.test(name)) && !marked.has(path)) await removeOwnedTree(path);
        }
    };
    const materialize = async (item: SkillSessionDirItem): Promise<string> => {
        const body = { v: 1 as const, entries: item.files, createdAtMs: 0, updatedAtMs: 0 };
        const validate = platform === 'win32' ? validatePromptBundleBodyV1AgainstSchemaId : validateStoredPromptBundleBodyV1AgainstSchemaId;
        const valid = validate({ bundleSchemaId: 'skills.skill_md_v1', body });
        if (!valid.ok) throw Object.assign(new Error(valid.message), { code: valid.errorCode });
        if (computePromptBundleDigestV1(body) !== item.digest) throw Object.assign(new Error('Digest mismatch'), { code: 'digest_mismatch' });
        const target = cacheDirectory(item.digest);
        if (await exists(target)) return target;
        await mkdir(cache, { recursive: true, mode: 0o700 });
        const staging = await mkdtemp(join(cache, '.staging-'));
        try {
            for (const entry of item.files) {
                const path = join(staging, entry.path);
                await mkdir(dirname(path), { recursive: true, mode: 0o700 });
                await writeFile(path, Buffer.from(entry.contentBase64, 'base64'), { flag: 'wx', mode: entry.unixMode && entry.unixMode & 0o111 ? 0o755 : 0o644 });
            }
            await makeReadOnly(staging);
            await rename(staging, target);
            return target;
        } catch (error) {
            await removeOwnedTree(staging);
            throw error;
        }
    };
    return {
        ensureSkillSessionDir(request: EnsureSkillSessionDirInput): Promise<EnsureSkillSessionDirResult> {
            return serialize(async () => {
                const admitted = EnsureSkillSessionDirInputSchema.parse(request);
                const pluginRoot = ownerDirectory(admitted.ownerKey); const skillsRoot = join(pluginRoot, 'skills');
                const failed: EnsureSkillSessionDirResult['failed'] = [];
                const items: SkillSessionItem[] = [];
                const materialized = new Map<string, string>();
                for (const item of admitted.items) {
                    try {
                        materialized.set(item.name, await materialize(item));
                        items.push({ skillId: item.skillId, name: item.name, digest: item.digest });
                    } catch (error) { failed.push({ skillId: item.skillId, reason: 'materialize_failed', detail: errorCode(error) }); }
                }
                const manifestPath = join(pluginRoot, 'session.json');
                const previous = await readManifest(manifestPath);
                const unchanged = previous && JSON.stringify(previous) === JSON.stringify(items);
                const entriesPresent = await exists(skillsRoot) && (await readdir(skillsRoot)).length === items.length
                    && (await Promise.all(items.map(item => exists(join(skillsRoot, item.name))))).every(Boolean);
                if (unchanged && entriesPresent) return { pluginRoot, skillsRoot, failed };
                await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
                await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
                await chmod(skillsRoot, 0o700);
                for (const item of [...items]) {
                    const destination = join(skillsRoot, item.name);
                    const temporary = join(skillsRoot, `.staging-${randomUUID()}`);
                    try {
                        const source = materialized.get(item.name)!;
                        // A real folder under the skill's own name, so `../<sibling>/SKILL.md` resolves from it even where the
                        // platform follows links before `..`; on POSIX its children link to the immutable cache entry.
                        if (platform === 'win32') await cp(source, temporary, { recursive: true });
                        else await linkDirectoryChildren({ source, destination: temporary });
                        await makeReadOnly(temporary);
                        await removeOwnedTree(destination);
                        await rename(temporary, destination);
                    } catch (error) {
                        await removeOwnedTree(temporary);
                        items.splice(items.indexOf(item), 1);
                        failed.push({ skillId: item.skillId, reason: 'materialize_failed', detail: errorCode(error) });
                    }
                }
                const kept = new Set(items.map(item => item.name));
                for (const name of await readdir(skillsRoot)) if (!kept.has(name)) await removeOwnedTree(join(skillsRoot, name));
                await chmod(skillsRoot, 0o555);
                const pluginManifest = join(pluginRoot, '.claude-plugin', 'plugin.json');
                if (!await exists(pluginManifest)) {
                    await mkdir(dirname(pluginManifest), { recursive: true, mode: 0o700 });
                    await writeFile(pluginManifest, JSON.stringify({ name: 'happier', version: '1.0.0', description: 'Your Happier skills' }), { mode: 0o444 });
                }
                const temporaryManifest = join(pluginRoot, `.session-${randomUUID()}.json`);
                try {
                    await writeFile(temporaryManifest, JSON.stringify({ items }), { mode: 0o444 });
                    if (platform === 'win32' && await exists(manifestPath)) await chmod(manifestPath, 0o600);
                    await rename(temporaryManifest, manifestPath);
                } finally { await rm(temporaryManifest, { force: true }); }
                return { pluginRoot, skillsRoot, failed };
            });
        },
        releaseSkillSessionDirs(sessionId: string): Promise<void> {
            return serialize(() => removeOwnedTree(ownerDirectory(segment.parse(sessionId))));
        },
        async collectSkillCache(request: CollectionInput = {}): Promise<void> {
            // Remote inventory must not hold up unrelated Session materialization.
            const libraryDigests = await readLibraryDigests(request);
            if (libraryDigests !== null) await serialize(() => collect(libraryDigests));
        },
        readLiveSkillCachePaths(): Promise<SkillCachePaths> { return serialize(readRoots); },
        async reconcileSkillSessionDirs(request: Readonly<{ liveSessionIds: readonly string[] | null; libraryDigests?: readonly string[] | null }>): Promise<void> {
            if (request.liveSessionIds === null) return;
            const libraryDigests = await readLibraryDigests(request);
            if (libraryDigests === null) return;
            // The daemon's only caller awaits this after re-adoption and before
            // admitting Session control. Its live census stays a startup input.
            const liveSessionIds = request.liveSessionIds;
            return serialize(async () => {
                const live = new Set(liveSessionIds.map(id => segment.parse(id)));
                // Inventory uncertainty prevents both folder deletion and the subsequent cache sweep.
                if (!(await readRoots()).reliable) return;
                for (const sessionId of await directoryEntries(sessions)) if (!live.has(sessionId)) await removeOwnedTree(ownerDirectory(sessionId));
                await collect(libraryDigests);
            });
        },
    };
}
export type SkillStore = ReturnType<typeof createSkillStore>;
