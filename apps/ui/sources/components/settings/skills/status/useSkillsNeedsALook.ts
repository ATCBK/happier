import * as React from 'react';

import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useFoundSkillsCache } from '@/sync/domains/skills/useFoundSkills';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';

import { maskedLibraryNames } from '../found/foundSkillsModel';
import { buildSkillsNeedsALook, type SkillNeedsALookEntry } from './skillStatus';

const NO_UNAVAILABLE: NonNullable<SkillsLibrary['unavailableItems']> = Object.freeze([]);

/**
 * "Needs a look" for the rail count and the homepage group: one join of the library, its unreadable
 * items and this device's Found cache (never a machine read).
 */
export function useSkillsNeedsALook(
  library: SkillsLibrary,
  machines: readonly ReachMachine[],
): readonly SkillNeedsALookEntry[] {
  const machineIds = React.useMemo(() => machines.map((machine) => machine.machineId), [machines]);
  const cache = useFoundSkillsCache(machineIds);
  const masked = React.useMemo(() => maskedLibraryNames(machines, cache), [cache, machines]);
  const unavailable = library.unavailableItems ?? NO_UNAVAILABLE;
  return React.useMemo(
    () => buildSkillsNeedsALook(library.items, unavailable, masked),
    [library.items, masked, unavailable],
  );
}
