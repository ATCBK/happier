import * as React from 'react';
import {
  Banner, Button, EmptyState, ErrorState, Form, LoadingState, Row, Select, Stack, Text,
  TextField, useExecutePluginAction, usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  TriageListScopeUnitsResultV1Schema,
  TriageSourceScopeSelectionV1Schema,
  type TriageScanContinuationV1,
  type TriageSourceScopeUnitV1,
} from '@happier-dev/triage-protocol/v1';

import { describeTriageSourceFailure } from './model.js';
import type { TriageSourceSettingsDraftEditorPropsV1 } from './surface.js';
import type { TriageSourceSettingsDraftFieldsPropsV1, TriageSourceSettingsScopeSelectionV1 } from './scopeSelection.js';

type Listing = Readonly<{
  pending: boolean;
  error: string | null;
  partial: boolean;
  nextCursor: TriageScanContinuationV1 | null;
}>;

/** One shared control; sources translate their tokens and supply only extra fields. */
export function TriageSourceScopeSelectionEditor({
  draft, busy, onSubmit, onCancel, pluginId, adapter, Fields,
}: TriageSourceSettingsDraftEditorPropsV1 & Readonly<{
  pluginId: string;
  adapter: TriageSourceSettingsScopeSelectionV1;
  Fields?: React.ComponentType<TriageSourceSettingsDraftFieldsPropsV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [initial] = React.useState(() => adapter.readSelection(draft));
  const [mode, setMode] = React.useState(initial?.kind ?? 'all');
  const [ids, setIds] = React.useState<readonly string[]>(initial?.kind === 'selected' ? initial.unitIds : []);
  const [editedDraft, setEditedDraft] = React.useState(draft);
  const [queryDraft, setQueryDraft] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [known, setKnown] = React.useState<ReadonlyMap<string, TriageSourceScopeUnitV1>>(new Map());
  const [visibleIds, setVisibleIds] = React.useState<readonly string[]>([]);
  const [listing, setListing] = React.useState<Listing>({ pending: false, error: null, partial: false, nextCursor: null });
  const active = React.useRef<AbortController | null>(null);
  const action = React.useMemo(() => ({ pluginId, localId: adapter.listScopeUnitsLocalActionId }), [pluginId, adapter.listScopeUnitsLocalActionId]);
  const { execute } = useExecutePluginAction(action);

  const load = React.useCallback(async (cursor?: TriageScanContinuationV1) => {
    if (active.current !== null) return;
    const controller = new AbortController();
    active.current = controller;
    setListing((previous) => ({ ...previous, pending: true, error: null }));
    try {
      const execution = await execute({ v: 1, draft, ...(query === '' ? {} : { query }), ...(cursor === undefined ? {} : { cursor }) }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (execution.status !== 'success') {
        setListing((previous) => ({ ...previous, pending: false, error: text('plugins.triage.sourceSettings.selection.readFailed', 'The list could not be read. Try again.') }));
        return;
      }
      const parsed = TriageListScopeUnitsResultV1Schema.safeParse(execution.result);
      if (!parsed.success) {
        setListing((previous) => ({ ...previous, pending: false, error: text('plugins.triage.sourceSettings.selection.unreadable', 'This version cannot read the selection list.') }));
        return;
      }
      const result = parsed.data;
      if (result.kind === 'failed') {
        setListing((previous) => ({ ...previous, pending: false, error: describeTriageSourceFailure(result.failure, text) }));
        return;
      }
      setKnown((previous) => new Map([...previous, ...result.units.map((unit) => [unit.id, unit] as const)]));
      setVisibleIds((previous) => [...new Set([...(cursor === undefined ? [] : previous), ...result.units.map((unit) => unit.id)])]);
      setListing({
        pending: false, partial: result.status === 'partial',
        nextCursor: result.status === 'partial' ? result.nextCursor ?? null : null,
        error: result.status === 'partial' && result.failure !== undefined ? describeTriageSourceFailure(result.failure, text) : null,
      });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [draft, execute, query, text]);

  React.useEffect(() => {
    if (mode === 'selected' && initial !== null) void load();
    return () => { active.current?.abort(); active.current = null; };
  }, [initial, load, mode]);

  const selected = TriageSourceScopeSelectionV1Schema.safeParse(mode === 'all'
    ? { kind: 'all' } : { kind: 'selected', unitIds: ids });
  const units = ids.map((id) => known.get(id) ?? { id, label: id });
  const nextDraft = selected.success ? adapter.writeSelection(editedDraft, selected.data, units) : null;
  const cancel = <Button title={text('plugins.triage.sourceSettings.selection.cancel', 'Cancel')} variant="plain" size="small" disabled={busy} onPress={onCancel} />;
  if (initial === null) {
    return <ErrorState layout="line" title={text('plugins.triage.sourceSettings.selection.invalid', 'This version cannot read the saved selection.')} action={cancel} />;
  }
  const options = [...new Set([...ids, ...visibleIds])].map((id) => {
    const unit = known.get(id);
    return { value: id, label: unit?.label ?? id, ...(unit?.secondaryText === undefined ? {} : { description: unit.secondaryText }) };
  });

  return <Stack gap="medium">
    <Form.Field label={text('plugins.triage.sourceSettings.selection.include', 'Include')}>
      <Select
        label={text('plugins.triage.sourceSettings.selection.include', 'Include')}
        presentation="segmented" value={mode} disabled={busy}
        options={[
          { value: 'all', label: text('plugins.triage.sourceSettings.selection.all', 'All') },
          { value: 'selected', label: text('plugins.triage.sourceSettings.selection.selected', 'Selected…') },
        ]}
        onChange={(value) => { if (value === 'all' || value === 'selected') setMode(value); }}
      />
    </Form.Field>
    {mode === 'selected' ? <Stack gap="small">
      <Text variant="meta">{text('plugins.triage.sourceSettings.selection.count', '{count} selected', { count: ids.length })}</Text>
      <TextField label={text('plugins.triage.sourceSettings.selection.search', 'Search {units}', { units: adapter.unitLabel })}
        presentation="field" value={queryDraft} onChange={setQueryDraft} disabled={busy}
        autoCapitalize="none" autoCorrect={false}
        onSubmitEditing={() => { if (!listing.pending) setQuery(queryDraft.trim()); }} />
      <Button title={text('plugins.triage.sourceSettings.selection.searchAction', 'Search')} variant="secondary" size="small"
        disabled={busy || listing.pending} onPress={() => { if (queryDraft.trim() === query) void load(); else setQuery(queryDraft.trim()); }} />
      {listing.pending ? <LoadingState rows={2} title={text('plugins.triage.sourceSettings.selection.loading', 'Reading {units}', { units: adapter.unitLabel })} /> : null}
      {options.length > 0 ? <Select label={adapter.unitLabel} multiple value={ids} options={options} disabled={busy}
        onChange={(value) => { if (Array.isArray(value)) setIds(value.filter((id): id is string => typeof id === 'string')); }} /> : null}
      {!listing.pending && listing.error === null && options.length === 0 ? <EmptyState layout="line"
        title={text('plugins.triage.sourceSettings.selection.empty', 'No matching {units}', { units: adapter.unitLabel })}
        description={text('plugins.triage.sourceSettings.selection.emptyHelp', 'Try another search or choose All.')} /> : null}
      {listing.error !== null ? <ErrorState layout="line" title={listing.error}
        action={<Button title={text('plugins.triage.sourceSettings.tryAgain', 'Try again')} variant="secondary" size="small"
          disabled={listing.pending || busy} onPress={() => { void load(listing.nextCursor ?? undefined); }} />} /> : null}
      {listing.partial && listing.error === null ? <Banner tone="warning"
        title={text('plugins.triage.sourceSettings.selection.partial', 'More {units} may be available', { units: adapter.unitLabel })} /> : null}
      {listing.nextCursor !== null ? <Button title={text('plugins.triage.sourceSettings.selection.more', 'Load more')} variant="secondary" size="small"
        disabled={listing.pending || busy} onPress={() => { void load(listing.nextCursor ?? undefined); }} /> : null}
    </Stack> : null}
    {Fields === undefined ? null : <Fields draft={nextDraft ?? editedDraft} busy={busy} onChange={setEditedDraft} />}
    <Row gap="small">
      <Button title={text('plugins.triage.sourceSettings.selection.save', 'Save selection')} variant="primary" size="small"
        busy={busy} disabled={busy || nextDraft === null} onPress={() => { if (!busy && nextDraft !== null) void onSubmit(nextDraft); }} />
      {cancel}
    </Row>
  </Stack>;
}
