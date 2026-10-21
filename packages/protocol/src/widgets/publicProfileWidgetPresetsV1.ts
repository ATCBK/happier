import type { WidgetSizeV1 } from './widgetPresentationV1.js';
import type { PublicProfileLayoutV1 } from './widgetPublicSnapshotV1.js';
import type { BuiltinUsagePublicPresentationV1 } from './builtinWidgetDescriptorV1.js';

/**
 * Starting compositions for the public page (PP-3): plain data mixed with at most three planet-art
 * blocks. Editorial data only: a person may still place whatever they like, and choosing a preset
 * never changes which facts are public.
 */
export const PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1 = ['minimal', 'dataRich', 'story'] as const;
export type PublicProfileLayoutPresetIdV1 = typeof PUBLIC_PROFILE_LAYOUT_PRESET_IDS_V1[number];

type Placement = readonly [id: string, size: WidgetSizeV1, presentation: BuiltinUsagePublicPresentationV1];
const sky = { kind: 'usage', widgetId: 'usage_rhythm', inputs: { style: 'sky' } } as const satisfies BuiltinUsagePublicPresentationV1;
const crew = { kind: 'usage', widgetId: 'usage_breakdowns', inputs: { style: 'crew' } } as const satisfies BuiltinUsagePublicPresentationV1;
const planet = { kind: 'usage', widgetId: 'usage_planet', inputs: {} } as const satisfies BuiltinUsagePublicPresentationV1;
const orbit = { kind: 'usage', widgetId: 'usage_orbit', inputs: {} } as const satisfies BuiltinUsagePublicPresentationV1;
const shipped = { kind: 'usage', widgetId: 'usage_outcomes', inputs: { style: 'shipped' } } as const satisfies BuiltinUsagePublicPresentationV1;

const PRESETS: Readonly<Record<PublicProfileLayoutPresetIdV1, readonly Placement[]>> = {
  minimal: [['days', 'full', sky], ['crew', 'medium', crew], ['planet', 'medium', planet]],
  dataRich: [['days', 'full', sky], ['crew', 'medium', crew], ['shipped', 'medium', shipped], ['orbit', 'wide', orbit]],
  story: [['planet', 'medium', planet], ['shipped', 'medium', shipped], ['days', 'full', sky], ['orbit', 'medium', orbit], ['crew', 'medium', crew]],
};

/** Titles are reviewed static text; the host supplies them in the person's language. */
export function createPublicProfilePresetLayoutV1(id: PublicProfileLayoutPresetIdV1,
  host: Readonly<{ title: (presentation: BuiltinUsagePublicPresentationV1) => string | undefined }>): PublicProfileLayoutV1 {
  return { v: 1, items: PRESETS[id].map(([itemId, size, presentation]) => {
    const title = host.title(presentation);
    return { kind: 'widget', id: itemId, size, frameStyle: 'plain', presentation, ...(title ? { title } : {}) };
  }) };
}
