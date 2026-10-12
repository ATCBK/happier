import * as React from 'react';
import type {
  HomeAtmosphere,
  ProjectAtmosphere,
} from '@happier-dev/protocol/account/settings/accountSettings';
import { useSetting } from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { normalizeHomeAtmosphere } from '../atmosphereSettings';

/**
 * What the Look panel edits: the value it shows and one write that applies an edit (from
 * `atmosphereEdits`) to the latest stored value. Home and new session write the Account's Home
 * atmosphere; a project screen passes its project override's editor instead (the project owner).
 */
export type AtmosphereEditor = Readonly<{
  value: ProjectAtmosphere;
  update(edit: (current: ProjectAtmosphere) => ProjectAtmosphere): void;
  sameAsHome?: boolean;
  resetToHome?: () => void;
}>;

/** Home's editor. Edits re-apply to the latest Account snapshot, so concurrent writes are not lost. */
export function useHomeAtmosphereEditor(): AtmosphereEditor &
  Readonly<{
    value: HomeAtmosphere;
    updateHome(edit: (current: HomeAtmosphere) => HomeAtmosphere): void;
  }> {
  const value = useSetting('homeAtmosphere');
  const apply = useApplySettings();
  return React.useMemo(() => {
    const updateHome = (edit: (current: HomeAtmosphere) => HomeAtmosphere) =>
      apply((current) => ({
        homeAtmosphere: normalizeHomeAtmosphere(edit(current.homeAtmosphere)),
      }));
    return {
      value,
      updateHome,
      update: (edit) =>
        updateHome((current) => ({ ...current, ...edit(current) })),
    };
  }, [apply, value]);
}
