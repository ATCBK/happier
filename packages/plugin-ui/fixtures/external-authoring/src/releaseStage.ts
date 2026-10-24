import {
  admitPluginListFilterFieldV1,
  admitPluginListFilterFieldValueV1,
  compileEntityListFilterV1,
  createPluginListFilterFieldRegistryV1,
  type PluginListFilterFactsV1,
  type PluginListFilterSelectionV1,
} from '@happier-dev/plugin-ui/components';

const declaration = { id: 'release-stage', title: 'Release stage', source: { factKey: 'releaseStage' },
  value: { kind: 'set' } } as const;
const admitted = admitPluginListFilterFieldV1({ pluginId: 'fixture.external-authoring', field: declaration,
  factKeys: new Set(['releaseStage']) });
if (admitted.kind !== 'admitted') throw new Error('The authored release-stage declaration is invalid');
export const externalReleaseStageField = admitted.field;

export function externalReleaseStageSelection(stage?: string): PluginListFilterSelectionV1 {
  return stage === undefined ? {} : { extensions: { [externalReleaseStageField.id]: { kind: 'set', include: [stage], exclude: [] } } };
}

/** Plugin-owned input ingress; evaluation never asks the plugin or host to acquire a value. */
export function admitExternalReleaseStage(stage: unknown): PluginListFilterFactsV1 {
  const value = admitPluginListFilterFieldValueV1(declaration, stage);
  return value.kind === 'available' ? { extensions: { [externalReleaseStageField.id]: value.value } } : {};
}

export function compileExternalReleaseStageFilter(selection: PluginListFilterSelectionV1, current = true) {
  return compileEntityListFilterV1(createPluginListFilterFieldRegistryV1<PluginListFilterSelectionV1, PluginListFilterFactsV1>(
    current ? [externalReleaseStageField] : []), selection);
}

export const externalReleaseReviews = Object.freeze([
  Object.freeze({ id: 'current', title: 'Current review', ...admitExternalReleaseStage('reviewing') }),
  Object.freeze({ id: 'terminal', title: 'Terminal review', ...admitExternalReleaseStage('blocked') }),
  Object.freeze({ id: 'release', title: 'Release review', ...admitExternalReleaseStage('ready') }),
]);
