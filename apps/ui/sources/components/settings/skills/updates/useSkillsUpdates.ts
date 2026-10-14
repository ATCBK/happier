import * as React from 'react';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import {
  SKILL_ACTION_OUTPUT_SCHEMAS_V1,
  type SkillLibraryActionResultByIdV1,
} from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';

import { readSkillActionRefusal } from '../detail/useSkillDetail';
import type { SkillFileChoice } from './skillsUpdatesModel';

export type SkillUpdateDiff =
  SkillLibraryActionResultByIdV1['skills.updates.diff'];
export type SkillUpdateDiffState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; diff: SkillUpdateDiff }>
  | Readonly<{ status: 'failed'; code: string }>;
export type SkillUpdateApplyState =
  | Readonly<{ status: 'applying' }>
  | Readonly<{ status: 'applied'; ref: string | null }>
  | Readonly<{ status: 'failed'; code: string }>;

/**
 * The Updates page's operations, all through Actions: P4's one checker (`registries.updates.check`),
 * the R5 inputs (`skills.updates.diff`) and `skills.updates.apply`. "Checked at" lives in this screen's
 * state (P4: the checker returns it; nothing stores it), and every write refreshes the library.
 */
export function useSkillsUpdates(library: SkillsLibrary) {
  const { execute, ready } = useMountedActionExecution(
    library.scope?.serverId ?? null,
  );
  const [check, setCheck] = React.useState<
    Readonly<{ checking: boolean; checkedAt: number | null; failed: boolean; code: string | null }>
  >({ checking: false, checkedAt: null, failed: false, code: null });
  const [diffs, setDiffs] = React.useState<
    ReadonlyMap<string, SkillUpdateDiffState>
  >(new Map());
  const [applies, setApplies] = React.useState<
    ReadonlyMap<string, SkillUpdateApplyState>
  >(new Map());
  const { retry } = library;

  const checkNow = React.useCallback(async () => {
    setCheck((previous) => ({ ...previous, checking: true, failed: false }));
    try {
      const result = await execute('registries.updates.check', {
        kind: 'skill',
      });
      const refusal = readSkillActionRefusal(result);
      const parsed = refusal
        ? null
        : REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].safeParse(result.ok ? result.result : null);
      setCheck((previous) =>
        parsed?.success
          ? { checking: false, checkedAt: parsed.data.checkedAt, failed: false, code: null }
          : { ...previous, checking: false, failed: true, code: refusal ?? 'invalid_action_output' },
      );
      // Whatever the checker recorded, the library re-reads it; a failed check keeps prior facts.
      retry();
      setDiffs(new Map());
    } catch (error) {
      setCheck((previous) => ({
        ...previous,
        checking: false,
        failed: true,
        code: error instanceof Error ? error.message : 'unknown',
      }));
    }
  }, [execute, retry]);

  const loadDiff = React.useCallback(
    async (skillId: string) => {
      setDiffs((previous) =>
        new Map(previous).set(skillId, { status: 'loading' }),
      );
      try {
        const result = await execute('skills.updates.diff', { skillId });
        const refusal = readSkillActionRefusal(result);
        const parsed = refusal
          ? null
          : SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.diff'].safeParse(
              result.ok ? result.result : null,
            );
        setDiffs((previous) =>
          new Map(previous).set(
            skillId,
            parsed?.success
              ? { status: 'ready', diff: parsed.data }
              : { status: 'failed', code: refusal ?? 'invalid_action_output' },
          ),
        );
      } catch (error) {
        setDiffs((previous) =>
          new Map(previous).set(skillId, {
            status: 'failed',
            code: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }
    },
    [execute],
  );

  const apply = React.useCallback(
    async (
      item: SkillListItemV1,
      choices?: Readonly<Record<string, SkillFileChoice>>,
    ) => {
      setApplies((previous) =>
        new Map(previous).set(item.skillId, { status: 'applying' }),
      );
      try {
        const result = await execute('skills.updates.apply', {
          skillId: item.skillId,
          expectedRevision: item.revision,
          ...(choices ? { choices } : {}),
        });
        const refusal = readSkillActionRefusal(result);
        const parsed = refusal
          ? null
          : SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.updates.apply'].safeParse(
              result.ok ? result.result : null,
            );
        setApplies((previous) =>
          new Map(previous).set(
            item.skillId,
            parsed?.success
              ? {
                  status: 'applied',
                  ref: provenanceRefLabel(parsed.data.provenance),
                }
              : { status: 'failed', code: refusal ?? 'invalid_action_output' },
          ),
        );
        if (parsed?.success) retry();
      } catch (error) {
        setApplies((previous) =>
          new Map(previous).set(item.skillId, {
            status: 'failed',
            code: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }
    },
    [execute, retry],
  );

  return { ready, check, checkNow, diffs, loadDiff, applies, apply };
}

export type SkillsUpdatesController = ReturnType<typeof useSkillsUpdates>;

type ContentRef =
  | Readonly<{ kind: 'gitTree'; commit: string }>
  | Readonly<{ kind: 'version'; version: string }>;

/** A source revision as people read it: a short commit, or the published version. */
export function contentRefLabel(
  ref: ContentRef | undefined | null,
): string | null {
  if (!ref) return null;
  return ref.kind === 'gitTree' ? ref.commit.slice(0, 7) : ref.version;
}

/** The revision a skill's library copy came from. */
export function provenanceRefLabel(
  provenance: SkillListItemV1['provenance'],
): string | null {
  if (provenance.kind === 'registry')
    return contentRefLabel(provenance.registry.ref);
  if (provenance.kind === 'link') return contentRefLabel(provenance.ref);
  return null;
}
