import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ArtifactActionOutputSchemasV1, ArtifactPublicLinkCreateInputV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { SessionPublicLinkCreateActionInputV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createSessionAccessClient } from '@/sync/api/session/sessionAccessApi';
import type { SessionPublicVisualNetworkConsequence } from '@/sync/api/session/sessionPublicVisualNetworkConsequence';
import { Modal } from '@/modal';
import { HappyError } from '@/utils/errors/errors';
import { t } from '@/text';
import { PublicLinkNetworkConfirmation, describePublicLinkNetworkConsequence,
    hasSamePublicLinkNetworkConsequence, hasSamePublicLinkNetworkPolicy } from './PublicLinkNetworkConfirmation';
import { prepareArtifactPublicNetworkOff, readArtifactPublicNetworkResource,
    type ArtifactPublicNetworkOpenedV1, type ArtifactPublicNetworkResourceV1 } from './documents/artifactPublicNetworkPreparation';

type Executor = ReturnType<typeof createDefaultActionExecutor>;

/** Human preparation only; the original generic approval remains the sole issuance/replay. */
export async function preparePublicLinkApproval(input: Readonly<{
    approval: ApprovalRequest; account: LazyActionAccountContext; executor: Executor; isCurrent: () => boolean; signal: AbortSignal;
}>): Promise<Readonly<{ kind: 'continue'; narrowedInput?: unknown }> | Readonly<{ kind: 'handled' }>> {
    const { approval, account, executor, isCurrent } = input;
    const scope = { serverId: account.serverId, accountId: account.accountId };
    const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
    const check = () => { input.signal.throwIfAborted(); account.assertCurrent(); if (!isCurrent()) throw new HappyError(t('errors.permissionDenied'), false); };
    let available = false;
    let label = t('session.collaboration.pane.linkNetworkUnknown');
    let initiallyOff = false;
    let sessionInput: ReturnType<typeof SessionPublicLinkCreateActionInputV1Schema.parse> | null = null;
    let sessionConsequence: SessionPublicVisualNetworkConsequence | null = null;
    let opened: ArtifactPublicNetworkOpenedV1 | null = null;
    let resource: ArtifactPublicNetworkResourceV1 | null = null;
    check();
    if (approval.actionId === 'session.public_link.create') {
        sessionInput = SessionPublicLinkCreateActionInputV1Schema.parse(approval.actionArgs);
        initiallyOff = sessionInput.networkOff === true;
        const consequence = await createSessionAccessClient({ scope, sessionId: sessionInput.sessionId,
            availability: 'unavailable', isCurrent }).readPublicVisualNetworkConsequence();
        check();
        sessionConsequence = consequence;
        available = consequence.status === 'ready';
        if (consequence.status === 'ready') label = describePublicLinkNetworkConsequence(consequence);
    } else {
        const args = ArtifactPublicLinkCreateInputV1Schema.parse(approval.actionArgs);
        const result = await executor.execute('artifact.get', { artifactId: args.artifactId }, context);
        check();
        if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
        opened = ArtifactActionOutputSchemasV1['artifact.get'].parse(result.result).artifact;
        if (opened) {
            resource = await readArtifactPublicNetworkResource({ opened, scope, account, signal: input.signal });
            check();
            available = true;
            label = describePublicLinkNetworkConsequence({
                visualCount: opened.header.kind === 'html' || opened.header.kind === 'widget-definition.v1' ? 1 : 0,
                networkVisualCount: resource.policy.network === 'none' ? 0 : 1,
                policies: resource.policy.network === 'none' ? [] : [resource.policy],
            });
        }
    }
    const networkOff = await new Promise<boolean | null>((resolve) => {
        let settled = false;
        let modalId: string | null = null;
        let retirement: Readonly<{ dispose: () => void }> | undefined;
        const settle = (choice: boolean | null) => {
            if (settled) return;
            settled = true;
            retirement?.dispose();
            input.signal.removeEventListener('abort', cancel);
            resolve(choice);
        };
        const cancel = () => { settle(null); if (modalId) Modal.hide(modalId); };
        modalId = Modal.show({ component: PublicLinkNetworkConfirmation,
            props: { label, available, initiallyOff, onConfirm: (off: boolean) => settle(off) },
            chrome: { kind: 'card', header: 'none', title: t('session.sharing.publicLink'), phonePresentation: 'sheet' },
            onHostUnmount: () => settle(null), onRequestClose: () => settle(null),
        });
        input.signal.addEventListener('abort', cancel, { once: true });
        retirement = account.accountLifetime.onRetire(cancel);
        if (settled) retirement?.dispose();
        if (input.signal.aborted) cancel();
    });
    if (networkOff === null || !isCurrent()) return { kind: 'handled' };
    check();
    if (sessionInput) {
        if (!networkOff) {
            const current = await createSessionAccessClient({ scope, sessionId: sessionInput.sessionId,
                availability: 'unavailable', isCurrent }).readPublicVisualNetworkConsequence();
            check();
            if (current.status !== 'ready' || sessionConsequence?.status !== 'ready'
                || !hasSamePublicLinkNetworkConsequence(sessionConsequence, current)) {
                throw new HappyError(t('approvals.staleFailure'), true, { code: 'approval_stale' });
            }
        }
        return { kind: 'continue', ...(networkOff && !sessionInput.networkOff
            ? { narrowedInput: { ...sessionInput, networkOff: true } } : {}) };
    }
    if (!opened || !resource) return { kind: 'handled' };
    const artifactId = opened.artifactId;
    const readCurrentArtifact = async () => {
        const result = await executor.execute('artifact.get', { artifactId }, context);
        check();
        if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
        const currentOpened = ArtifactActionOutputSchemasV1['artifact.get'].parse(result.result).artifact;
        if (!currentOpened) throw new HappyError(t('approvals.staleFailure'), true, { code: 'approval_stale' });
        const currentResource = await readArtifactPublicNetworkResource({ opened: currentOpened, scope, account, signal: input.signal });
        check();
        return { opened: currentOpened, resource: currentResource };
    };
    const current = await readCurrentArtifact();
    if (!networkOff && !hasSamePublicLinkNetworkPolicy(resource.policy, current.resource.policy)) {
        throw new HappyError(t('approvals.staleFailure'), true, { code: 'approval_stale' });
    }
    if (networkOff) {
        const prepared = await prepareArtifactPublicNetworkOff({ ...current, isCurrent, request: async (actionId, payload) => {
            check();
            const result = await executor.execute(actionId, payload, context);
            check();
            if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
            const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
            if (pending.success) {
                Modal.alert(t('approvals.title'), t('approvals.status.open'));
                return null;
            }
            return result.result;
        } });
        if (prepared.kind !== 'ready') return { kind: 'handled' };
        if ((await readCurrentArtifact()).resource.policy.network !== 'none') {
            throw new HappyError(t('approvals.staleFailure'), true, { code: 'approval_stale' });
        }
    }
    check();
    return { kind: 'continue' };
}
