import { localSettingsDefaults, localSettingsParse, type LocalSettings } from '../settings/localSettings';
import { purchasesDefaults, purchasesParse, type Purchases } from '../purchases/purchases';
import type { Settings } from '../settings/settings';
import { loadHomeViewState } from '../server/serverProfiles';
import { stripServerSelectionSettingsProjection } from '../server/selection/serverSelectionSettingsAdapter';
import { getPersistenceStorage } from './persistenceStorage';

type LocalAttentionSettingsMutationListener = () => void;
const localAttentionSettingsMutationListeners = new Set<LocalAttentionSettingsMutationListener>();
let localAttentionSettingsMutationToken = 0;

export function subscribeLocalAttentionSettingsMutations(listener: LocalAttentionSettingsMutationListener): () => void {
    localAttentionSettingsMutationListeners.add(listener);
    return () => localAttentionSettingsMutationListeners.delete(listener);
}

/**
 * In-process generation of this device's attention/preview/quiet-hours policy.
 *
 * A reconciliation that captured the policy also captures this value, so a
 * later step can tell synchronously that the policy moved under it instead of
 * re-reading a Home over the network. It is deliberately not persisted and
 * carries no meaning across restarts: a restart re-reads the current policy
 * anyway, so no second persisted generation exists to drift.
 */
export function readLocalAttentionSettingsMutationToken(): number {
    return localAttentionSettingsMutationToken;
}

function settingsKey(): string {
    return 'settings';
}

function localSettingsKey(): string {
    return 'local-settings';
}

function purchasesKey(): string {
    return 'purchases';
}

export function loadSettings(): { settings: unknown; version: number | null } {
    const mmkv = getPersistenceStorage();
    const settings = mmkv.getString(settingsKey());
    if (settings) {
        try {
            const parsed = JSON.parse(settings);
            const version = typeof parsed.version === 'number' ? parsed.version : null;
            return { settings: parsed.settings, version };
        } catch (e) {
            console.error('Failed to parse settings', e);
            return { settings: {}, version: null };
        }
    }
    return { settings: {}, version: null };
}

export function saveSettings(settings: Settings, version: number) {
    const mmkv = getPersistenceStorage();
    const persistedSettings = loadHomeViewState()
        ? stripServerSelectionSettingsProjection(settings)
        : settings;
    mmkv.set(settingsKey(), JSON.stringify({ settings: persistedSettings, version }));
}

/** Retain the stored value only for owner-level startup healing of theme profiles. */
export function loadLocalSettingsSnapshot(): Readonly<{ settings: LocalSettings; storedValue: unknown }> {
    try {
        const localSettings = getPersistenceStorage().getString(localSettingsKey());
        if (localSettings) {
            const storedValue: unknown = JSON.parse(localSettings);
            return { settings: localSettingsParse(storedValue), storedValue };
        }
    } catch (e) {
        console.error('Failed to parse local settings', e);
    }
    return { settings: { ...localSettingsDefaults }, storedValue: undefined };
}

export function loadLocalSettings(): LocalSettings {
    return loadLocalSettingsSnapshot().settings;
}

export function saveLocalSettings(settings: LocalSettings) {
    const mmkv = getPersistenceStorage();
    const previous = loadLocalSettings();
    mmkv.set(localSettingsKey(), JSON.stringify(settings));
    if (
        previous.deviceRemoteAlertsEnabled !== settings.deviceRemoteAlertsEnabled
        || JSON.stringify(previous.attentionDeviceOverridesV1) !== JSON.stringify(settings.attentionDeviceOverridesV1)
    ) {
        localAttentionSettingsMutationToken += 1;
        for (const listener of [...localAttentionSettingsMutationListeners]) {
            try { listener(); } catch { /* local settings persistence remains authoritative */ }
        }
    }
}

export function loadPurchases(): Purchases {
    const mmkv = getPersistenceStorage();
    const purchases = mmkv.getString(purchasesKey());
    if (purchases) {
        try {
            const parsed = JSON.parse(purchases);
            return purchasesParse(parsed);
        } catch (e) {
            console.error('Failed to parse purchases', e);
            return { ...purchasesDefaults };
        }
    }
    return { ...purchasesDefaults };
}

export function savePurchases(purchases: Purchases) {
    const mmkv = getPersistenceStorage();
    mmkv.set(purchasesKey(), JSON.stringify(purchases));
}
