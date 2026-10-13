import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { Modal } from '@/modal';
import { ArtifactActionOutputSchemasV1, type ArtifactRevisionV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactOrganizationMutationFailureV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { encodeSkillRevisionV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { duplicatePromptBundle, SkillAcknowledgedEffectsFailureV1 } from '@/sync/ops/promptLibrary/promptBundles';
import { duplicatePromptDoc } from '@/sync/ops/promptLibrary/promptDocs';
import { t } from '@/text';

import { buildPromptAssetExportHref } from '../shared/buildPromptAssetExportHref';
import { promptCollectionItemHref } from './promptCollectionModel';

/**
 * The rare operations on a saved prompt or skill, offered by its editor's `⋯` menu: duplicate it
 * (opening the copy), manage where it is exported, and delete it after confirmation.
 * References stay authoritative: a required missing document must be explicitly repaired or detached.
 */
export function usePromptLibraryEntryActions(kind: 'doc' | 'bundle', requestedScope?: ServerAccountScope | null,
    review?: Readonly<{ expectedRevision?: ArtifactRevisionV1; assertCurrent?(): void }>) {
    const router = useRouter();
    const activeScope = useAccountSettingsScope();
    const scope = requestedScope === undefined ? activeScope : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const { execute } = useMountedActionExecution(scope);

    /** Resolves `true` once the item is gone, so its editor can leave. */
    const remove = React.useCallback(async (artifactId: string): Promise<boolean> => {
        // Actual skills use their Action's D22 confirmation; document deletion
        // retains its existing generic Artifact presentation.
        if (kind === 'doc') {
            const confirmed = await Modal.confirm(t('promptLibrary.deleteLibraryItemTitle'), t('promptLibrary.deleteLibraryItemBody'),
                { confirmText: t('common.delete'), destructive: true });
            if (!confirmed) return false;
        }

        if (!serverId || !accountId) {
            Modal.alert(t('common.error'), t('errors.unknownError'));
            return false;
        }

        let context: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        const controller = new AbortController();
        let retirement: Readonly<{ dispose(): void }> | undefined;
        try {
            review?.assertCurrent?.();
            context = await captureLazyActionAccountContext(serverId);
            if (context.accountId !== accountId) throw new Error('action_account_scope_changed');
            retirement = context.accountLifetime.onRetire(() => controller.abort());
            const actionContext = { signal: controller.signal };
            let expectedRevision = review?.expectedRevision;
            let isSkill = false;
            if (!expectedRevision || kind === 'bundle') {
                const opened = await execute('artifact.get', { artifactId }, actionContext);
                if (!opened.ok) throw new Error(opened.errorCode);
                const document = ArtifactActionOutputSchemasV1['artifact.get'].parse(opened.result).artifact;
                if (!document) throw new Error('not_found');
                expectedRevision ??= document.revision;
                if (kind === 'bundle' && (!document.header || typeof document.header.bundleSchemaId !== 'string'))
                    throw new Error('bundle_identity_unavailable');
                isSkill = document.header?.kind === 'prompt_bundle.v2' && document.header.bundleSchemaId === 'skills.skill_md_v1';
            }
            context.assertCurrent();
            review?.assertCurrent?.();
            if (isSkill) {
                const deleted = await execute('skills.delete', { skillId: artifactId, expectedRevision: encodeSkillRevisionV1(expectedRevision) }, actionContext);
                if (!deleted.ok) throw new Error(deleted.errorCode);
                const output = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.delete'].parse(deleted.result);
                if (output.rulesLeft) Modal.alert(t('common.error'), t('promptLibrary.saveError'));
                // Content deletion is acknowledged even if later cleanup or cancellation occurs.
                return true;
            }
            if (kind === 'bundle') {
                const confirmed = await Modal.confirm(t('promptLibrary.deleteLibraryItemTitle'), t('promptLibrary.deleteLibraryItemBody'),
                    { confirmText: t('common.delete'), destructive: true });
                if (!confirmed) return false;
                context.assertCurrent(); review?.assertCurrent?.();
            }
            const deleted = await execute('artifact.delete', { artifactId, expectedRevision }, actionContext);
            if (!deleted.ok) throw new Error(deleted.errorCode);
            ArtifactActionOutputSchemasV1['artifact.delete'].parse(deleted.result);
            context.assertCurrent();
            review?.assertCurrent?.();
            return true;
        } catch {
            Modal.alert(t('common.error'), t('errors.unknownError'));
            return false;
        } finally { retirement?.dispose(); context?.dispose(); }
    }, [kind, accountId, serverId, execute, review?.assertCurrent, review?.expectedRevision]);

    const duplicate = React.useCallback(async (artifactId: string) => {
        let context: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
        const controller = new AbortController();
        let retirement: Readonly<{ dispose(): void }> | undefined;
        try {
            review?.assertCurrent?.();
            if (!serverId || !accountId) throw new Error('action_account_scope_changed');
            context = await captureLazyActionAccountContext(serverId);
            if (context.accountId !== accountId) throw new Error('action_account_scope_changed');
            retirement = context.accountLifetime.onRetire(() => controller.abort());
            const nextArtifactId = kind === 'doc'
                ? await duplicatePromptDoc(artifactId, { serverId: context.serverId, expectedAccountId: context.accountId,
                    signal: controller.signal, executeAction: execute })
                : await duplicatePromptBundle(artifactId, { serverId: context.serverId, expectedAccountId: context.accountId,
                    signal: controller.signal, executeAction: execute });
            context.assertCurrent();
            review?.assertCurrent?.();
            router.push(promptCollectionItemHref(kind, nextArtifactId, { serverId }) as never);
        } catch (error) {
            if (error instanceof SkillAcknowledgedEffectsFailureV1 && context && error.details.skillIds[0]) {
                try {
                    context.assertCurrent(); review?.assertCurrent?.();
                    router.push(promptCollectionItemHref(kind, error.details.skillIds[0], { serverId: context.serverId }) as never);
                } catch { /* A retired captured Home cannot adopt the copied Artifact. */ }
            }
            if (error instanceof ArtifactOrganizationMutationFailureV1 && context) {
                try {
                    context.assertCurrent();
                    review?.assertCurrent?.();
                    router.push(promptCollectionItemHref(kind, error.details.artifactId, { serverId: context.serverId }) as never);
                } catch { /* A retired captured Home cannot adopt the copied Artifact. */ }
            }
            Modal.alert(t('common.error'), t('errors.unknownError'));
        } finally { retirement?.dispose(); context?.dispose(); }
    }, [kind, router, serverId, accountId, execute, review?.assertCurrent]);

    const manageExternalAssets = React.useCallback((artifactId: string) => {
        if (!serverId) return;
        router.push(buildPromptAssetExportHref({ artifactId, libraryKind: kind, serverId }) as never);
    }, [kind, router, serverId]);

    return { remove, duplicate, manageExternalAssets } as const;
}
