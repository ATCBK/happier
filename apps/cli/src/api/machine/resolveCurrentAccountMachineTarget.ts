import axios from 'axios';
import { z } from 'zod';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { AccessibleMachineAccessV1Schema, type AccessibleMachineAccessV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { DevcontainerChildProjectionV1Schema, type DevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { isMachineReachableV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { StoredMachinePublishedMetadataV1Schema, type MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { StoredCredentials } from '@/persistence';
import { resolvePublishedMachineContentCodec } from './machineDataEncryptionKey';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

// The machine bootstrap rows reuse the one Protocol-owned external Action
// bootstrap projection; this parser extends it only with the legacy/full-account
// `metadata` blob it genuinely needs. Labels and decoded platform facts remain
// CLI projections of that metadata and never alter machine identity.
const ACCOUNT_MACHINE_ROW_SCHEMA = ExternalActionMachineBootstrapV1Schema
  .extend({ metadata: z.string().optional(), activeAt: z.number().nullable().optional(), access: AccessibleMachineAccessV1Schema.optional(),
    devcontainerChild: z.optional(z.nullable(DevcontainerChildProjectionV1Schema)) })
  .passthrough();

const ACCOUNT_MACHINE_INVENTORY_SCHEMA = z.array(ACCOUNT_MACHINE_ROW_SCHEMA);

export type CurrentAccountMachineTarget = Readonly<{
  machineId: string;
  machineLabel: string;
}>;
export type CurrentAccountMachineInventoryItem = Readonly<{
  id: string; label: string; kind: 'persistent' | 'ephemeral_session_runner';
  active: boolean; revokedAt: number | null; replacedByMachineId: string | null;
  activeAt?: number | null;
  platform?: string;
  arch?: string;
  agentInventory?: MachinePublishedMetadataV1['agentInventory'];
  access?: AccessibleMachineAccessV1;
  operationProtocolCapabilities?: unknown;
  operationProtocolCapabilitiesRevision?: unknown;
  devcontainerChild?: DevcontainerChildProjectionV1;
}>;

export type CurrentAccountMachineTargetResolution =
  | Readonly<{ kind: 'selected'; target: CurrentAccountMachineTarget }>
  | Readonly<{ kind: 'selection_required'; candidates: readonly CurrentAccountMachineTarget[] }>
  | Readonly<{ kind: 'unavailable'; code: string; message: string }>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMachineLabel(metadata: string | undefined, fallback: string): string {
  if (!metadata) return fallback;
  try {
    const value: unknown = JSON.parse(metadata);
    if (!value || typeof value !== 'object') return fallback;
    return nonEmptyString((value as Readonly<Record<string, unknown>>).host) ?? fallback;
  } catch {
    return fallback;
  }
}

function unavailable(code: string, message: string): CurrentAccountMachineTargetResolution {
  return { kind: 'unavailable', code, message };
}

export async function listCurrentAccountMachines(params: Readonly<{
  token?: string;
  credentials?: StoredCredentials;
  authorization?: ExternalActionExecutionAuthorizationV1;
  effectActionId?: string;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
}>): Promise<readonly CurrentAccountMachineInventoryItem[]> {
  params.signal?.throwIfAborted();
  try {
    const serverHttpBaseUrl = params.serverHttpBaseUrl
      ? normalizeServerHttpBaseUrl(params.serverHttpBaseUrl)
      : params.authorization?.requesterHttpProjection?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
    const projection = params.authorization?.requesterHttpProjection;
    if (params.authorization && (!projection || projection.accountId !== params.authorization.binding.accountId
      || normalizeServerHttpBaseUrl(projection.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(serverHttpBaseUrl)
      || !await projection.isCurrent())) throw new Error('Requester Machine inventory authority is unavailable');
    if (!params.authorization && !params.token) throw new Error('Machine inventory authentication is unavailable');
    const headers = projection ? await projection.createRequestHeaders({
      effectActionId: params.effectActionId ?? params.authorization!.binding.actionId, method: 'GET', path: '/v1/machines',
      ...(params.signal ? { signal: params.signal } : {}),
    }) : { Authorization: `Bearer ${params.token}` };
    if (!headers) throw new Error('Requester Machine inventory authority is unavailable');
    const response = await axios.get<unknown>(`${serverHttpBaseUrl}/v1/machines`, {
      headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...headers },
      timeout: 20_000,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    params.signal?.throwIfAborted();
    if (projection && !await projection.isCurrent()) throw new Error('Requester Machine inventory authority retired');
    const inventory = ACCOUNT_MACHINE_INVENTORY_SCHEMA.safeParse(response.data);
    if (!inventory.success) throw new Error('invalid machine inventory');
    let accountMode: Promise<'plain' | 'e2ee' | 'unknown'> | undefined;
    const readAccountMode = (credentials: StoredCredentials) => accountMode ??= readAccountEncryptionModeOnce({ request: () => axios.get(
      `${serverHttpBaseUrl}/v1/account/encryption`, { headers: { Authorization: `Bearer ${credentials.token}` },
        timeout: 20_000, ...(params.signal ? { signal: params.signal } : {}) },
    ) }).then(mode => mode.kind === 'resolved' ? mode.mode : 'unknown' as const).catch(() => 'unknown' as const);
    return await Promise.all(inventory.data.map(async (row) => {
      let metadata: ReturnType<typeof StoredMachinePublishedMetadataV1Schema.parse> | undefined;
      if (params.credentials && row.metadata && (!row.access || row.access.accessState === 'ready')) {
        try {
          const declaredMode = row.access?.resourceMode ?? row.storageMode;
          const expectedAccountMode = declaredMode === 'plain' || declaredMode === 'e2ee' ? declaredMode : await readAccountMode(params.credentials);
          const codec = resolvePublishedMachineContentCodec({ credentials: params.credentials, machineId: row.id,
            expectedAccountMode, access: row.access, publishedDataEncryptionKey: row.dataEncryptionKey,
            machineKind: row.kind, installationId: typeof row.installationId === 'string' ? row.installationId : null,
            runnerContentKeyBinding: row.runnerContentKeyBinding });
          const decoded = StoredMachinePublishedMetadataV1Schema.safeParse(codec.decodeStored(row.metadata));
          if (decoded.success) metadata = decoded.data;
        } catch {
          // Unavailable or inconsistent content is unknown, never a plain fallback.
          params.signal?.throwIfAborted();
        }
      }
      params.signal?.throwIfAborted();
      return {
      id: row.id, label: metadata ? nonEmptyString(metadata.host) ?? row.id
        : params.credentials ? row.id : readMachineLabel(row.metadata, row.id), kind: row.kind, active: row.active,
      revokedAt: row.revokedAt, replacedByMachineId: row.replacedByMachineId,
      ...(row.activeAt === undefined ? {} : { activeAt: row.activeAt }),
      ...(metadata ? { platform: metadata.platform, ...(metadata.arch === undefined ? {} : { arch: metadata.arch }) } : {}),
      ...(metadata?.agentInventory ? { agentInventory: metadata.agentInventory } : {}),
      ...(row.access ? { access: row.access } : {}),
      ...(row.devcontainerChild ? { devcontainerChild: row.devcontainerChild } : {}),
      ...(row.operationProtocolCapabilities === undefined ? {} : { operationProtocolCapabilities: row.operationProtocolCapabilities }),
      ...(row.operationProtocolCapabilitiesRevision === undefined ? {} : { operationProtocolCapabilitiesRevision: row.operationProtocolCapabilitiesRevision }),
      };
    }));
  } catch (error) {
    params.signal?.throwIfAborted();
    throw Object.assign(new Error('The current machine inventory is unavailable.'), { code: 'machine_inventory_unavailable', cause: error });
  }
}

/** Background Account administration selects a reachable daemon in the exact Home. */
export async function resolveCurrentAccountAdministrationMachine(params: Parameters<typeof listCurrentAccountMachines>[0]
  & Readonly<{ preferredMachineId?: string | null }>): Promise<string | null> {
  const machines = await listCurrentAccountMachines(params);
  const reachable = machines.filter(machine => machine.kind === 'persistent' && !machine.replacedByMachineId
    && (!machine.access || machine.access.accessState === 'ready') && isMachineReachableV1({ machine, nowMs: Date.now() }));
  return reachable.find(machine => machine.id === params.preferredMachineId)?.id ?? reachable[0]?.id ?? null;
}

/**
 * Resolves an automatic current-daemon target from the authenticated account inventory.
 *
 * This is the single API-inventory owner for callers without an explicit
 * target or daemon-local default. An explicit machine id already names the
 * Action target, so it must not depend on inventory availability; the Action
 * ingress owns validating that target. Automatic selection accepts both the
 * stored credential inventory shape and the API-token bootstrap shape, whose
 * rows deliberately omit machine metadata.
 */
export async function resolveCurrentAccountMachineTarget(params: Readonly<{
  token: string;
  requestedMachineId?: string;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
}>): Promise<CurrentAccountMachineTargetResolution> {
  params.signal?.throwIfAborted();
  const requestedMachineId = nonEmptyString(params.requestedMachineId);
  if (params.requestedMachineId !== undefined) {
    return requestedMachineId
      ? {
        kind: 'selected',
        target: { machineId: requestedMachineId, machineLabel: requestedMachineId },
      }
      : unavailable('machine_not_current', 'The selected machine is no longer active.');
  }

  try {
    const inventory = await listCurrentAccountMachines(params);
    const candidates = inventory
      // A restricted Runner is a Session-scoped target chosen explicitly, never
      // an automatic current-daemon selection.
      .filter((row) => (
        row.kind === 'persistent'
        && row.active && row.revokedAt === null && row.replacedByMachineId === null
        && (!row.access || row.access.accessState === 'ready')
      ))
      .map((row) => ({ machineId: row.id, machineLabel: row.label }));
    if (candidates.length === 0) return unavailable('no_current_machine', 'No current machine is available.');
    if (candidates.length > 1) return { kind: 'selection_required', candidates };
    return { kind: 'selected', target: candidates[0]! };
  } catch {
    params.signal?.throwIfAborted();
    return unavailable('machine_inventory_unavailable', 'The current machine inventory is unavailable.');
  }
}
