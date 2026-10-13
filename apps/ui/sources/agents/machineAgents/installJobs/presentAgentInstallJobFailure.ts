import { t } from '@/text';
import type { MachineAgentJob } from '../machineAgentTypes';
import { AgentInstallJobRpcError } from './api';

/** Transport and lookup failures do not establish an installer outcome. */
export function presentAgentInstallJobRpcFailure(error: unknown): Readonly<{ code: string; title: string; body: string }> {
    const code = error instanceof AgentInstallJobRpcError ? error.code : 'unknown';
    if (code === 'unavailable' || code === 'install_unavailable') {
        return { code, title: t('agentInstallJob.jobUnavailable'), body: t('agentInstallJob.jobUnavailableBody') };
    }
    if (code === 'request_failed') {
        return { code, title: t('agentInstallJob.machineUnreachable'), body: t('agentInstallJob.unreachableBody') };
    }
    if (code === 'job_not_found') {
        return { code, title: t('agentInstallJob.jobMissing'), body: t('agentInstallJob.jobMissingBody') };
    }
    return { code, title: t('agentInstallJob.failed'), body: t('agentInstallJob.failedBody') };
}

/** Display uncertainty is not a daemon installer outcome. */
export type AgentInstallJobFailurePresentationInput =
    | Extract<NonNullable<MachineAgentJob['outcome']>, { kind: 'failed' }>
    | Readonly<{ kind: 'failed'; code: 'unknown'; stepId: null; message: null; guideUrl?: never }>;

export type AgentInstallJobFailurePresentation = Readonly<{
    code: AgentInstallJobFailurePresentationInput['code'];
    title: string;
    body: string;
    recovery: Readonly<{ kind: 'retry' | 'guide' | 'chooseAgent' | 'reconnect'; label: string; guideUrl?: string }>;
}>;

export function presentAgentInstallJobFailure(
    failure: AgentInstallJobFailurePresentationInput,
): AgentInstallJobFailurePresentation {
    const copy = (() => {
        switch (failure.code) {
            case 'consent_required': return { title: t('agentInstallJob.consentRequired'), body: t('agentInstallJob.consentBody'), kind: 'retry' } as const;
            case 'unsupported_platform': return { title: t('agentInstallJob.unsupportedPlatform'), body: t('agentInstallJob.unsupportedBody'), kind: 'chooseAgent' } as const;
            case 'install_not_available': return { title: t('agentInstallJob.manualInstall'), body: t('agentInstallJob.manualBody'), kind: 'guide' } as const;
            case 'update_not_available': return { title: t('agentInstallJob.updateUnavailable'), body: t('agentInstallJob.updateBody'), kind: 'guide' } as const;
            case 'download_failed': return { title: t('agentInstallJob.downloadFailed'), body: t('agentInstallJob.downloadBody'), kind: 'retry' } as const;
            case 'verification_failed': return { title: t('agentInstallJob.verificationFailed'), body: t('agentInstallJob.verificationBody'), kind: 'retry' } as const;
            case 'timeout': return { title: t('agentInstallJob.timeout'), body: t('agentInstallJob.timeoutBody'), kind: 'retry' } as const;
            case 'cancelled': return { title: t('agentInstallJob.cancelled'), body: t('agentInstallJob.cancelledBody'), kind: 'retry' } as const;
            default: return { title: t('agentInstallJob.failed'), body: t('agentInstallJob.failedBody'), kind: 'retry' } as const;
        }
    })();
    const kind = copy.kind === 'guide' && !failure.guideUrl ? 'chooseAgent' : copy.kind;
    const label = kind === 'guide' ? t('agentInstallJob.openGuide')
        : kind === 'chooseAgent' ? t('agentInstallJob.chooseAgent') : t('agentInstallJob.retry');
    return { code: failure.code, title: copy.title, body: copy.body, recovery: { kind, label, ...(kind === 'guide' ? { guideUrl: failure.guideUrl } : {}) } };
}
