import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  SKILL_ACTION_OUTPUT_SCHEMAS_V1,
  type SkillLibraryActionInputByIdV1,
} from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import {
  SkillReadResultV1Schema,
  type SkillReadResultV1,
} from '@happier-dev/protocol/prompts/library/skills/skillReadV1';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';

import { readSkillText } from './skillFileContent';

export type SkillDetailStatus =
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'not_found';
export type SkillChange = Omit<
  SkillLibraryActionInputByIdV1['skills.update'],
  'skillId' | 'expectedRevision'
>;
export type SkillChangeResult =
  | Readonly<{ ok: true; revision: string }>
  | Readonly<{ ok: false; code: string }>;

/** A skill Action's typed refusal, whether the executor returned it as a failed result or as `{ ok: false, code }`. */
export function readSkillActionRefusal(
  result: ActionExecuteResult,
): string | null {
  if (!result.ok) return result.errorCode ?? result.error ?? 'unknown';
  const value = result.result;
  if (
    value &&
    typeof value === 'object' &&
    'ok' in value &&
    value.ok === false
  ) {
    return 'code' in value && typeof value.code === 'string'
      ? value.code
      : 'unknown';
  }
  return null;
}

/**
 * One skill as the detail page reads and changes it, entirely through the `skills.*` Actions (C28: no
 * UI library writes): `skills.read` for its content, `skills.update` with the read revision as the CAS,
 * `skills.delete`/`skills.duplicate`, `artifact.folder.set` for its folder and P4's
 * `registries.updates.check`. It re-reads when the library reports a newer revision, unless the page
 * holds an unsaved edit (the edit then meets the newer revision as a conflict).
 */
export function useSkillDetail(skillId: string | null) {
  const library = useSkillsLibrary();
  const serverId = library.scope?.serverId ?? null;
  const { execute, ready } = useMountedActionExecution(serverId);
  const folders = usePromptLibraryCatalogValue('folders');
  const listItem = React.useMemo(
    () =>
      skillId
        ? (library.items.find((item) => item.skillId === skillId) ?? null)
        : null,
    [library.items, skillId],
  );
  const [state, setState] = React.useState<
    Readonly<{
      skillId: string | null;
      read: SkillReadResultV1 | null;
      status: SkillDetailStatus;
      errorCode: string | null;
    }>
  >({ skillId, read: null, status: 'loading', errorCode: null });
  const [attempt, setAttempt] = React.useState(0);
  const [checkedAt, setCheckedAt] = React.useState<number | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [checkFailed, setCheckFailed] = React.useState(false);
  /** The page holds an edit the library has not acknowledged: a newer revision must not replace it. */
  const holdRef = React.useRef(false);
  const readRef = React.useRef<SkillReadResultV1 | null>(null);
  const current =
    state.skillId === skillId
      ? state
      : { skillId, read: null, status: 'loading' as const, errorCode: null };
  readRef.current = current.read;

  // A newer revision elsewhere (another device, an agent, the update tracker) refreshes the page.
  const newerKnown =
    listItem !== null &&
    current.read !== null &&
    listItem.revision !== current.read.revision;
  const readKey = `${attempt}:${newerKnown && !holdRef.current ? listItem?.revision : ''}`;

  React.useEffect(() => {
    if (!skillId || !ready) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await execute(
          'skills.read',
          { skillId },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const refusal = readSkillActionRefusal(result);
        if (refusal) {
          setState((prev) => ({
            skillId,
            read: prev.skillId === skillId ? prev.read : null,
            status: refusal === 'not_found' ? 'not_found' : 'unavailable',
            errorCode: refusal,
          }));
          return;
        }
        const read = SkillReadResultV1Schema.parse(
          result.ok ? result.result : null,
        );
        setState({ skillId, read, status: 'ready', errorCode: null });
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
          skillId,
          read: prev.skillId === skillId ? prev.read : null,
          status: 'unavailable',
          errorCode: code,
        }));
      }
    })();
    return () => controller.abort();
  }, [execute, ready, skillId, readKey]);

  const retry = React.useCallback(() => {
    library.retry();
    setAttempt((value) => value + 1);
  }, [library]);

  const setHold = React.useCallback((hold: boolean) => {
    holdRef.current = hold;
  }, []);

  /** One `skills.update` against the revision the page last read; a newer one answers `revision_conflict`. */
  const update = React.useCallback(
    async (change: SkillChange): Promise<SkillChangeResult> => {
      const read = readRef.current;
      if (!skillId || !read) return { ok: false, code: 'not_ready' };
      try {
        const result = await execute('skills.update', {
          skillId,
          expectedRevision: read.revision,
          ...change,
        });
        const refusal = readSkillActionRefusal(result);
        if (refusal) return { ok: false, code: refusal };
        const { revision } = SKILL_ACTION_OUTPUT_SCHEMAS_V1[
          'skills.update'
        ].parse(result.ok ? result.result : null);
        setState((prev) =>
          prev.skillId === skillId && prev.read
            ? { ...prev, read: applyChange(prev.read, change, revision) }
            : prev,
        );
        return { ok: true, revision };
      } catch {
        return { ok: false, code: 'save_failed' };
      }
    },
    [execute, skillId],
  );

  /** The other side of a conflict: the library's current content, without replacing the page's edit. */
  const readLatest = React.useCallback(
    async (file?: string): Promise<SkillReadResultV1 | null> => {
      if (!skillId) return null;
      const result = await execute('skills.read', {
        skillId,
        ...(file ? { file } : {}),
      });
      if (readSkillActionRefusal(result)) return null;
      return SkillReadResultV1Schema.parse(result.ok ? result.result : null);
    },
    [execute, skillId],
  );

  /** Adopt a read the page asked for (Take theirs, Keep mine's base). */
  const adopt = React.useCallback((read: SkillReadResultV1) => {
    setState({ skillId: read.skillId, read, status: 'ready', errorCode: null });
  }, []);

  /** Remove asks first (D22: `skills.delete` is a confirm class); `'cancelled'` when the person says no. */
  const remove = React.useCallback(async (): Promise<boolean | 'cancelled'> => {
    const read = readRef.current;
    if (!skillId || !read) return false;
    const confirmed = await Modal.confirm(
      t('capabilities.skillDetail.leave.confirmTitle', { name: read.name }),
      t('capabilities.skillDetail.leave.confirmBody'),
      { confirmText: t('capabilities.skillDetail.leave.confirm'), destructive: true },
    );
    if (!confirmed) return 'cancelled';
    const result = await execute(
      'skills.delete',
      { skillId, expectedRevision: read.revision },
      { presentUserConfirmation: { actionId: 'skills.delete' } },
    );
    if (readSkillActionRefusal(result)) return false;
    SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.delete'].parse(
      result.ok ? result.result : null,
    );
    return true;
  }, [execute, skillId]);

  const duplicate = React.useCallback(async (): Promise<string | null> => {
    if (!skillId) return null;
    const result = await execute('skills.duplicate', { skillId });
    if (readSkillActionRefusal(result)) return null;
    return SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.duplicate'].parse(
      result.ok ? result.result : null,
    ).skillId;
  }, [execute, skillId]);

  /** "Move to folder": the personal folder tree's one placement Action (IR-83), then a fresh list. */
  const moveToFolder = React.useCallback(
    async (folderId: string | null): Promise<boolean> => {
      if (!skillId || folders.status !== 'ready' || folders.stale) return false;
      const result = await execute('artifact.folder.set', {
        artifactId: skillId,
        folderId,
        expectedRevision: folders.revision,
      });
      if (readSkillActionRefusal(result)) return false;
      const receipt = result.ok ? result.result : null;
      const updated =
        receipt && typeof receipt === 'object' && 'status' in receipt
          ? receipt.status === 'updated'
          : true;
      library.retry();
      return updated;
    },
    [execute, folders.revision, folders.stale, folders.status, library, skillId],
  );

  /** "Check now": P4's one update checker for this skill; the library re-reads the recorded upstream. */
  const checkNow = React.useCallback(async () => {
    if (!skillId) return;
    setChecking(true);
    setCheckFailed(false);
    try {
      const result = await execute('registries.updates.check', {
        kind: 'skill',
        keys: [skillId],
      });
      if (readSkillActionRefusal(result)) {
        setCheckFailed(true);
        return;
      }
      const parsed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].safeParse(
        result.ok ? result.result : null,
      );
      if (parsed.success) setCheckedAt(parsed.data.checkedAt);
      retry();
    } catch {
      setCheckFailed(true);
    } finally {
      setChecking(false);
    }
  }, [execute, retry, skillId]);

  return {
    library,
    listItem,
    read: current.read,
    status: current.status,
    errorCode: current.errorCode,
    folders,
    retry,
    setHold,
    update,
    readLatest,
    adopt,
    remove,
    duplicate,
    moveToFolder,
    checkNow,
    checkedAt,
    checking,
    checkFailed,
    execute,
    ready,
  } as const;
}

export type SkillDetailModel = ReturnType<typeof useSkillDetail>;

function applyChange(read: SkillReadResultV1, change: SkillChange, revision: string): SkillReadResultV1 {
    let files = read.files;
    let skillMd = read.skillMd;
    for (const fileChange of change.files ?? []) {
        if (fileChange.kind === 'remove') {
            files = files.filter((file) => file.path !== fileChange.path);
            continue;
        }
        const file = fileChange.file;
        const bytes = decodeBase64(file.contentBase64).byteLength;
        files = [...files.filter((entry) => entry.path !== file.path),
            { path: file.path, bytes, ...(file.unixMode != null ? { unixMode: file.unixMode } : {}) }];
        if (file.path === 'SKILL.md') skillMd = readSkillText(file.contentBase64);
    }
    return { ...read, revision, files, skillMd };
}
