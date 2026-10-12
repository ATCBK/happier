import { z } from 'zod';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH } from '@happier-dev/protocol/connect/connected-account-request-auth';

// Opaque host-native purpose address, not an executable plugin declaration,
// source-custody identity, or HostAccess grant. The purpose owner admits its host
// target only under an authenticated issuer's mcp_request_auth subject.
export const MCP_REQUEST_AUTH_PURPOSE = Object.freeze({
  consumer: Object.freeze({ pluginId: 'happier.mcp', localId: 'remote-bridge' }),
  purpose: 'mcp-server',
});

const MaterializationId = z.string().trim().min(1).max(CONNECTED_ACCOUNT_REQUEST_AUTH_MATERIALIZATION_ID_MAX_LENGTH);
export const McpRequestAuthOpenV1Schema = z.object({
  kind: z.literal('mcp.request_auth.open'),
  requestId: z.string().trim().min(1).max(512),
  serverId: z.string().trim().min(1).max(256),
  resource: z.string().url(),
  materializationId: MaterializationId,
  executionRun: z.object({ runId: z.string().trim().min(1).max(512), occurrenceId: z.string().trim().min(1).max(512) }).strict().optional(),
}).strict();
export const McpRequestAuthCloseV1Schema = z.object({
  kind: z.literal('mcp.request_auth.close'), requestId: z.string().trim().min(1).max(512), materializationId: MaterializationId,
}).strict();
export const McpRequestAuthResultV1Schema = z.object({
  kind: z.literal('mcp.request_auth'), capabilityFile: z.string().min(1), resource: z.string().url(),
}).strict();
export const McpRequestAuthClosedV1Schema = z.object({ kind: z.literal('mcp.request_auth.closed') }).strict();
export type McpRequestAuthCapability = Omit<z.infer<typeof McpRequestAuthResultV1Schema>, 'kind'>;
export type McpRequestAuthPort = Readonly<{
  open(input: Omit<z.infer<typeof McpRequestAuthOpenV1Schema>, 'kind' | 'requestId'>): Promise<McpRequestAuthCapability>;
  close(input: Omit<z.infer<typeof McpRequestAuthCloseV1Schema>, 'kind' | 'requestId'>): Promise<void>;
}>;
