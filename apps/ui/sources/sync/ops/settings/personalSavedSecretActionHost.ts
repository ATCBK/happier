import { createPersonalSavedSecretActionExecuteV1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readSavedSecretCatalogInContext } from '@/sync/api/account/apiSavedSecretCatalog';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import { createSavedSecretResource, updateSavedSecretResource, deleteSavedSecretResource,
    type SavedSecretAdmittedMutationExecute } from './savedSecretResourceOperations';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readProfileTransferSourceInContext } from '@/sync/api/account/apiProfileCatalog';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

function refusal(reason: string, details?: unknown): never {
    throw Object.assign(new Error(reason === 'changed' ? 'revision_conflict' : reason), {
        code: reason === 'changed' ? 'revision_conflict' : reason, ...(details === undefined ? {} : { details }),
    });
}
/** Captured Account resources remain the sole personal secret storage authority. */
export function createUiPersonalSavedSecretActionExecute(account: LazyActionAccountContext,
    home: NonNullable<ActionExecutorDeps['homeDomainAction']>): NonNullable<ActionExecutorDeps['personalSavedSecretActionExecute']> {
    return async ({ actionId, input, context }) => {
        const scope = { serverId: account.serverId, accountId: account.accountId };
        const executeAdmittedMutation: SavedSecretAdmittedMutationExecute = async mutation => {
            account.assertCurrent(); context.signal?.throwIfAborted();
            if(mutation.actionId!=='secrets.shared.create'&&mutation.actionId!=='secrets.shared.update'&&mutation.actionId!=='secrets.shared.delete')refusal('unsupported_action');
            const output = await home({ actionId: mutation.actionId, input: mutation.input, context, signal: context.signal });
            const failed=ActionExecuteFailureSchema.safeParse(output);
            if (failed.success) {
                return { kind: 'failed', failure: homeDomainFailureFromActionFailure(failed.data) };
            }
            return { kind: 'succeeded', value: mutation.parse(output) };
        };
        const read = async () => {
            const catalog = await readSavedSecretCatalogInContext(account, context.signal);
            account.assertCurrent();
            if (!catalog.ok) refusal(catalog.failure.code ?? 'unavailable');
            return catalog.resources.filter(resource => 'resourceId' in resource && resource.entry.relationship === 'owner');
        };
        const execute = createPersonalSavedSecretActionExecuteV1({
            list: async () => (await read()).flatMap(resource => 'resourceId' in resource && resource.entry.name && resource.entry.kind && resource.entry.revision !== null
                ? [{ secretId: resource.resourceId, name: resource.entry.name, kind: resource.entry.kind, revision: resource.entry.revision }] : []),
            create: async args => {
                const result = await createSavedSecretResource({ scope, name: args.name, kind: args.kind ?? 'apiKey', value: args.value,
                    accountGrants: [], teamGrants: [], groupGrants: [], executeAdmittedMutation });
                if (!result.ok) refusal(result.reason);
                const ref = parseSavedSecretRefV1(result.resourceRef);
                if (ref.kind !== 'shared_resource') refusal('invalid_resource_reference');
                return { secretId: ref.resourceId, secretRef: result.resourceRef };
            },
            update: async args => {
                const resource = (await read()).find(resource => 'resourceId' in resource && resource.resourceId === args.secretId);
                if (!resource || !('resourceId' in resource)) refusal('not_found');
                if (resource.entry.revision !== args.expectedUpdatedAt) refusal('changed');
                const result = await updateSavedSecretResource({ scope, resourceId: args.secretId, expectedRevision: args.expectedUpdatedAt,
                    ...(args.name === undefined ? {} : { nextName: args.name }), ...(args.value === undefined ? {} : { nextValue: args.value }), executeAdmittedMutation,
                    decryptDataKeyEnvelope: async encryptedDataKey => {
                        const { encryption } = await account.resolveAccountEncryption(); account.assertCurrent();
                        return encryption ? encryption.decryptEncryptionKey(encryptedDataKey, scope) : null;
                    } });
                if (!result.ok) refusal(result.reason);
                return { revision: args.expectedUpdatedAt + 1 };
            },
            delete: async args => {
                const baseline = await readProfileTransferSourceInContext(account);
                const result = await deleteSavedSecretResource({ scope, resourceId: args.secretId, expectedRevision: args.expectedUpdatedAt,
                    expectedSettingsVersion: baseline.source.version, executeAdmittedMutation });
                if (!result.ok) refusal(result.reason, 'references' in result ? { references: result.references } : undefined);
            },
        });
        return execute(actionId, input);
    };
}
