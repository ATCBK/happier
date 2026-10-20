import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { LocalSettings } from '../domains/settings/localSettings';
import { settingsDefaults, type Settings } from '../domains/settings/settings';
import { getStorage } from '../domains/state/storageStore';
import type { StorageState } from './types';

// Shared presentation reads the existing store without importing command hooks.
export function useSettings(): Settings {
  return getStorage()(useShallow((state) => state.settings ?? settingsDefaults));
}

/** Subscribe to a settings-domain projection while retaining unchanged selected fields. */
export function useSettingsSelector<T>(selector: (settings: Settings) => T): T {
  const selectState = React.useMemo(() => {
    let previous: { settings: Settings; value: T } | null = null;
    return (state: StorageState): T => {
      const settings = state.settings ?? settingsDefaults;
      if (!previous || previous.settings !== settings) {
        previous = { settings, value: selector(settings) };
      }
      return previous.value;
    };
  }, [selector]);
  return getStorage()(useShallow(selectState));
}

export function useSettingsVersion(): number | null {
  return getStorage()((state) => state.settingsVersion);
}

export function useSetting<K extends keyof Settings>(name: K): Settings[K] {
  return getStorage()(useShallow((state) => state.settings?.[name] ?? settingsDefaults[name]));
}

export function useLocalSettings(): LocalSettings {
  return getStorage()(useShallow((state) => state.localSettings));
}

export function useLocalSetting<K extends keyof LocalSettings>(name: K): LocalSettings[K] {
  return getStorage()(useShallow((state) => state.localSettings[name]));
}
