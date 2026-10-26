import { resolveCollectionSpacesV1, selectCollectionSpaceV1, type CollectionEntityKindV1, type CollectionSpacesV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { accountSettingsScopeKeySuffix, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';

/** Captured authority and the existing device-settings writer serve both mounted navigation and Actions. */
export async function writeCollectionSpaceSelectionV1(input: Readonly<{
    scope: AccountSettingsScope | null | undefined;
    entityKind: CollectionEntityKindV1;
    spaceId: string;
    isCurrent(): boolean;
    readSettings(): Readonly<{ collectionSpacesV1: CollectionSpacesV1 }> | Promise<Readonly<{ collectionSpacesV1: CollectionSpacesV1 }>>;
    readLocalSettings(): LocalSettings;
    writeLocalSettings(delta: Partial<LocalSettings>): void;
}>): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: 'setting_not_bound' | 'space_not_found' }>> {
    if (!input.scope || !input.isCurrent()) return { ok: false, reason: 'setting_not_bound' };
    const settings = await input.readSettings();
    if (!input.isCurrent()) return { ok: false, reason: 'setting_not_bound' };
    if (!resolveCollectionSpacesV1(settings.collectionSpacesV1, input.entityKind).some(space => space.id === input.spaceId)) return { ok: false, reason: 'space_not_found' };
    const local = input.readLocalSettings();
    const selected = selectCollectionSpaceV1(local.collectionSpaceV1, accountSettingsScopeKeySuffix(input.scope), input.entityKind, input.spaceId);
    if (selected !== local.collectionSpaceV1) input.writeLocalSettings({ collectionSpaceV1: selected as typeof local.collectionSpaceV1 });
    return { ok: true };
}
