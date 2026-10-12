import { inspectActiveRuntimeSnapshot } from '../../runtime/launch/inspectActiveRuntimeSnapshot.mjs';
import { resolveServerRuntimeLaunchSpec } from '../../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';

export async function resolveDevPriorRuntimeServer(
  { stackBaseDir, serverComponentName } = {},
  { inspectActiveRuntimeSnapshotImpl = inspectActiveRuntimeSnapshot } = {},
) {
  // Infrastructure remains startDevServer's responsibility for the full
  // server. Both flavors can admit a retained executable without source builds.
  if (!['happier-server-light', 'happier-server'].includes(serverComponentName)) {
    return {
      admitted: false,
      reason: 'unsupported_server_component',
      detail: null,
    };
  }

  const inspection = await inspectActiveRuntimeSnapshotImpl({ stackBaseDir, requiredComponents: ['server'] });
  if (!inspection?.snapshot) {
    return {
      admitted: false,
      reason: inspection?.missing === true ? 'missing_snapshot' : 'invalid_snapshot',
      detail: String(inspection?.errors?.[0] ?? '').trim() || null,
    };
  }

  try {
    const launchSpec = resolveServerRuntimeLaunchSpec({
      serverComponent: serverComponentName,
      dbProvider: 'sqlite',
      snapshot: inspection.snapshot,
      migrationsEnabled: false,
    });
    return {
      admitted: true,
      snapshotId: inspection.snapshot.snapshotId ?? null,
      sourceFingerprint: inspection.snapshot.sourceFingerprint ?? null,
      launchSpec,
    };
  } catch (error) {
    return {
      admitted: false,
      reason: error?.code === 'ERUNTIMESERVERCOMPONENTMISMATCH'
        ? 'server_component_mismatch'
        : 'invalid_server_launch',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
