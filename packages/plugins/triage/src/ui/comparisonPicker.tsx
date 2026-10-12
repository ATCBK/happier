import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { readInputTypePickerLaunchInput } from '@happier-dev/plugin-sdk/actions';
import { BrandMark, Button, EmptyState, FreshnessLine, List, Stack, Status, TextField, defineUiSurface,
  usePluginHostApi, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { projectTriagePickerCorpusFacts } from '../composer/pickerFacts.js';
import { buildTriagePickerView } from '../composer/pickerModel.js';
import { deriveTriageComposerEntryAttachmentKey } from '../composer/attachmentValue.js';
import type { TriageListRowV1 } from '../projection/listWindow.js';
import { useTriageListWindow } from './window/useTriageListWindow.js';
import { readTriageSelectedObservationV1 } from './window/selectedObservation.js';
import { useTriageRefreshEligibilityNowV1 } from './window/refreshEligibilityClock.js';
import { useTriageEntryDetail } from './detail/useTriageEntryDetail.js';
import { readTriageSourceGetOperationV1, resolveTriageSourceWorkflowSubjectV1 } from './detail/sourceSurface.js';
import { readTriageComparisonSource } from './detail/readComparison.js';
import { resolvePickerStateLabel, resolvePacingReasonDescription } from '../composer/entryPicker.js';

/** The source and completion are host-owned; selecting a row admits only its current observing connection. */
function ComparisonSelection(props: Readonly<{ row: TriageListRowV1 }>) {
  const host = usePluginHostApi();
  const context = useSurfaceContext();
  const selected = readTriageSelectedObservationV1(props.row);
  const selection = React.useMemo(() => selected ? { sectionId: null, entryRef: props.row.entryRef,
    sourceInstanceId: selected.sourceInstanceId } : null, [props.row.entryRef, selected?.sourceInstanceId]);
  const detailSource = React.useMemo(() => selection && selected
    ? { selection, observation: selected.observation } : null, [props.row, selection]);
  const detail = useTriageEntryDetail(detailSource);
  const operation = readTriageSourceGetOperationV1(context, props.row.entryRef.source);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const attempt = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { attempt.current?.abort(); }, []);
  const choose = async () => {
    if (attempt.current || detail?.kind !== 'ready' || !operation || !selected) return;
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true);
    setFailed(false);
    try {
      const comparison = await readTriageComparisonSource({ host, entryRef: props.row.entryRef,
        read: { operation, instance: detail.input.instance }, lastKnownLocator: selected.observation.locator,
        signal: controller.signal });
      if (controller.signal.aborted) return;
      if (comparison?.kind !== 'pullRequest') { setFailed(true); return; }
      await host.settleEphemeralInput({ kind: 'completed', input: comparison }, { signal: controller.signal });
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      attempt.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return <Stack gap="small">
    <Button titleKey="plugins.triage.comparison.choose" title="Choose comparison" variant="primary" busy={busy}
      disabled={detail?.kind !== 'ready' || !operation || !selected} onPress={choose} />
    {failed || detail && detail.kind !== 'ready' && detail.kind !== 'reading' || !operation ? <Status tone="warning"
      labelKey="plugins.triage.surface.comparisonUnavailable" label="This source cannot open a comparison for this pull request." /> : null}
  </Stack>;
}

/** A transient single-value consumer of the same corpus window as the existing Composer picker. */
function TriageComparisonPicker(context: RenderContext) {
  const surface = useSurfaceContext();
  const text = usePluginTranslation();
  const window = useTriageListWindow();
  const nowMs = useTriageRefreshEligibilityNowV1(window.snapshot.refreshBlocked);
  const [query, setQuery] = React.useState('');
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const launch = readInputTypePickerLaunchInput(context.launchInput);
  const facts = projectTriagePickerCorpusFacts({ snapshot: window.snapshot, nowMs });
  const pullRequests = facts.rows.filter(row => resolveTriageSourceWorkflowSubjectV1(surface.targetedContributions, row.entryRef) === 'pullRequest');
  const view = buildTriagePickerView({ facts: { ...facts, rows: pullRequests }, query, attached: [] });
  const row = view.rows.some(candidate => candidate.id === selectedKey)
    ? window.snapshot.window?.rows.find(candidate => deriveTriageComposerEntryAttachmentKey(candidate.entryRef) === selectedKey) : undefined;
  if (launch?.inputType.pluginId !== TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1
    || launch.inputType.localId !== 'pull-request-comparison' || launch.semantic !== 'scmPullRequestComparison') return null;
  return <Stack gap="small">
    <TextField labelKey="plugins.triage.comparison.search" label="Search pull requests" presentation="field" value={query} onChange={setQuery} />
    <Button titleKey="plugins.triage.surface.refresh" title="Refresh" variant="plain" busy={view.refresh.kind === 'running'}
      disabled={view.refresh.kind !== 'available'} onPress={() => window.refresh('manual')} />
    {view.state.kind === 'stale' ? <FreshnessLine asOf={view.state.lastMaterializedAtMs}
      reason={resolvePickerStateLabel(text, view.state.kind)} /> : null}
    {view.health.length > 0 ? <Status tone="warning" label={view.health.map(item => item.displayName).join(', ')} /> : null}
    {view.refresh.kind === 'blockedUntil' ? <Status tone="warning"
      label={resolvePacingReasonDescription(text, view.refresh.reason)} /> : null}
    <List accessibilityLabelKey="plugins.triage.comparison.title" accessibilityLabel="Pull request" density="compact"
      items={view.rows} keyForItem={item => item.id}
      renderItem={item => <List.Item title={item.title} subtitle={item.scopeLabel}
        accessibilityLabel={item.title} accessibilityHint={item.scopeLabel}
        icon={<BrandMark pluginId={item.entryRef.source.pluginId} size="small" externallyLabelled />}
        onPress={() => setSelectedKey(item.id)} selected={item.id === selectedKey} />}
      empty={<EmptyState title={view.state.kind === 'empty'
        ? text('plugins.triage.comparison.empty', 'No pull requests to compare') : resolvePickerStateLabel(text, view.state.kind)}
        descriptionKey="plugins.triage.picker.refreshRemedy" description="Refresh to read your connected sources." />} />
    {row && resolveTriageSourceWorkflowSubjectV1(surface.targetedContributions, row.entryRef) === 'pullRequest'
      ? <ComparisonSelection key={`${selectedKey}:${row.selected.kind === 'selected' ? row.selected.sourceInstanceId : ''}`} row={row} /> : null}
    {window.snapshot.loadMore?.kind === 'available' ? <Button titleKey="plugins.triage.surface.loadMore" title="Load more"
      variant="plain" onPress={() => window.loadMore()} /> : null}
  </Stack>;
}

export const renderSurface = defineUiSurface(TriageComparisonPicker);
