import type {
  TriageSourceInstanceDraftV1,
  TriageSourceScopeSelectionV1,
  TriageSourceScopeUnitV1,
} from '@happier-dev/triage-protocol/v1';

/** Source-owned token translation; selection rendering and lifecycle stay shared. */
export type TriageSourceSettingsScopeSelectionV1 = Readonly<{
  unitLabel: string;
  listScopeUnitsLocalActionId: string;
  readSelection: (draft: TriageSourceInstanceDraftV1) => TriageSourceScopeSelectionV1 | null;
  /** Preserve the source's other configuration. Null means it cannot encode this selection. */
  writeSelection: (
    draft: TriageSourceInstanceDraftV1,
    selection: TriageSourceScopeSelectionV1,
    units: readonly TriageSourceScopeUnitV1[],
  ) => TriageSourceInstanceDraftV1 | null;
}>;

/** Optional extra source fields inside the shared editor, with one shared Save/Cancel. */
export type TriageSourceSettingsDraftFieldsPropsV1 = Readonly<{
  draft: TriageSourceInstanceDraftV1;
  busy: boolean;
  onChange: (draft: TriageSourceInstanceDraftV1) => void;
}>;
