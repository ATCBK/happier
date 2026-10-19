import * as React from 'react';

import { isTouchPrimaryPointer, resolvePageRowMetrics, type PageRowMetrics, type PageRowShape } from '@/components/ui/lists/pageRowMetrics';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';

export type ResolvedItemDensity = 'comfortable' | 'cozy' | 'compact' | 'tight';

/**
 * The density a section asks for its rows (`ItemGroup density`): row height follows content, so a long
 * index-style list of single-line rows is compact while rows that carry a description keep their room.
 */
const SectionItemDensityContext = React.createContext<ResolvedItemDensity | undefined>(undefined);

export const SectionItemDensityProvider = SectionItemDensityContext.Provider;

/** A row's own density, else its section's, else the user's list-density preference. */
export function useResolvedItemDensity(explicitDensity?: ResolvedItemDensity): ResolvedItemDensity {
    return useItemDensityInputs(explicitDensity).resolved;
}

/**
 * The resolved density together with what it came from. A configuration-page row is drawn at the
 * user's preference whatever a section asks, and reads a section's `compact` as "a long single-line
 * list" (see `resolvePageRowDensityInput`), so it needs the preference and the request separately.
 */
export function useItemDensityInputs(explicitDensity?: ResolvedItemDensity): Readonly<{
    resolved: ResolvedItemDensity;
    preferred: 'comfortable' | 'cozy' | 'compact';
    /** The row or its section asked for a density; the preference did not decide it. */
    requested: boolean;
}> {
    const preferred = useLocalSetting('uiItemDensity');
    const sectionDensity = React.useContext(SectionItemDensityContext);
    const requestedDensity = explicitDensity ?? sectionDensity;
    return { resolved: requestedDensity ?? preferred, preferred, requested: requestedDensity !== undefined };
}

/** A configuration-page row's metrics at the user's density, for content that stands in for rows. */
export function usePageRowMetrics(shape: PageRowShape = 'standard'): PageRowMetrics {
    const preferred = useLocalSetting('uiItemDensity');
    return resolvePageRowMetrics({ density: preferred, shape, touch: isTouchPrimaryPointer() });
}
