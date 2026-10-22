import type { UiView } from '@happier-dev/plugin-sdk/ui';

/** The installed View declares symbolic shared facts, independently of its executable private body. */
export const publicSnapshotTemplate = { kind: 'declarative', document: { version: 1, root: {
  kind: 'metric', label: 'Shared active days', data: { kind: 'value', value: { kind: 'public_profile' } },
  value: { path: ['snapshot', 'facts', 'activeDays'], type: 'number' },
} } } satisfies NonNullable<Extract<UiView, { container: 'widget' }>['publicPresentation']>;
