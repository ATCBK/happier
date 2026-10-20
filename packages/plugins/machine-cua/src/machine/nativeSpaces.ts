import type { CuaNativeClient } from './nativeClient.js';
import { CuaNativeSpaceRegistrySchema } from './schemas.js';

export type CuaSpaceRegistryPresence = 'present' | 'absent' | 'unknown';

/**
 * The one reader of `cua spaces ls` for a created Space, shared by local and BYOC routes.
 * A caller that knows its native provider requires it; any other provider is not proof of absence.
 */
export async function readCuaSpaceRegistry(native: CuaNativeClient, spaceId: string, signal?: AbortSignal,
    provider?: string): Promise<CuaSpaceRegistryPresence> {
    const result = await native.json(['--embedded', 'spaces', 'ls'], signal);
    if (result.kind !== 'success') return 'unknown';
    const parsed = CuaNativeSpaceRegistrySchema.safeParse(result.value);
    if (!parsed.success) return 'unknown';
    const selected = parsed.data.spaces.find((entry) => entry.id === spaceId);
    if (!selected) return 'absent';
    return provider === undefined || selected.provider === provider ? 'present' : 'unknown';
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
