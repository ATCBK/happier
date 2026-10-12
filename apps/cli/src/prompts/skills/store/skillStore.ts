import { join } from 'node:path';
import type { PromptBundleEntryV1 } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';

export type SkillSessionDirItem = { skillId: string; name: string; digest: string; files: PromptBundleEntryV1[] };
export type SkillSessionItem = Readonly<{ skillId: string; name: string; digest: string }>;
export type EnsureSkillSessionDirInput = Readonly<{ ownerKey: string; plan?: 'session_dir' | 'index'; items: readonly SkillSessionDirItem[]; nativeDisables: readonly Readonly<{ name: string; path: string }>[] }>;
export type EnsureSkillSessionDirResult = Readonly<{ pluginRoot: string; skillsRoot: string; failed: readonly Readonly<{ skillId: string; reason: 'materialize_failed'; detail?: string }>[] }>;
export type SkillCachePaths = Readonly<{ reliable: boolean; paths: ReadonlySet<string> }>;
export function createSkillStore(input: Readonly<{ happyHomeDir: string; platform?: NodeJS.Platform }>) {
    return {
        async ensureSkillSessionDir(request: EnsureSkillSessionDirInput): Promise<EnsureSkillSessionDirResult> {
            const pluginRoot = join(input.happyHomeDir, 'skills', 'sessions', request.ownerKey);
            return { pluginRoot, skillsRoot: join(pluginRoot, 'skills'), failed: [] };
        },
        async releaseSkillSessionDirs(_sessionId: string): Promise<void> {},
        async readSkillSessionItems(_ownerKey: string): Promise<readonly SkillSessionItem[] | null> { return null; },
        async collectSkillCache(_input: Readonly<{ libraryDigests: readonly string[] | null }>): Promise<void> {},
        async readLiveSkillCachePaths(): Promise<SkillCachePaths> { return { reliable: true, paths: new Set() }; },
        async reconcileSkillSessionDirs(_input: Readonly<{ liveSessionIds: readonly string[] | null; libraryDigests: readonly string[] | null }>): Promise<void> {},
    };
}
export type SkillStore = ReturnType<typeof createSkillStore>;
