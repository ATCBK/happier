import type { CuaNativeClient } from './nativeClient.js';
import { CuaNativeSpaceRegistrySchema } from './schemas.js';

export type CuaSpaceRegistryPresence = 'present' | 'absent' | 'unknown';

/**
 * The one reader of `cua spaces ls` for a created Space, shared by local and BYOC routes.
 * A caller that knows its native provider requires it; any other provider is not proof of absence.
 */
export async function readCuaSpaceRegistry(native: CuaNativeClient, spaceId: string, signal?: AbortSignal,
    provider?: string): Promise<CuaSpaceRegistryPresence> {
    return (await readCuaSpaceRegistryEntry(native, spaceId, signal, provider)).presence;
}

/** The same read, also naming the image the registry row was created from (only `spaces ls` carries it). */
export async function readCuaSpaceRegistryEntry(native: CuaNativeClient, spaceId: string, signal?: AbortSignal,
    provider?: string): Promise<{ presence: CuaSpaceRegistryPresence; image?: string }> {
    const result = await native.json(['--embedded', 'spaces', 'ls'], signal);
    if (result.kind !== 'success') return { presence: 'unknown' };
    const parsed = CuaNativeSpaceRegistrySchema.safeParse(result.value);
    if (!parsed.success) return { presence: 'unknown' };
    const selected = parsed.data.spaces.find((entry) => entry.id === spaceId);
    if (!selected) return { presence: 'absent' };
    if (provider !== undefined && selected.provider !== provider) return { presence: 'unknown' };
    return { presence: 'present', ...(selected.image !== undefined ? { image: selected.image } : {}) };
}

/**
 * Forget a created Space's registry entry, without touching compute. Even a successful
 * `spaces rm` acknowledgement is not proof of absence: the registry is read again.
 */
export async function removeCuaSpaceRegistration(native: CuaNativeClient, spaceId: string, signal?: AbortSignal,
    provider?: string): Promise<'removed' | 'present' | 'unknown'> {
    let registry = await readCuaSpaceRegistry(native, spaceId, signal, provider);
    if (registry === 'present') {
        await native.json(['--embedded', 'spaces', 'rm', spaceId], signal);
        registry = await readCuaSpaceRegistry(native, spaceId, signal, provider);
    }
    return registry === 'absent' ? 'removed' : registry;
}
