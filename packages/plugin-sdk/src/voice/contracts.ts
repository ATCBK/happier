import type * as z from 'zod/mini';
import type { VoiceCredentialAccessPhase } from '@happier-dev/protocol/plugins/contributions/voice';
import type { ConnectedAccountMaterializationRequest } from '@happier-dev/protocol/connect/connected-account-purposes';
import type { ConnectedAccountMaterialization } from '../connected-accounts/materialization.js';
import type { PluginCancellationOptions } from '../lifecycle.js';
import type { VoiceRealtimeJsonValue } from '@happier-dev/protocol/voice/realtime';

/** Native Mini schema; exported Protocol schemas retain their exact runtime identity. */
export type VoiceSchema<TOutput> = z.ZodMiniType<TOutput>;

export type VoiceAccountOperationService = Readonly<{
    request(input: Readonly<{
        operationId: string;
        parameters: Readonly<Record<string, VoiceRealtimeJsonValue>>;
        signal: AbortSignal;
    }>): Promise<Readonly<{
        status: number;
        finalUrl: string;
        headers: Readonly<Record<string, string>>;
        body: Uint8Array;
    }>>;
}>;

export type VoiceRawCredentialAccess = Readonly<{
    materialize(request: ConnectedAccountMaterializationRequest, options?: PluginCancellationOptions): Promise<ConnectedAccountMaterialization>;
}>;

export type VoiceCredentialAccess<P extends VoiceCredentialAccessPhase> = Readonly<{
    phase: P;
    mediated: VoiceAccountOperationService | null;
    raw: VoiceRawCredentialAccess | null;
}>;
