import * as React from 'react';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { SkillListItemV1, SkillUnavailableItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useArtifacts } from '@/sync/domains/state/storage';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { refreshPromptLibraryCatalog } from '@/sync/engine/settings/promptLibraryCatalogEngine';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

export type SkillsLibraryStatus = 'loading' | 'ready' | 'unavailable';
export type SkillsLibrary = Readonly<{
  scope: Readonly<{ serverId: string; accountId: string }> | null;
  /** `unavailable`: the read failed; never rendered as an empty library (D28). */
  status: SkillsLibraryStatus;
  /** Last-known items, kept through a refresh and through a failed refresh. */
  items: readonly SkillListItemV1[];
  /** Known identities with unreadable content; no description, trust or cost is fabricated. */
  unavailableItems?: readonly SkillUnavailableItemV1[];
  /** Items are from an earlier read while a newer one is pending or failed. */
  stale: boolean;
  errorCode: string | null;
  /** Oldest retained use, or unknown when the usage row is empty/unreadable. */
  usageObservedSince: number | null;
  retry: () => void;
}>;

type Snapshot = Readonly<{ items: readonly SkillListItemV1[]; unavailableItems: readonly SkillUnavailableItemV1[]; key: string; usageObservedSince: number | null }>;
/** Last-known `skills.list` result per Account, so reopening the page never flashes empty. */
const lastKnown = new Map<string, Snapshot>();
// Only active identical observations are joined; no response or extra cache survives settlement.
const readsInFlight = new Map<string, Promise<ActionExecuteResult>>();
function readSkills(key: string, scope: NonNullable<SkillsLibrary['scope']>) {
  const existing = readsInFlight.get(key);
  if (existing) return existing;
  // The front door captures the exact Account lifetime, independent of either mounted observer.
  const execute = createFrontDoorActionExecute();
  const pending = Promise.resolve().then(() => execute('skills.list', {}, {
    surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    serverId: scope.serverId, expectedAccountId: scope.accountId,
  })).finally(() => { if (readsInFlight.get(key) === pending) readsInFlight.delete(key); });
  readsInFlight.set(key, pending);
  return pending;
}
const emptyItems: readonly SkillListItemV1[] = Object.freeze([]);
const emptyUnavailableItems: readonly SkillUnavailableItemV1[] = Object.freeze([]);

/** Reuse the previous row object for an unchanged item, so memoised rows keep their identity. */
function reconcile<T extends Readonly<{ skillId: string }>>(
  previous: readonly T[],
  next: readonly T[],
): readonly T[] {
  const byId = new Map(previous.map((item) => [item.skillId, item]));
  let changed = previous.length !== next.length;
  const merged = next.map((item, index) => {
    const prior = byId.get(item.skillId);
    const kept =
      prior && JSON.stringify(prior) === JSON.stringify(item) ? prior : item;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? merged : previous;
}

/**
 * The Skills library as `skills.list` returns it, through the mounted Action executor (one owner for
 * the list, the same projection agents and the CLI read). It re-reads when a skill Artifact or the
 * `skill-rules` row changes, keeps the last-known list while reading, and reports a failed read as
 * `unavailable` instead of an empty library.
 */
export function useSkillsLibrary(): SkillsLibrary {
  const scope = useAccountSettingsScope();
  const scopeKey = scope ? `${scope.serverId}:${scope.accountId}` : null;
  const { binding, ready } = useMountedActionExecution(scope?.serverId ?? null);
  const artifacts = useArtifacts();
  const rules = usePromptLibraryCatalogValue('skill-rules');
  const usage = usePromptLibraryCatalogValue('skill-usage');
  // What the list depends on: each skill bundle's revision and the rules row's revision.
  const sourceKey = React.useMemo(() => {
    const skills = artifacts
      .filter((artifact) => {
        const header = artifact.header as
          | Readonly<Record<string, unknown>>
          | null
          | undefined;
        return (
          header?.kind === 'prompt_bundle.v2' &&
          header.bundleSchemaId === 'skills.skill_md_v1'
        );
      })
      .map(
        (artifact) =>
          `${artifact.id}@${artifact.headerVersion}:${artifact.bodyVersion ?? 0}`,
      )
      .sort();
    return `${rules.revision}|${usage.status}:${usage.revision}|${skills.join(',')}`;
  }, [artifacts, rules.revision, usage.status, usage.revision]);
  const [state, setState] = React.useState<{
    scopeKey: string | null;
    snapshot: Snapshot | null;
    status: SkillsLibraryStatus;
    errorCode: string | null;
  }>(() => ({
    scopeKey,
    snapshot: scopeKey ? (lastKnown.get(scopeKey) ?? null) : null,
    status: 'loading',
    errorCode: null,
  }));
  const [attempt, setAttempt] = React.useState(0);
  const retry = React.useCallback(() => {
    if (scope) fireAndForget(refreshPromptLibraryCatalog(scope), { tag: 'skillsLibrary.retry' });
    setAttempt((value) => value + 1);
  }, [scope]);
  // skills.list refreshes unavailable rules through this same catalog owner.
  // Starting it on failure would reopen loading and cancel its own invocation.
  const canRead =
    Boolean(scopeKey) && ready && rules.status === 'ready';
  const readKey = JSON.stringify([scopeKey, binding?.revision, sourceKey, attempt]);

  React.useEffect(() => {
    if (!scopeKey || !scope || !canRead) return;
    const controller = new AbortController();
    setState((prev) =>
      prev.scopeKey === scopeKey && prev.status === 'loading'
        ? prev
        : { ...prev, scopeKey, status: 'loading' },
    );
    void (async () => {
      try {
        const result = await readSkills(readKey, scope);
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setState((prev) => ({
            ...prev,
            scopeKey,
            status: 'unavailable',
            errorCode: result.errorCode ?? 'library_unavailable',
          }));
          return;
        }
        const parsed = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.list'].parse(
          result.result,
        );
        setState((prev) => {
          const previous =
            prev.scopeKey === scopeKey
              ? (prev.snapshot?.items ?? emptyItems)
              : emptyItems;
          const snapshot: Snapshot = {
            items: reconcile(previous, parsed.items),
            unavailableItems: reconcile(
              prev.scopeKey === scopeKey ? prev.snapshot?.unavailableItems ?? emptyUnavailableItems : emptyUnavailableItems,
              parsed.unavailableItems ?? emptyUnavailableItems,
            ),
            key: sourceKey,
            usageObservedSince: parsed.usageObservedSince ?? null,
          };
          lastKnown.set(scopeKey, snapshot);
          return { scopeKey, snapshot, status: 'ready', errorCode: null };
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const code =
          error &&
          typeof error === 'object' &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'library_unavailable';
        setState((prev) => ({
          ...prev,
          scopeKey,
          status: 'unavailable',
          errorCode: code,
        }));
      }
    })();
    return () => controller.abort();
  }, [scopeKey, canRead, sourceKey, readKey]);

  const snapshot =
    state.scopeKey === scopeKey
      ? state.snapshot
      : scopeKey
        ? (lastKnown.get(scopeKey) ?? null)
        : null;
  const displayedItems = React.useMemo(() => {
    if (!snapshot || !rules.value) return snapshot?.items ?? emptyItems;
    return reconcile(snapshot.items, snapshot.items.map(item => {
      const current = rules.value!.rules.filter(rule => rule.skillId === item.skillId);
      return JSON.stringify(item.rules) === JSON.stringify(current) ? item : { ...item, rules: current };
    }));
  }, [snapshot, rules.value]);
  const status: SkillsLibraryStatus =
    rules.status === 'unavailable'
      ? 'unavailable'
      : state.scopeKey === scopeKey ? state.status : 'loading';
  const errorCode = rules.status === 'unavailable'
    ? rules.reason ?? 'library_unavailable'
    : state.errorCode;
  return React.useMemo(
    () => ({
      scope,
      status: status === 'loading' && snapshot ? 'ready' : status,
      items: displayedItems,
      unavailableItems: snapshot?.unavailableItems ?? emptyUnavailableItems,
      stale:
        snapshot !== null && (status !== 'ready' || snapshot.key !== sourceKey),
      errorCode: status === 'unavailable' ? errorCode : null,
      usageObservedSince: usage.status === 'ready' ? snapshot?.usageObservedSince ?? null : null,
      retry,
    }),
    [scope, status, snapshot, displayedItems, sourceKey, errorCode, retry, usage.status],
  );
}
