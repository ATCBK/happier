import { bindPublicProfileActionPorts, type PublicProfileActionPorts } from '@happier-dev/protocol/actions/executor/publicProfileActions';
import { ScmHostingRepositoryGetResponseV1Schema, type ScmHostingRepositoryGetRequestV1 } from '@happier-dev/protocol/scm/repositoryClone';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { LazyActionAccountContext } from './actionAccountContext';
import type { UsageActionPorts } from '@happier-dev/protocol/actions/executor/usageActions';

/** Account custody and the incumbent SCM/Usage ports are the UI's only responsibilities. */
export function createUiPublicProfileActionPorts(account: LazyActionAccountContext,
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>, usage: UsageActionPorts,
  executeScmAction: (actionId: 'scm.hostingRepository.get', input: ScmHostingRepositoryGetRequestV1,
    context: ActionExecutorContext) => Promise<ActionExecuteResult>): PublicProfileActionPorts {
  return bindPublicProfileActionPorts({ homeDomainAction, usage,
    assertCurrent: context => { context.signal?.throwIfAborted(); account.assertCurrent(); },
    getRepository: async (selector, context) => {
      account.assertCurrent();
      const machineId = context.externalActionTarget?.kind === 'machine'
        ? context.externalActionTarget.machineId : context.defaultSessionMachineId;
      if (!machineId) return { success: true, kind: 'unsupported' };
      const execution = await executeScmAction('scm.hostingRepository.get', { selector },
        { ...context, serverId: account.serverId, externalActionTarget: { kind: 'machine', machineId } });
      account.assertCurrent();
      context.signal?.throwIfAborted();
      if (!execution.ok) return execution;
      const parsed = ScmHostingRepositoryGetResponseV1Schema.safeParse(execution.result);
      return parsed.success ? parsed.data : { success: false, kind: 'failed', code: 'repository_unavailable' };
    },
  });
}
