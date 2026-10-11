import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';


/** Only the incumbent new-operation prerequisite may produce this refusal, before Sync effects. */
export class WorkspaceSyncInitialPreparationRefusal extends Error {
  readonly code: string | undefined;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Workspace Sync preparation is unavailable', { cause });
    this.name = 'WorkspaceSyncInitialPreparationRefusal';
    this.code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
  }
}

/** The finite requester transport cannot own persistent or remote-source bootstrap effects. */
export function assertWorkspaceSyncRequesterBootstrapSupported(input: Readonly<{
  authorization?: ExternalActionExecutionAuthorizationV1;
  ownerKind: 'copy_once' | 'relationship';
  targetReplacement?: boolean;
  materializesRemoteSource?: boolean;
}>): void {
  if (input.authorization && (input.ownerKind !== 'copy_once'
    || input.targetReplacement || input.materializesRemoteSource)) {
    throw Object.assign(new Error('The original requester bootstrap effect owner is unavailable'), {
      code: 'workspace_sync_update_required',
    });
  }
}
