import * as React from 'react';
import { SkillsRulesSetOutputV1Schema } from '@happier-dev/protocol/actions/specs/capabilityRules';
import { isReadOnlySkillProvenanceV1, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { resolveSkillsFirstVisit } from './firstRunEligibility';
import { buildSkillsFirstRunSelection, skillsFirstRunTurnOnInput } from './skillsFirstRunSelection';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/** First run's checklist (P6 §4.7): reached from the homepage hero and the rail's pinned destination. */
export const SKILLS_CHOOSE_ROUTE = SETTINGS_ROUTES.skillsChoose;

/** First-run reads the existing Account rule owner; only dismissal lives on this device. */
export function useSkillsFirstRun(items: readonly SkillListItemV1[]) {
  const scope = useAccountSettingsScope();
  const scopeKey = scope ? `${scope.serverId}:${scope.accountId}` : null;
  const catalog = usePromptLibraryCatalogValue('skill-rules', scope);
  const execution = useMountedActionExecution(scope);
  const decidedAt = useLocalSetting('skillsFirstRunDecidedAt');
  const selection = React.useMemo(() => buildSkillsFirstRunSelection(items), [items]);
  const firstVisit = React.useMemo(() => catalog.status === 'ready' && catalog.value
    ? resolveSkillsFirstVisit(items, { rules: catalog.value.rules, decidedAt }) : null,
  [items, catalog.status, catalog.value, decidedAt]);
  const [choices, setChoices] = React.useState<Readonly<{ scopeKey: string | null; values: ReadonlyMap<string, boolean> }>>(
    () => ({ scopeKey, values: new Map() }));
  const selectedIds = React.useMemo(() => {
    const defaults = new Set(selection.preselectedIds);
    return selection.items.filter(item => choices.scopeKey === scopeKey && choices.values.has(item.skillId)
      ? choices.values.get(item.skillId) : defaults.has(item.skillId)).map(item => item.skillId);
  }, [selection, choices, scopeKey]);
  const setSelected = React.useCallback((skillId: string, selected: boolean) => {
    setChoices(previous => ({ scopeKey, values: new Map(previous.scopeKey === scopeKey ? previous.values : []).set(skillId, selected) }));
  }, [scopeKey]);
  const [pending, setPending] = React.useState(false);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const inFlight = React.useRef<Promise<boolean> | null>(null);
  const notNow = React.useCallback(() => getStorage().getState().applyLocalSettings({ skillsFirstRunDecidedAt: Date.now() }, { source: 'ui' }), []);
  const turnOn = React.useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    if (!firstVisit || !execution.ready || selectedIds.length === 0) return Promise.resolve(false);
    setPending(true); setErrorCode(null);
    const operation = (async () => {
      try {
        const receipt = await execution.execute('skills.rules.set', skillsFirstRunTurnOnInput(selectedIds));
        if (!receipt.ok) { setErrorCode(receipt.errorCode ?? receipt.error); return false; }
        const parsed = SkillsRulesSetOutputV1Schema.safeParse(receipt.result);
        if (!parsed.success) { setErrorCode('invalid_action_output'); return false; }
        if (!parsed.data.ok) { setErrorCode(parsed.data.code); return false; }
        getStorage().getState().applyLocalSettings({ skillsFirstRunDecidedAt: Date.now() }, { source: 'ui' });
        return true;
      } catch (error) {
        setErrorCode(error instanceof Error ? error.message : 'catalog_unavailable'); return false;
      } finally { setPending(false); inFlight.current = null; }
    })();
    inFlight.current = operation;
    return operation;
  }, [firstVisit, execution.ready, execution.execute, selectedIds]);
  const migrated = React.useMemo(() => items.filter(item => !isReadOnlySkillProvenanceV1(item.provenance) && item.migratedFromContext), [items]);
  return { eligible: firstVisit !== null, firstVisit, items: selection.items, migrated, selectedIds, selectedCount: selectedIds.length,
    setSelected, turnOn, notNow, pending, errorCode };
}

export type SkillsFirstRun = ReturnType<typeof useSkillsFirstRun>;
