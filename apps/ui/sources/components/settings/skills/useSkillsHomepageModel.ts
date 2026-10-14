import * as React from 'react';
import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { useRegistrySuggestions } from '@/registries/useRegistrySuggestions';
import { buildSkillsReach, resolveSkillsPresent } from './skillsCollectionModel';
import { useSkillsNeedsALook } from './status/useSkillsNeedsALook';
import { useSkillsFirstRun } from './firstRun/useSkillsFirstRun';

/** The homepage's data model supplies recommendation rows for the owning UI composition. */
export function useSkillsHomepageModel(library: SkillsLibrary, machines: readonly ReachMachine[]) {
    const registryShelf = useRegistrySuggestions('skill');
    const reach = React.useMemo(() => buildSkillsReach(library.items, machines), [library.items, machines]);
    const needs = useSkillsNeedsALook(library, machines);
    const { firstVisit } = useSkillsFirstRun(library.items);
    const present = React.useMemo(() => resolveSkillsPresent({ items: library.items, reach, needs: needs.length, firstVisit }),
        [firstVisit, library.items, needs.length, reach]);
    return { reach, needs, firstVisit, present, registryShelf };
}
