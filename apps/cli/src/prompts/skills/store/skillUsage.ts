import type { StoredCredentials } from '@/persistence';
import { planSkillUsageWriteV1 } from '@happier-dev/protocol/prompts/library/skills/skillUsageV1';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { prepareActivePromptLibraryRecord, refreshActivePromptLibraryCatalogAfterChange } from '@/settings/prompts/hydratePromptLibraryCatalog';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export type SkillUsageAccount = Readonly<{ accountId: string; serverHttpBaseUrl: string }>;
export type RecordSkillUseInput = Readonly<{ skillIds: readonly string[]; account: SkillUsageAccount }>;

/** Daemon-owned, best-effort facts; network work never enters the filesystem store queue. */
export function createSkillUsageRecorder(input: Readonly<{ credentials: StoredCredentials; signal?: AbortSignal }>) {
    const scopeKey = resolveAccountSettingsScopeKey(input.credentials);
    const accountId = readAccountIdFromToken(input.credentials.token);
    const serverHttpBaseUrl = resolveServerHttpBaseUrl();
    // Only overlapping observations share a reservation. The stored row owns
    // the daily interval; a failed attempt is never a stored usage fact.
    const inFlight = new Set<string>();
    return {
        async recordSkillUse(request: RecordSkillUseInput): Promise<void> {
            if (request.skillIds.length === 0 || !accountId || request.account.accountId !== accountId) return;
            const reserved: string[] = [];
            try {
                if (normalizeServerHttpBaseUrl(request.account.serverHttpBaseUrl) !== serverHttpBaseUrl) return;
                // The daemon constructs this recorder before warming Account settings.
                // Capture the admitted lifetime for each observation, not at startup;
                // the row store still fences retirement throughout that observation.
                const lifetimeToken = getActiveAccountSettingsSnapshotLifetimeToken();
                const store = createCliPromptLibraryStore(input);
                const read = await prepareActivePromptLibraryRecord({ ...input, scopeKey, lifetimeToken, key: 'skill-usage' });
                if (read.status !== 'ready' || read.record.key !== 'skill-usage') return;
                const nowMs = Date.now();
                const skillIds = [...new Set(request.skillIds)].filter(id => !inFlight.has(id));
                const value = planSkillUsageWriteV1({ row: read.record.value, skillIds, nowMs });
                if (!value) return;
                // Reserve before the awaited CAS boundary so another observation
                // cannot repeat this attempt; failures never claim a stored use.
                for (const id of skillIds) if (value.lastUsedAt[id] === nowMs) { inFlight.add(id); reserved.push(id); }
                const result = await store.writeRecord({ record: { key: 'skill-usage', value }, expectedRevision: read.revision });
                if (result.status === 'updated' || result.status === 'conflict') {
                    // Both receipts require a fresh row before another use can plan.
                    // The existing publication owner withdraws stale reads immediately.
                    await refreshActivePromptLibraryCatalogAfterChange({ credentials: input.credentials, scopeKey, lifetimeToken });
                }
            } catch {
                // An unavailable/retired Account or lost receipt drops this observation; no replay.
            } finally {
                for (const id of reserved) inFlight.delete(id);
            }
        },
    };
}
export type SkillUsageRecorder = ReturnType<typeof createSkillUsageRecorder>;
