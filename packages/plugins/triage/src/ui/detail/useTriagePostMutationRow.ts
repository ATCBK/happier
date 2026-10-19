import * as React from 'react';
import { usePluginHostApi } from '@happier-dev/plugin-ui';

import type { TriageListLaneV1, TriageListRowV1 } from '../../projection/listWindow.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { deriveTriageDetailMountInstanceKey } from './mountKey.js';
import { reobserveTriagePostMutationRow } from './postMutationReobservation.js';

/** The shell supplies this one selected-detail snapshot to its host band and source body. */
export function useTriagePostMutationRow(
  windowRow: TriageListRowV1 | null,
  lanes: readonly TriageListLaneV1[],
) {
  const hostApi = usePluginHostApi();
  const selectedFromWindow = React.useMemo(
    () => windowRow === null ? null : readTriageSelectedObservationV1(windowRow),
    [windowRow],
  );
  const ownerKey = windowRow === null || selectedFromWindow === null
    ? null
    : deriveTriageDetailMountInstanceKey(windowRow.entryRef, selectedFromWindow.sourceInstanceId);
  const [state, setState] = React.useState<Readonly<{
    ownerKey: string | null;
    generation: number;
    row: TriageListRowV1 | null;
  }>>({ ownerKey, generation: 0, row: null });
  // Retire A before even one render can combine B's selection with A's observation.
  if (state.ownerKey !== ownerKey) {
    setState({ ownerKey, generation: state.generation + 1, row: null });
  }
  const reobservation = React.useRef<AbortController | null>(null);
  const row = state.ownerKey === ownerKey ? state.row ?? windowRow : windowRow;
  const reobserveRow = React.useCallback(async (
    candidate: TriageListRowV1 | null,
    keepViewerFacts = false,
  ): Promise<void> => {
    const selected = candidate === null ? null : readTriageSelectedObservationV1(candidate);
    if (candidate === null || selected === null) return;
    const lifecycleGeneration = state.generation;
    reobservation.current?.abort();
    const controller = new AbortController();
    reobservation.current = controller;
    const next = await reobserveTriagePostMutationRow(hostApi, candidate, lanes, selected.sourceInstanceId, {
      signal: controller.signal,
      keepViewerFacts,
    });
    if (!controller.signal.aborted && reobservation.current === controller && next !== null) {
      setState((current) => current.ownerKey === ownerKey && current.generation === lifecycleGeneration
        ? { ...current, row: next }
        : current);
    }
    if (reobservation.current === controller) reobservation.current = null;
  }, [hostApi, lanes, ownerKey, state.generation]);
  const completePostMutation = React.useCallback(() => reobserveRow(row), [reobserveRow, row]);
  const reobserveSelection = React.useEffectEvent(() => reobserveRow(windowRow, true));
  React.useEffect(() => {
    setState((current) => current.ownerKey === ownerKey ? { ...current, row: null } : current);
    // Scans need not carry exact revision facts. The selected detail and its
    // actions share the same authoritative read used after provider changes.
    void reobserveSelection();
    return () => {
      reobservation.current?.abort();
      reobservation.current = null;
    };
  }, [ownerKey, windowRow]);
  return { row, completePostMutation };
}
