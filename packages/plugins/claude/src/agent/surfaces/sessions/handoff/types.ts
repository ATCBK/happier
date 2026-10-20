import type { HandoffImportResultV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { z } from 'zod/mini';

import { hasClaudeProviderIdentityValue } from '../../../../protocol/providerIdentity.js';
import type { ClaudeExternalSessionSource } from '../external/source.js';

export const ClaudeSessionBundleSchema = z.strictObject({
    agentId: z.literal('claude'),
    remoteSessionId: z.string().check(z.refine(hasClaudeProviderIdentityValue, {
        message: 'Claude handoff bundle requires a vendor session id',
    })),
    transcriptBase64: z.optional(z.string()),
    transcriptFile: z.optional(z.strictObject({
        t: z.literal('happier.handoff.file.v1'),
        filePath: z.string().check(z.minLength(1)),
        offsetBytes: z.number().check(z.int(), z.nonnegative()),
        sizeBytes: z.number().check(z.int(), z.nonnegative()),
    })),
}).check(z.refine((bundle) => Boolean(bundle.transcriptBase64) !== Boolean(bundle.transcriptFile), { message: 'Claude handoff bundle requires exactly one transcript source' }));

export type ClaudeHandoffBundleFile = Readonly<{
    t: 'happier.handoff.file.v1';
    filePath: string;
    offsetBytes: number;
    sizeBytes: number;
}>;

export type ClaudeSessionBundle = Readonly<{
    agentId: 'claude';
    remoteSessionId: string;
}> & (
    | Readonly<{ transcriptBase64: string; transcriptFile?: never }>
    | Readonly<{ transcriptFile: ClaudeHandoffBundleFile; transcriptBase64?: never }>
);

export type ImportedClaudeSessionHandoffBundle = HandoffImportResultV1 & Readonly<{
    directSource: ClaudeExternalSessionSource;
}>;
