import { logger } from '@/ui/logger';

type ProviderBrokerApplicationPhase =
    | 'request_policy'
    | 'home_admission'
    | 'source_select'
    | 'source_open'
    | 'model_catalog_authorization'
    | 'operation_close'
    | 'upstream_forward';

/** Host-private diagnostic context, never a public refusal or Provider error
 * property. Keep the original error only for the application's safe classifier. */
export class ProviderBrokerApplicationPhaseError extends Error {
    constructor(
        readonly phase: ProviderBrokerApplicationPhase,
        readonly brokerRequestId: string,
        cause: unknown,
    ) {
        super('Provider broker application phase failed', { cause });
        this.name = 'ProviderBrokerApplicationPhaseError';
    }
}

export async function runProviderBrokerApplicationPhase<T>(
    phase: ProviderBrokerApplicationPhase,
    brokerRequestId: string,
    run: () => Promise<T>,
): Promise<T> {
    const record = (outcome: 'started' | 'completed' | 'failed'): void => {
        try {
            logger.infoFile('[provider-broker-application]', { stage: 'phase', phase, brokerRequestId, outcome });
        } catch { /* Diagnostics cannot change request custody or its outcome. */ }
    };
    record('started');
    try {
        const result = await run();
        record('completed');
        return result;
    } catch (error) {
        record('failed');
        // Admission contains source selection, Home admission and source open.
        // Preserve the innermost failed boundary rather than relabelling it.
        if (error instanceof ProviderBrokerApplicationPhaseError) throw error;
        throw new ProviderBrokerApplicationPhaseError(phase, brokerRequestId, error);
    }
}
