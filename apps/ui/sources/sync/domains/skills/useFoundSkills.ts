import * as React from 'react';
import {
  SKILL_ACTION_OUTPUT_SCHEMAS_V1,
  SkillFoundListResultV1Schema,
  type SkillFoundListResultV1,
} from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { SkillReadResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillReadV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { readSkillText } from '@/components/settings/skills/detail/skillFileContent';
import { readSkillActionRefusal } from '@/components/settings/skills/detail/useSkillDetail';
import {
  loadFoundWarmCacheEntry,
  subscribeFoundWarmCacheEntry,
} from '@/sync/domains/state/warmCachePersistence';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

export type FoundItem = SkillFoundListResultV1['items'][number];
export type FoundMachineFailure = 'failed' | 'older_machine';

/** One machine's Found list as the page shows it: the last known result, and what is happening now. */
export type FoundMachineScan = Readonly<{
  machineId: string;
  /** The last `skills.found.list` result for this machine (device-local, never bytes). */
  result: SkillFoundListResultV1 | null;
  scanning: boolean;
  /** The latest scan failed. The last known result stays. */
  failure: FoundMachineFailure | null;
}>;

export type FoundAdoptOutcome = Readonly<{
  /** The library skill ids the adoption made. */
  skillIds: readonly string[];
  /** Skills added whose place (rules) could not be set. */
  incomplete: boolean;
}>;

const NOT_AVAILABLE = /RPC_METHOD_(NOT_AVAILABLE|NOT_FOUND)|unsupported_action/;

type Entries = Readonly<Record<string, SkillFoundListResultV1 | null>>;

/**
 * The last known `skills.found.list` result per machine from the device-local warm cache, kept current
 * as any reader writes it (the page's scan, the composer's). It never reads a machine.
 */
export function useFoundSkillsCache(machineIds: readonly string[]): Entries {
  const scope = useAccountSettingsScope();
  const idsKey = machineIds.join('\u0000');
  const [entries, setEntries] = React.useState<Entries>({});
  const accountId = scope?.accountId;
  const serverId = scope?.serverId;
  React.useLayoutEffect(() => {
    const ids = idsKey ? idsKey.split('\u0000') : [];
    const read = (machineId: string) => {
      const entry = loadFoundWarmCacheEntry(serverId, accountId, 'skill', machineId);
      return entry?.kind === 'skill' ? entry.result : null;
    };
    setEntries(Object.fromEntries(ids.map((id) => [id, read(id)])));
    const unsubscribers = ids.map((machineId) =>
      subscribeFoundWarmCacheEntry(serverId, accountId, 'skill', machineId, () =>
        setEntries((prev) => ({ ...prev, [machineId]: read(machineId) })),
      ),
    );
    return () => unsubscribers.forEach((off) => off());
  }, [accountId, idsKey, serverId]);
  return entries;
}

/** How many Found skills are not in the library yet, across the last known results (the rail's count). */
export function useFoundSkillsCount(machineIds: readonly string[]): number {
  const entries = useFoundSkillsCache(machineIds);
  return React.useMemo(
    () =>
      Object.values(entries).reduce(
        (total, result) => total + (result?.items.filter((item) => item.inLibrary === null).length ?? 0),
        0,
      ),
    [entries],
  );
}

/**
 * "Found on your machines" data (P6 C40): `skills.found.list` per machine through the mounted Action
 * executor, whose ingress keeps the last known result per machine in the device-local warm cache. The
 * page reads that cache first, so reopening never flashes empty, then scans every machine that can be
 * reached. Adopt and Compare reuse the same executor: bytes always travel over the machine transfer,
 * never through this cache.
 */
export function useFoundSkills(machineIds: readonly string[]) {
  const scope = useAccountSettingsScope();
  const { execute, ready } = useMountedActionExecution(scope?.serverId ?? null);
  const idsKey = machineIds.join('\u0000');
  const entries = useFoundSkillsCache(machineIds);
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = React.useState<
    Readonly<Record<string, FoundMachineFailure>>
  >({});

  const scan = React.useCallback(
    async (machineId: string) => {
      setBusy((prev) => new Set(prev).add(machineId));
      let failure: FoundMachineFailure | null = null;
      try {
        const response = await execute('skills.found.list', { machineId });
        if (!response.ok) {
          failure = NOT_AVAILABLE.test(`${response.errorCode ?? ''} ${response.error ?? ''}`)
            ? 'older_machine'
            : 'failed';
        } else {
          // The executor's ingress writes the cache; the page reads it back through `useFoundSkillsCache`.
          if (!SkillFoundListResultV1Schema.safeParse(response.result).success) failure = 'failed';
        }
      } catch {
        failure = 'failed';
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(machineId);
          return next;
        });
        setFailures((prev) => {
          if (failure === null) {
            if (!(machineId in prev)) return prev;
            const { [machineId]: _cleared, ...rest } = prev;
            return rest;
          }
          return { ...prev, [machineId]: failure };
        });
      }
    },
    [execute],
  );

  const scans = React.useMemo<readonly FoundMachineScan[]>(
    () =>
      (idsKey ? idsKey.split('\u0000') : []).map((machineId) => ({
        machineId,
        result: entries[machineId] ?? null,
        scanning: busy.has(machineId),
        failure: failures[machineId] ?? null,
      })),
    [busy, entries, failures, idsKey],
  );

  /** `skills.found.adopt`: one call for every item (bytes over the machine transfer, default reach). */
  const adopt = React.useCallback(
    async (
      machineId: string,
      items: readonly Readonly<{ name: string; path: string }>[],
    ): Promise<FoundAdoptOutcome | null> => {
      const response = await execute('skills.found.adopt', {
        machineId,
        items: items.map(({ name, path }) => ({ name, path })),
      });
      if (readSkillActionRefusal(response) !== null || !response.ok) return null;
      const receipt = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.adopt'].parse(
        response.result,
      );
      return {
        skillIds: receipt.skillIds,
        incomplete: (receipt.incomplete?.length ?? 0) > 0,
      };
    },
    [execute],
  );

  /** Both sides of a masked name: the library copy and the machine's copy of its SKILL.md. */
  const readBoth = React.useCallback(
    async (
      machineId: string,
      path: string,
      librarySkillId: string,
    ): Promise<Readonly<{ yours: string; theirs: string }> | null> => {
      const [mine, theirs] = await Promise.all([
        execute('skills.read', { skillId: librarySkillId }),
        execute('skills.found.read', { machineId, path }),
      ]);
      if (readSkillActionRefusal(mine) !== null || !mine.ok) return null;
      if (readSkillActionRefusal(theirs) !== null || !theirs.ok) return null;
      const yours = SkillReadResultV1Schema.parse(mine.result).skillMd;
      const bundle = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.read'].parse(
        theirs.result,
      );
      const file = bundle.files.find((entry) => entry.path === 'SKILL.md');
      return file ? { yours, theirs: readSkillText(file.contentBase64) } : null;
    },
    [execute],
  );

  return { scans, scan, adopt, readBoth, ready, scope };
}
