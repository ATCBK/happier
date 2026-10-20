import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { z } from 'zod/mini';
import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE, parseThemeProfilesLocalState } from '@/theme/profiles/themeProfilePersistence';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

export const THEME_MODE_CHOICES = ['adaptive', 'light', 'dark'] as const;
type ThemeModeChoice = typeof THEME_MODE_CHOICES[number];

const isThemeMode = (value: unknown): value is ThemeModeChoice =>
    value === 'adaptive' || value === 'light' || value === 'dark';

const compoundSelectionSchema = z.strictObject({
    themePreference: z.enum(THEME_MODE_CHOICES),
    themeProfiles: z.unknown(),
});
const activationSchema = z.strictObject({
    activation: z.strictObject({
        profileId: z.nullable(z.string()),
        profileMode: z.optional(z.enum(['light', 'dark', 'all'])),
        nextThemePreference: z.optional(z.enum(THEME_MODE_CHOICES)),
        profile: z.optional(z.unknown()),
    }),
    forceAnimate: z.optional(z.boolean()),
    reduceMotion: z.optional(z.boolean()),
});

function readThemeSelectionIntent(value: unknown) {
    if (isThemeMode(value)) return value;
    const activation = activationSchema.safeParse(value);
    if (activation.success) {
        const { profile, ...selection } = activation.data.activation;
        if (profile === undefined) return { ...activation.data, activation: selection };
        const profiles = parseThemeProfilesLocalState({ profiles: [profile], activeProfileIds: { light: null, dark: null } }).state.profiles;
        const canonical = profiles[0];
        if (profiles.length !== 1 || !canonical || !sameStrictJsonValue(canonical, profile)) return null;
        return { ...activation.data, activation: { ...selection, profile: canonical } };
    }
    const parsed = compoundSelectionSchema.safeParse(value);
    if (!parsed.success) return null;
    const profiles = parseThemeProfilesLocalState(parsed.data.themeProfiles).state;
    // The persistence parser owns profile validity. Mutation input must already be canonical;
    // sanitizing it here could silently discard a profile or an unknown nested field.
    if (!sameStrictJsonValue(profiles, parsed.data.themeProfiles)) return null;
    return { themePreference: parsed.data.themePreference, themeProfiles: profiles };
}

/**
 * The theme mode as a declared device setting: Actions write it through the theme owner, which
 * also applies the running theme and status bar and keeps the theme each mode uses — a raw
 * `themePreference` write would store a choice the screen does not show.
 */
export const themeModeStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    allowedValues: THEME_MODE_CHOICES,
    read: local => isThemeMode(local.themePreference) ? local.themePreference : 'adaptive',
    parse: value => {
        const selection = readThemeSelectionIntent(value);
        const parsed = SettingsDeclarationValueV1Schema.safeParse(selection);
        return selection !== null && parsed.success ? { success: true, value: parsed.data } : { success: false };
    },
    commit: async (local, value, writeLocal, context) => {
        const selection = readThemeSelectionIntent(value);
        if (selection === null) return;
        const persist = (delta: Parameters<typeof writeLocal>[0]) => {
            throwIfAborted(context?.signal);
            if (context?.isCurrent() === false) throw Object.assign(new Error('setting_not_bound'), { code: 'setting_not_bound' });
            writeLocal(delta);
        };
        if (typeof selection !== 'string' && 'activation' in selection) {
            const { activateThemeProfileFromSettingsScreen } = await import('./themeProfiles/themeProfileScreenUtils');
            await activateThemeProfileFromSettingsScreen({
                ...selection.activation,
                readLocalSettings: context?.readLocalSettings ?? (() => local),
                writeLocalSettings: persist,
                forceAnimate: selection.forceAnimate,
                reduceMotion: readReducedMotionPreference() || selection.reduceMotion === true,
            });
            return;
        }
        // The owner carries the runtime theme and status-bar modules; load them only when a write happens.
        const { commitThemeSelection } = await import('@/theme/profiles/themeProfileRuntime');
        await commitThemeSelection({
            currentPreference: isThemeMode(local.themePreference) ? local.themePreference : 'adaptive',
            nextPreference: typeof selection === 'string' ? selection : selection.themePreference,
            nextThemeProfiles: typeof selection === 'string' ? local.themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE : selection.themeProfiles,
            reduceMotion: readReducedMotionPreference(),
            writeLocal: persist,
        });
    },
};
