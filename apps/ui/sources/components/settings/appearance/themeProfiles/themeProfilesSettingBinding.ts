import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { parseThemeProfilesLocalState } from '@/theme/profiles/themeProfilePersistence';
import { themeModeStorageBinding } from '../themeModeSettingBinding';

function readCanonicalProfiles(value: unknown) {
    const profiles = parseThemeProfilesLocalState(value).state;
    return sameStrictJsonValue(profiles, value) ? profiles : null;
}

/** Library edits preserve the selected mode and use the same persistence/runtime owner as activation. */
export const themeProfilesStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    read: local => local.themeProfiles,
    parse: value => {
        const profiles = readCanonicalProfiles(value);
        return profiles ? { success: true, value: SettingsDeclarationValueV1Schema.parse(profiles) } : { success: false };
    },
    commit: async (local, value, writeLocal, context) => {
        const profiles = readCanonicalProfiles(value);
        if (!profiles) return;
        await themeModeStorageBinding.commit(local, SettingsDeclarationValueV1Schema.parse({
            themePreference: local.themePreference, themeProfiles: profiles,
        }), writeLocal, context);
    },
} satisfies SettingStorageBinding;
