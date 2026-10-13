import { createHash } from 'node:crypto';

import { asRecord, normalizeString, readStringRecord } from './openCodeParsing.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { isOpenCodeServerUnsupportedOperation } from './openCodeServerClient.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

export type OpenCodeMcpRegistration = Readonly<{
  originalName: string;
  projectedName: string;
  config: Readonly<Record<string, unknown>>;
}>;

export type OpenCodeSessionMcpProjection = Readonly<{
  registrations: readonly OpenCodeMcpRegistration[];
  requiredHappierServerName: string | null;
  requiredHappierConfigurationPresent: boolean;
}>;

export type OpenCodeRegisteredMcpServer = Readonly<{ directory: string; name: string }>;

const OPEN_CODE_MCP_NAMESPACE_MAX_LENGTH = 64;
const OPEN_CODE_MCP_NAMESPACE_DIGEST_LENGTH = 16;

export function sanitizeOpenCodeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function projectOpenCodeMcpName(runtimeIdentity: string, originalName: string): string {
  const candidate = sanitizeOpenCodeMcpName(`happier-session-${runtimeIdentity}--${originalName}`);
  if (candidate.length <= OPEN_CODE_MCP_NAMESPACE_MAX_LENGTH) return candidate;

  const digest = createHash('sha256')
    .update(runtimeIdentity)
    .update('\0')
    .update(originalName)
    .digest('hex')
    .slice(0, OPEN_CODE_MCP_NAMESPACE_DIGEST_LENGTH);
  const prefixLength = OPEN_CODE_MCP_NAMESPACE_MAX_LENGTH - digest.length - 1;
  return `${candidate.slice(0, prefixLength)}-${digest}`;
}

/**
 * `unsupported` is deliberately not a kind of `failed`.
 *
 * `failed` means the reachable server has a dynamic MCP registration route and
 * would not complete this registration: Happier's own tools would be silently
 * missing, so prompt admission fails closed. `unsupported` means the server
 * declares no such route at all — the standalone OpenCode V2 protocol has no
 * MCP group. Failing every ordinary prompt closed over a route that never
 * existed would remove core agent use to protect an integration that cannot
 * exist there, so the session continues without Happier's MCP-backed tools and
 * reports the exact limitation on a default-on signal.
 */
export type OpenCodeMcpRegistrationResult = Readonly<{
  requiredHappier: Readonly<
    | { status: 'ready' }
    | { status: 'failed'; error: unknown }
    | { status: 'unsupported'; reason: string }
  >;
  registeredServers: readonly OpenCodeRegisteredMcpServer[];
}>;

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value
      .map((entry) => normalizeString(entry))
      .filter((entry) => entry.length > 0),
  );
}

function readEnvironment(value: unknown): Readonly<Record<string, string>> | null {
  const record = readStringRecord(value);
  const entries = Object.entries(record)
    .filter(([key, entry]) => key.length > 0 && typeof entry === 'string');
  if (entries.length === 0) return null;
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

function readOpenCodeMcpRegistrations(raw: unknown): readonly Readonly<{
  name: string;
  config: Readonly<Record<string, unknown>>;
}>[] {
  const servers = asRecord(raw);
  if (!servers) return Object.freeze([]);

  const registrations: Array<Readonly<{
    name: string;
    config: Readonly<Record<string, unknown>>;
  }>> = [];
  for (const [rawName, rawConfig] of Object.entries(servers)) {
    const name = normalizeString(rawName);
    const config = asRecord(rawConfig);
    const command = normalizeString(config?.command);
    if (!name || !command) continue;

    const args = readStringArray(config?.args);
    const environment = readEnvironment(config?.env);
    registrations.push(Object.freeze({
      name,
      config: Object.freeze({
        type: 'local',
        enabled: true,
        command: Object.freeze([command, ...args]),
        ...(environment ? { environment } : {}),
      }),
    }));
  }

  return Object.freeze(registrations);
}

export function buildOpenCodeSessionMcpProjection(
  runtimeIdentity: string,
  raw: unknown,
): OpenCodeSessionMcpProjection {
  const identity = sanitizeOpenCodeMcpName(runtimeIdentity.trim());
  if (!identity) throw new Error('OpenCode MCP projection requires a runtime identity');
  const registrations = readOpenCodeMcpRegistrations(raw).map(({ name, config }) => Object.freeze({
    originalName: name,
    projectedName: projectOpenCodeMcpName(identity, name),
    config,
  }));
  return Object.freeze({
    registrations: Object.freeze(registrations),
    requiredHappierServerName:
      registrations.find(({ originalName }) => originalName === 'happier')?.projectedName ?? null,
    requiredHappierConfigurationPresent:
      Object.prototype.hasOwnProperty.call(asRecord(raw) ?? {}, 'happier'),
  });
}

export function canonicalizeOpenCodeProjectedMcpToolName(
  rawToolName: string,
  projection: Readonly<{ registrations: readonly Readonly<{ originalName: string; projectedName: string }>[] }>,
  policy?: AgentSessionOpenRequest['mcpToolPolicy'],
): string {
  const trimmed = rawToolName.trim();
  const match = projection.registrations
    .map((registration) => ({ registration, alias: sanitizeOpenCodeMcpName(registration.projectedName) }))
    .filter(({ alias }) => trimmed.startsWith(`${alias}_`))
    .sort((left, right) => right.alias.length - left.alias.length)[0];
  if (!match) return rawToolName;
  const suffix = trimmed.slice(match.alias.length + 1).trim();
  const knownTools = Object.prototype.hasOwnProperty.call(policy ?? {}, match.registration.originalName)
    ? Object.keys(policy![match.registration.originalName]!.tools).filter((name) => sanitizeOpenCodeMcpName(name) === suffix)
    : [];
  if (knownTools.length > 1) return rawToolName;
  return suffix
    ? `mcp__${match.registration.originalName}__${knownTools[0] ?? suffix}`
    : rawToolName;
}

export async function registerOpenCodeMcpServers(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  client: OpenCodeServerClient;
  directory: string;
  mcpProjection: OpenCodeSessionMcpProjection;
}>): Promise<OpenCodeMcpRegistrationResult> {
  const registrations = params.mcpProjection.registrations;
  const registeredServers: OpenCodeRegisteredMcpServer[] = [];
  let requiredHappier: OpenCodeMcpRegistrationResult['requiredHappier'] = {
    status: 'failed',
    error: new Error(
      params.mcpProjection.requiredHappierConfigurationPresent
        ? 'required Happier MCP server command is missing'
        : 'required Happier MCP server configuration is missing',
    ),
  };
  for (const registration of registrations) {
    try {
      const registrationStatus = await params.client.mcpAdd({
        directory: params.directory,
        name: registration.projectedName,
        config: registration.config,
      });
      if (registrationStatus.status !== 'connected') {
        const detail = 'error' in registrationStatus ? `: ${registrationStatus.error}` : '';
        throw new Error(
          `OpenCode MCP server "${registration.originalName}" returned status "${registrationStatus.status}"${detail}`,
        );
      }
      registeredServers.push({ directory: params.directory, name: registration.projectedName });
      if (registration.originalName === 'happier') {
        requiredHappier = { status: 'ready' };
      }
    } catch (error) {
      if (isOpenCodeServerUnsupportedOperation(error, 'mcp_registration')) {
        const reason = error instanceof Error
          ? error.message
          : 'the reachable OpenCode server has no dynamic MCP registration route';
        if (registration.originalName === 'happier') {
          requiredHappier = { status: 'unsupported', reason };
        }
        // Default-on, because this silently removes every Happier MCP-backed
        // tool (including title updates) from an otherwise working session.
        params.ctx.logger.warn(
          '[OpenCodeServer] this server supports no dynamic MCP registration; continuing without Happier MCP tools',
          {
            serverName: registration.projectedName,
            dialect: error.dialect,
            reason,
          },
        );
        continue;
      }
      if (registration.originalName === 'happier') {
        requiredHappier = { status: 'failed', error };
      }
      params.ctx.logger.debug(
        registration.originalName === 'happier'
          ? '[OpenCodeServer] Required Happier MCP server registration failed; prompt admission will fail closed'
          : '[OpenCodeServer] Failed to register MCP server (non-fatal)',
        {
          serverName: registration.projectedName,
          error,
        },
      );
    }
  }
  return Object.freeze({
    requiredHappier: Object.freeze(requiredHappier),
    registeredServers: Object.freeze(registeredServers),
  });
}

export function scheduleOpenCodeMcpServerRegistration(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  client: OpenCodeServerClient;
  directory: string;
  mcpProjection: OpenCodeSessionMcpProjection;
}>): Promise<OpenCodeMcpRegistrationResult> {
  return (async () => {
    return await registerOpenCodeMcpServers({
      ctx: params.ctx,
      client: params.client,
      directory: params.directory,
      mcpProjection: params.mcpProjection,
    });
  })().catch((error: unknown) => {
    params.ctx.logger.debug(
      '[OpenCodeServer] MCP server registration setup failed; prompt admission will fail closed',
      { error },
    );
    return {
      requiredHappier: { status: 'failed', error },
      registeredServers: Object.freeze([]),
    } satisfies OpenCodeMcpRegistrationResult;
  });
}

export async function disconnectOpenCodeMcpServers(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  client: OpenCodeServerClient;
  registration: Promise<OpenCodeMcpRegistrationResult>;
}>): Promise<void> {
  const result = await params.registration;
  for (const server of result.registeredServers) {
    try {
      await params.client.mcpRemove(server);
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] Failed to disconnect session-scoped MCP server (non-fatal)', {
        ...server,
        error,
      });
    }
  }
}
