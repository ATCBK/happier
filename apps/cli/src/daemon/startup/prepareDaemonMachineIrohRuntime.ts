import type { HomeApplicationCarrierEligibility } from '@happier-dev/cli-common/homeEnrollment';
import { createDaemonMachineIrohRuntime } from '../peer/iroh/daemonMachineIrohRuntime';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { reportAccountConnectionProviderBrokerOpenFailure, withAccountConnectionProviderBrokerFailureDiagnostic, type OpenAccountConnectionProviderBrokerAccess } from '@/providers/broker/accountConnectionClient';
import { logger } from '@/ui/logger';

export function createNativeRuntimeAbsentProviderBrokerError(request: Parameters<OpenAccountConnectionProviderBrokerAccess>[0]) {
  const diagnostic = { reason: 'native_runtime_absent' } as const;
  reportAccountConnectionProviderBrokerOpenFailure(diagnostic);
  return withAccountConnectionProviderBrokerFailureDiagnostic(createProviderErrorV1('provider_endpoint_unavailable', {
    connectionId: request.connectionId, machineId: request.targetMachineId,
  }), diagnostic);
}

/** The daemon startup policy; Home transport selection remains independent. */
export async function prepareDaemonMachineIrohRuntime(input: Readonly<{
  applicationCarrierEligibility: HomeApplicationCarrierEligibility;
  readRuntimeOptions(): Parameters<typeof createDaemonMachineIrohRuntime>[0];
}>) {
  const runtime = input.applicationCarrierEligibility === 'standard_only'
    ? null : await createDaemonMachineIrohRuntime(input.readRuntimeOptions());
  const decision = runtime?.available
    ? { status: 'created', reason: input.applicationCarrierEligibility } as const
    : { status: 'skipped', reason: runtime?.reason ?? 'standard_only' } as const;
  try { logger.infoFile('[DAEMON RUN] Native Machine Iroh runtime decision', decision); }
  catch { /* Diagnostics cannot change startup or cleanup custody. */ }
  return runtime;
}
