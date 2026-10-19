import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { z } from 'zod/mini';

import type { SessionProviderInputConsumer } from './_types';
import { registerSessionGuardNoticeRpc, type SessionGuardNoticeOwner } from './sessionGuardNoticeRpc';

export const SessionInputLiveWorkSchema = z.strictObject({
  session: z.enum(['active', 'settled', 'unknown']),
  input: z.enum(['active', 'settled', 'unknown']),
  agents: z.optional(z.enum(['active', 'settled', 'unknown'])),
  attention: z.optional(z.enum(['active', 'settled', 'unknown'])),
  agentsActiveCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  settledAt: z.optional(z.number().check(z.int(), z.nonnegative())),
});

const groupEnforceSchema = z.object({
  action: z.literal('enforce'),
  serviceId: z.string().check(z.trim(), z.minLength(1)),
  groupId: z.string().check(z.trim(), z.minLength(1)),
  reason: z.optional(z.enum(['group_unavailable', 'generation_pending'])),
  epochId: z.optional(z.string().check(z.trim(), z.minLength(1))),
});
const admissionRequestSchema = z.union([
  groupEnforceSchema,
  z.object({
    action: z.literal('clear'),
    serviceId: z.string().check(z.trim(), z.minLength(1)),
    groupId: z.string().check(z.trim(), z.minLength(1)),
    epochId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    applicationSettled: z.optional(z.literal(true)),
  }),
]).check(z.superRefine((request, ctx) => {
  if (
    request.action === 'enforce'
    && 'serviceId' in request
    && request.reason === 'generation_pending'
    && !request.epochId
  ) {
    ctx.addIssue({ code: "custom", message: 'generation_pending requires epochId' });
  }
}));

type AdmissionRequest = z.infer<typeof admissionRequestSchema>;

export function registerSessionProviderInputAdmissionRpc<Mode, Message>(params: Readonly<{
  consumer: SessionProviderInputConsumer<Mode, Message>;
  rpcHandlerRegistrar: RpcHandlerRegistrar;
  guardNotice?: SessionGuardNoticeOwner;
  onApplicationSettled?: (request: Readonly<{
    serviceId: string;
    groupId: string;
  }>) => Promise<void>;
}>): void {
  const guardNotice = params.guardNotice;
  if (guardNotice) registerSessionGuardNoticeRpc({
    get session() { return guardNotice.session; },
    machineId: guardNotice.machineId,
    agentId: guardNotice.agentId,
    notify: guardNotice.notify,
    rpcHandlerRegistrar: params.rpcHandlerRegistrar,
  });
  params.rpcHandlerRegistrar.registerHandler(
    SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION,
    async (raw: unknown) => {
      const activityRead = z.strictObject({ action: z.literal('activity_read') }).safeParse(raw);
      if (activityRead.success) return SessionInputLiveWorkSchema.parse(await params.consumer.readLiveWork());
      const request = admissionRequestSchema.parse(raw);
      if (request.action === 'enforce') {
        const disposition = request.reason === 'generation_pending'
          ? {
              kind: 'action_required' as const,
              reason: 'generation_pending' as const,
              serviceId: request.serviceId,
              groupId: request.groupId,
              epochId: request.epochId!,
            }
          : {
              kind: 'action_required' as const,
              reason: 'group_unavailable' as const,
              serviceId: request.serviceId,
              groupId: request.groupId,
            };
        await params.consumer.enforceProviderInputAdmission(disposition);
        return { status: 'enforced' as const };
      }
      const result = await params.consumer.clearProviderInputAdmission(request);
      if (result.status === 'cleared' && request.applicationSettled === true) {
        await params.onApplicationSettled?.({
          serviceId: request.serviceId,
          groupId: request.groupId,
        }).catch(() => undefined);
      }
      return result;
    },
  );
}

/** Read-only projection from the live host; unavailable predecessors remain unknown at the caller. */
export async function requestSessionInputLiveWork(params: Readonly<{
  callRpc: (method: string, request: Readonly<{ action: 'activity_read' }>) => Promise<unknown>;
}>): Promise<z.infer<typeof SessionInputLiveWorkSchema>> {
  return SessionInputLiveWorkSchema.parse(await params.callRpc(
    SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, { action: 'activity_read' },
  ));
}

export async function requestSessionProviderInputAdmission(params: Readonly<{
  callRpc: (method: string, request: AdmissionRequest) => Promise<unknown>;
}> & AdmissionRequest): Promise<Readonly<{ status: 'enforced' | 'cleared' | 'not_matched' }>> {
  const request = admissionRequestSchema.parse(params);
  const raw = await params.callRpc(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, request);
  const result = z.object({ status: z.enum(['enforced', 'cleared', 'not_matched']) }).parse(raw);
  if (request.action === 'enforce' && result.status !== 'enforced') {
    throw new Error('provider_input_admission_not_enforced');
  }
  return result;
}
