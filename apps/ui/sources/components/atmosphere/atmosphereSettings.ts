import { releaseLook, type AtmosphereLookPicture } from '@happier-dev/brand/atmosphere';
import { DEFAULT_HOME_ATMOSPHERE, HomeAtmosphereSchema,
    type HomeAtmosphere, type ProjectAtmosphere } from '@happier-dev/protocol/account/settings/accountSettings';
import { buildBuiltInAccountSettingMutationV1, parseBuiltInAccountSettingValueV1,
    readBuiltInAccountSettingValueV1, readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import type { SettingStorageBinding, SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import type { Settings, SettingsWriteDelta } from '@/sync/domains/settings/settings';
import { randomUUID } from '@/platform/randomUUID';
import { readAtmospherePictureCatalog } from './pictureCatalog';

/** One sparse representation, shared by Look controls and Settings Actions. */
export function normalizeAtmosphereLooks(looks: HomeAtmosphere['looks'], pictures: readonly AtmosphereLookPicture[] = readAtmospherePictureCatalog()): HomeAtmosphere['looks'] {
    const entries = Object.entries(looks).flatMap(([id, look]) => {
        const picture = pictures.find(picture => picture.id === id);
        // Catalog absence is a rendering fallback, never authority to erase synced choices.
        if (!picture) return [[id, look] as const];
        const base = releaseLook(picture);
        const sparse = { ...look };
        if (sparse.look === base.effect) delete sparse.look;
        if (sparse.strength === base.strength) delete sparse.strength;
        if (sparse.dissolve === base.fade) delete sparse.dissolve;
        return Object.keys(sparse).length ? [[id, sparse] as const] : [];
    });
    return Object.fromEntries(entries);
}

export function normalizeHomeAtmosphere(value: HomeAtmosphere): HomeAtmosphere {
    return { ...value, looks: normalizeAtmosphereLooks(value.looks) };
}
export function normalizeProjectAtmosphere(value: ProjectAtmosphere): ProjectAtmosphere {
    return { ...value, looks: normalizeAtmosphereLooks(value.looks) };
}

/** Nested intents are reapplied to the latest Account snapshot by the incumbent CAS owner. */
export function buildHomeAtmosphereControlMutation(settings: Settings, anchor: string, value: unknown): SettingsWriteDelta | null {
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    if (!declaration) return null;
    const delta = buildBuiltInAccountSettingMutationV1(declaration, settings, value);
    if (!delta) return null;
    const parsed = HomeAtmosphereSchema.safeParse(delta.homeAtmosphere);
    return parsed.success ? { homeAtmosphere: normalizeHomeAtmosphere(parsed.data) } : null;
}

/** Full object and look-map writes need the picture release catalog; portable discovery routes them to this client owner. */
export function homeAtmosphereStorageBinding(anchor: 'appearance.homeAtmosphere' | 'appearance.atmosphereLooks'): SettingStorageBinding {
    const isLooks = anchor === 'appearance.atmosphereLooks';
    return { scope: 'account', kind: 'owner', access: 'read_write', resetValue: isLooks ? {} : DEFAULT_HOME_ATMOSPHERE,
        read: settings => isLooks ? settings.homeAtmosphere.looks : settings.homeAtmosphere,
        parse: value => {
            const parsed = HomeAtmosphereSchema.safeParse(isLooks ? { ...DEFAULT_HOME_ATMOSPHERE, looks: value } : value);
            if (!parsed.success) return { success: false };
            const normalized = normalizeHomeAtmosphere(parsed.data);
            return { success: true, value: isLooks ? normalized.looks : normalized };
        },
        mutate: (settings, value) => {
            const parsed = HomeAtmosphereSchema.safeParse(isLooks ? { ...settings.homeAtmosphere, looks: value } : value);
            return parsed.success ? { homeAtmosphere: normalizeHomeAtmosphere(parsed.data) } : null;
        },
    };
}

export function atmosphereFieldStorageBinding(anchor: string): SettingStorageBinding {
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    if (!declaration) throw new Error('Atmosphere setting is undeclared');
    return { scope: 'account', kind: 'owner', access: 'read_write',
        read: settings => readBuiltInAccountSettingValueV1(declaration, settings),
        parse: value => parseBuiltInAccountSettingValueV1(declaration, value),
        mutate: (settings, value) => buildHomeAtmosphereControlMutation(settings, anchor, value),
    };
}

/** The one way a user picture enters this device's store (the Look picker and the Settings Action). */
export async function storeUserAtmospherePicture(data: Blob | string): Promise<string> {
    const { pictureStore } = await import('./pictureStore');
    const localId = randomUUID();
    await pictureStore.put({ localId, kind: 'user', data: await pictureStore.prepare(data) });
    return localId;
}

/** Acquisition returns bytes on both web and native; a remote URL is never treated as a native file URI. */
export async function invokeAtmospherePictureOperation(operation: 'add' | 'remove', context: SettingOperationContext): Promise<SettingOperationResult> {
    const input = context.input;
    if (input?.kind !== (operation === 'add' ? 'atmosphere_picture_add' : 'atmosphere_picture_remove')) {
        return { status: 'unavailable', reason: 'picture_operation_input_required' };
    }
    if (!context.isCurrent()) return { status: 'cancelled' };
    const { pictureStore } = await import('./pictureStore');
    if (input?.kind === 'atmosphere_picture_add') {
        let data: Blob | string;
        if (input.source.kind === 'url') {
            const response = await fetch(input.source.url, { signal: context.signal });
            if (!response.ok) return { status: 'unavailable', reason: 'picture_download_failed' };
            data = await response.blob();
        } else {
            const read = context.services?.readAtmospherePictureFile;
            if (!read) return { status: 'unavailable', reason: 'picture_file_transport_unavailable' };
            const result = await read(input.source, context.signal);
            if (!result.success) return { status: 'unavailable', reason: 'picture_file_read_failed' };
            // readFile's established contract is base64 binary bytes, not UTF-8 text.
            data = `data:application/octet-stream;base64,${result.content}`;
        }
        if (!context.isCurrent()) return { status: 'cancelled' };
        const localId = await storeUserAtmospherePicture(data);
        if (!context.isCurrent()) return { status: 'cancelled' };
        await context.mutateSettings(settings => ({ homeAtmosphere: { ...settings.homeAtmosphere, source: 'picture',
            picture: { ...settings.homeAtmosphere.picture, ref: { kind: 'user', localId } } } }));
        return { status: 'completed', value: { localId } };
    }
    if (input?.kind === 'atmosphere_picture_remove') {
        const existing = await pictureStore.get(input.localId);
        if (!context.isCurrent()) return { status: 'cancelled' };
        if (!existing || existing.kind !== 'user') return { status: 'unavailable', reason: 'user_picture_not_found' };
        await pictureStore.remove(input.localId);
        // Synced references remain authored intent; devices without bytes use the canonical default fallback.
        return { status: 'completed', value: { localId: input.localId } };
    }
    return { status: 'unavailable', reason: 'picture_operation_input_required' };
}
