import { createProfileOperations, setBuiltinProfileEnabledPreferenceV1, type ProfileOperationResult } from '@happier-dev/protocol/profiles/profileOperations';
import { AGENT_IDS } from '@happier-dev/agents';
import { isLaunchProfileV2 } from '@happier-dev/protocol/profiles/read';
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactV1Schema, readLaunchProfileArtifactV1 } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { deleteProfileRecordInContext, readProfileCatalogProjectionInContext,
    writeProfileRecordInContext, type ProfileAccountContext, type ProfileRowMutationResponseV1 } from '@/sync/api/account/apiProfileCatalog';
import { invalidateProfileCatalogProjection } from '@/sync/engine/settings/profileCatalogEngine';
import { applyAcknowledgedProfileArtifact } from '@/sync/store/settings/profileCatalogSnapshot';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { readProfileEnabledById } from '@/sync/domains/profiles/profileEnablement';
import { readUiVisibleProfileCatalogSnapshot } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';

export type UiProfileOperationsOptions = Readonly<{
    scope: AccountSettingsScope;
    signal?: AbortSignal;
    builtinNames?: readonly string[];
    agentIds?: readonly string[];
    isCurrent?: () => boolean;
    /** Real opened AuthoringMemory evidence, supplied only for search and selection. */
    selectionMemory?: Readonly<{ lastUsedProfile: string | null }>;
    /** Named reads/editing demand builtin visibility only after authoritative membership admission. */
    addressedProfileId?: string;
    readSelectionMemory?: () => Promise<Readonly<{ lastUsedProfile: string | null }>>;
    /** Captured Action memory owner. */
    clearRememberedProfile?: (input: Readonly<{ id: string }>) => Promise<void>;
}>;

function mutationResult(id: string, outcome: ProfileRowMutationResponseV1): ProfileOperationResult {
    if (outcome.status === 'updated' || outcome.status === 'conflict') return { status: outcome.status, id, revision: outcome.revision };
    return { status: 'unavailable', reason: outcome.status };
}

function compose(options: UiProfileOperationsOptions, context: ProfileAccountContext,
    projection: Awaited<ReturnType<typeof readProfileCatalogProjectionInContext>>,
    capturedSettings?: Readonly<Record<string, unknown>>) {
    const assertCurrent = () => {
        options.signal?.throwIfAborted();
        context.assertCurrent();
        if (options.isCurrent && !options.isCurrent()) throw new Error('Profile Account scope changed');
        if (context.accountId !== options.scope.accountId) throw new Error('Profile Account scope changed');
    };
    const readSnapshot = () => projection;
    const readOrdinarySettings = () => {
        assertCurrent();
        return capturedSettings;
    };
    const refresh = () => {
        // Publication is the scoped loader's work, not part of a durable write's
        // receipt. Its singleflight/currentness owner also exposes refresh failures.
        void invalidateProfileCatalogProjection(options.scope).catch(() => undefined);
    };
    const acknowledged = async (id: string, outcome: ProfileRowMutationResponseV1) => {
        const result = mutationResult(id, outcome);
        // A projection failure cannot erase an acknowledged authoritative write.
        if (result.status === 'updated') {
            refresh();
        }
        return result;
    };
    return createProfileOperations({
        builtinNames: options.builtinNames,
        agentIds: options.agentIds ?? AGENT_IDS,
        clearRememberedProfile: options.clearRememberedProfile,
        readCatalog: () => { assertCurrent(); return readSnapshot().catalog; },
        artifactsById: () => readSnapshot().artifactsById,
        readVisibleProfiles: () => {
            const snapshot = readSnapshot();
            const raw = readOrdinarySettings();
            const memory = options.selectionMemory;
            if (!raw || !memory) {
                return { status: 'unavailable', reason: 'profile_selection_evidence_unavailable' };
            }
            const projected = readUiVisibleProfileCatalogSnapshot(snapshot, raw, memory);
            if (!projected.available) return { status: 'unavailable', reason: 'profile_catalog_unavailable' };
            return projected.profiles;
        },
        readEnabledPreferences: () => readProfileEnabledById(readOrdinarySettings()?.profileEnabledById),
        setBuiltinEnabled: async input => {
            assertCurrent();
            let updatedSettings: Record<string, unknown> | undefined;
            const mutate = (raw: Readonly<Record<string, unknown>>) => {
                assertCurrent();
                updatedSettings = setBuiltinProfileEnabledPreferenceV1(raw, input.subject.id, input.enabled);
                return updatedSettings;
            };
            const outcome = await context.mutateRawSettings(mutate, {
                expectedSettingsVersion: input.expectedSettingsVersion, rebaseOnConflict: false, observeOutcome: true,
            });
            const applied = requireOneShotAccountSettingsMutationApplied(outcome);
            capturedSettings = updatedSettings;
            return { status: 'preference-updated', id: input.subject.id, enabled: input.enabled, settingsVersion: applied.settingsVersion };
        },
        writeRecord: async input => {
            assertCurrent();
            return acknowledged(input.record.id, await writeProfileRecordInContext(context, input, options.signal));
        },
        deleteRecord: async input => {
            assertCurrent();
            return acknowledged(input.id, await deleteProfileRecordInContext(context, input, options.signal));
        },
        writeArtifactProfile: async ({ profile, record, expectedRevision, expectedArtifactRevision }) => {
            assertCurrent();
            if (record.definition.kind !== 'artifact') return { status: 'invalid', reason: 'invalid-definition', id: record.id };
            const resource = readSnapshot().artifactsById.get(record.definition.artifactId);
            const content = resource && readLaunchProfileArtifactV1(resource);
            if (!resource?.revision || !content) return { status: 'unavailable', reason: 'profile_definition_unavailable' };
            if (expectedArtifactRevision.headerVersion !== resource.revision.headerVersion
                || expectedArtifactRevision.bodyVersion !== resource.revision.bodyVersion) {
                return { status: 'conflict', id: record.id, revision: expectedRevision };
            }
            const parsed = LaunchProfileArtifactV1Schema.safeParse({ ...content, profile: isLaunchProfileV2(profile)
                ? createStoredReadSchema(LaunchProfileV2Schema).parse(profile) : createStoredReadSchema(AIBackendProfileSchema).parse(profile) });
            if (!parsed.success) return { status: 'invalid', reason: 'invalid-definition', id: record.id };
            const header = { ...resource.header, ...buildLaunchProfileArtifactHeaderV1(parsed.data) };
            const body = JSON.stringify(parsed.data);
            const result = await context.workflowArtifacts.update({ artifactId: resource.artifactId,
                expectedRevision: expectedArtifactRevision, header, body, signal: options.signal });
            if (!result.ok) return result.errorCode === 'version_mismatch'
                ? { status: 'conflict', id: record.id, revision: expectedRevision }
                : { status: 'unavailable', reason: result.errorCode ?? 'profile_artifact_edit_failed' };
            applyAcknowledgedProfileArtifact(options.scope, { ...resource, header, body, revision: result.revision }, context.accountLifetime.isCurrent());
            refresh();
            return { status: 'updated', id: record.id, revision: expectedRevision };
        },
    });
}

/** Actions reuse their already-admitted Home/key lifetime, including the initial inventory read. */
export async function createUiProfileOperationsInContext(options: UiProfileOperationsOptions & Readonly<{ context: ProfileAccountContext }>) {
    options.context.assertCurrent();
    // Once destination authority is established, historical maintenance belongs
    // to the scoped catalog loader, not the lifetime of this admitted Action.
    const projection = await readProfileCatalogProjectionInContext(options.context, options.signal, { deferCleanup: true });
    const catalog = projection.catalog;
    const selectionMemory = options.selectionMemory ?? (options.addressedProfileId && options.readSelectionMemory
        && catalog.status === 'ready' && catalog.source === 'destination'
        && !catalog.records.some(row => row.record.id === options.addressedProfileId)
        ? await options.readSelectionMemory() : undefined);
    options.context.assertCurrent();
    const settings = selectionMemory ? await options.context.readRawSettings() : undefined;
    options.context.assertCurrent();
    return compose({ ...options, selectionMemory }, options.context, projection, settings);
}
