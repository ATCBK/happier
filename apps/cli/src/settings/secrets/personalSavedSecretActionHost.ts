import { randomUUID } from 'node:crypto';
import { createPersonalSavedSecretActionExecuteV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { openSavedSecretResourceStoredContentV1, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { SharedSavedSecretMutationOutputV1Schema, SharedSavedSecretDeleteOutputV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { listAccountSettingsSavedSecretReferences } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { StoredCredentials } from '@/persistence';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { runWithServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getRandomBytes } from '@/api/encryption';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { captureSavedSecretSourcePreparationForOperation, prepareSavedSecretResourceCreateForOperation } from "./hydrateSavedSecretCatalog";
import { readSavedSecretCatalogForOperation } from "@/settings/secrets/savedSecretCatalogRead";
import { type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";

function refusal(code: string, details?: unknown): never {
    throw Object.assign(new Error(code), { code, ...(details === undefined ? {} : { details }) });
}
/** Plaintext lives only in the caller process; resources use the incumbent mode/sealing/census owners. */
export function createCliPersonalSavedSecretActionExecute(params: Readonly<{
    credentials: StoredCredentials; operationContext?: SavedSecretOperationContextV1; serverHttpBaseUrl?: string;
    isCredentialCurrent?: () => boolean | Promise<boolean>; home: NonNullable<ActionExecutorDeps['homeDomainAction']>;
}>): NonNullable<ActionExecutorDeps['personalSavedSecretActionExecute']> {
    return async ({ actionId, input, context }) => runWithServerHttpBaseUrl(params.operationContext?.serverHttpBaseUrl
        ?? params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), async () => {
        const accountId = readAccountIdFromToken(params.credentials.token);
        if (!accountId) refusal('not_authenticated');
        const scopeKey = resolveAccountSettingsScopeKeyForToken(params.credentials.token);
        if (!params.operationContext && getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey) {
            await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking' });
        }
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const assertCurrent = async () => {
            context.signal?.throwIfAborted();
            if (params.operationContext ? !await params.operationContext.isCurrent()
                : getActiveAccountSettingsSnapshotLifetimeToken() !== lifetime || getActiveAccountSettingsSnapshot()?.scopeKey !== scopeKey) refusal('account_changed');
            if (params.isCredentialCurrent && !await params.isCredentialCurrent()) refusal('account_changed');
        };
        const read = async () => {
            await assertCurrent();
            const snapshot = await readSavedSecretCatalogForOperation({ expectedScopeKey: scopeKey, refreshCatalog: true,
                operationContext: params.operationContext, signal: context.signal });
            await assertCurrent();
            return snapshot.savedSecretResources ?? [];
        };
        const mutate = async (id: 'secrets.shared.create' | 'secrets.shared.update' | 'secrets.shared.delete', value: unknown) => {
            await assertCurrent();
            const result = await params.home({ actionId: id, input: value, context, signal: context.signal });
            const failed=ActionExecuteFailureSchema.safeParse(result);
            if (failed.success) {
                refusal(failed.data.errorCode, failed.data.details);
            }
            return result;
        };
        const findOwned = async (secretId: string, expected: number) => {
            const resource = (await read()).find(resource => resource.resourceId === secretId);
            if (!resource || resource.ownerAccountId !== accountId || resource.relationship === 'recipient') refusal('not_found');
            if (resource.revision !== expected) refusal('revision_conflict');
            return resource;
        };
        const execute = createPersonalSavedSecretActionExecuteV1({
            list: async () => (await read()).flatMap(resource => resource.ownerAccountId === accountId && resource.relationship !== 'recipient'
                && resource.displayName ? [{ secretId: resource.resourceId, name: resource.displayName, kind: resource.kind, revision: resource.revision }] : []),
            create: async args => {
                const storage = await resolveCliAccountStorageContext({ credentials: params.credentials, signal: context.signal });
                await assertCurrent();
                const secretId = randomUUID();
                const request = prepareSavedSecretResourceCreateForOperation({ credentials: params.credentials, accountId,
                    accountMode: storage.mode, resourceId: secretId, displayName: args.name, kind: args.kind ?? 'apiKey', value: args.value });
                SharedSavedSecretMutationOutputV1Schema.parse(await mutate('secrets.shared.create', request));
                return { secretId, secretRef: formatSharedSavedSecretRefV1(secretId) };
            },
            update: async args => {
                const resource = await findOwned(args.secretId, args.expectedUpdatedAt);
                const storage = await resolveCliAccountStorageContext({ credentials: params.credentials, signal: context.signal });
                if (storage.mode !== resource.encryptionMode || !resource.storedContent) refusal('secret_unavailable');
                const current = resource.encryptionMode === 'plain'
                    ? openSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'plain', storedContent: resource.storedContent })
                    : resource.resourceDataKey ? openSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'e2ee',
                        storedContent: resource.storedContent, resourceDataKey: resource.resourceDataKey }) : null;
                if (!current) refusal('secret_unavailable');
                const content = { ...current, ...(args.name === undefined ? {} : { name: args.name }), ...(args.value === undefined ? {} : { value: args.value }) };
                const storedContent = resource.encryptionMode === 'plain'
                    ? sealSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'plain', content })
                    : sealSavedSecretResourceStoredContentV1({ resourceId: resource.resourceId, mode: 'e2ee', content,
                        resourceDataKey: resource.resourceDataKey!, randomBytes: getRandomBytes });
                const receipt = SharedSavedSecretMutationOutputV1Schema.parse(await mutate('secrets.shared.update', {
                    resourceId: args.secretId, expectedRevision: args.expectedUpdatedAt, displayName: content.name, kind: content.kind, storedContent,
                }));
                return { revision: receipt.revision };
            },
            delete: async args => {
                await findOwned(args.secretId, args.expectedUpdatedAt);
                const captured = await captureSavedSecretSourcePreparationForOperation({ credentials: params.credentials,
                    expectedScopeKey: scopeKey, operationContext: params.operationContext, signal: context.signal });
                const references = listAccountSettingsSavedSecretReferences(captured.rawSettings, formatSharedSavedSecretRefV1(args.secretId), captured.referenceCatalogs);
                if (references.length) refusal('in_use', { references });
                SharedSavedSecretDeleteOutputV1Schema.parse(await mutate('secrets.shared.delete', { resourceId: args.secretId,
                    expectedRevision: args.expectedUpdatedAt, expectedSettingsVersion: captured.expectedSettingsVersion, referenceCensus: captured.referenceCensus }));
            },
        });
        return execute(actionId, input);
    });
}
