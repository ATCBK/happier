import * as mini from 'zod/mini';
import {
  BoatAcquireOperationV1Schema,
  BoatDeleteOperationV1Schema,
  BoatLaunchV1Schema,
  BoatNativeError,
  BoatPublicKeySchema,
  BoatResourceV1Schema,
  parseBoatValue,
  type BoatAcquireOperationV1,
  type BoatDeleteOperationV1,
  type BoatLaunchV1,
  type BoatResourceV1,
} from './schemas.js';

const API_ORIGIN = 'https://boat.dev/api/v1';
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const text = () => mini.string().check(mini.trim(), mini.minLength(1));
const sandboxId = mini.string().check(mini.regex(/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/));
const base = { ok: mini.literal(true), type: text() } as const;
const sandbox = mini.object({ id: sandboxId, name: mini.optional(text()), state: text() });
const limitsResponse = mini.object({ ...base, sandboxPlanDollars: mini.optional(mini.number().check(mini.nonnegative())) });
const snapshotsResponse = mini.object({ ...base, snapshots: mini.array(mini.object({
  name: mini.string().check(mini.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  status: mini.enum(['saving', 'ready', 'failed']), sourceSandboxId: sandboxId, createdAt: text(),
})) });
const sandboxesResponse = mini.object({ ...base, sandboxes: mini.array(sandbox) });
const sandboxResponse = mini.object({ ...base, sandbox });
const createResponse = mini.object({ ...base, sandbox });
const sshResponse = mini.object({ ...base, success: mini.literal(true), machineIp: mini.nullable(text()),
  sshEndpoint: mini.optional(mini.nullable(text())), sshUser: mini.literal('user'), hostKey: text() });
const deletionOperation = mini.object({
  id: mini.string().check(mini.regex(/^bdop_[a-f0-9]{32}$/)), kind: mini.literal('sandbox'), targetId: sandboxId,
  status: mini.enum(['pending', 'processing', 'blocked', 'completed']),
});
const deletionResponse = mini.object({ ...base, operation: deletionOperation });
const errorResponse = mini.object({ ok: mini.literal(false), code: text() });

export type BoatSize = Readonly<{ id: BoatLaunchV1['size']; multiplier: number; cpuCores: number; memoryGb: number; diskGb: number; hourlyUsd: string }>;
export type BoatOptions = Readonly<{
  sizes: readonly BoatSize[];
  snapshots: readonly Readonly<{ name: string; status: 'ready' }>[];
  sandboxes: readonly Readonly<{ id: string; name?: string; state: string }>[];
}>;
export type BoatAcquireResult =
  | Readonly<{ kind: 'bound'; resource: BoatResourceV1 }>
  | Readonly<{ kind: 'pending'; operation: BoatAcquireOperationV1 }>
  | Readonly<{ kind: 'unknown'; code: string }>
  | Readonly<{ kind: 'refused'; code: string }>;
export type BoatNativeClientOptions = Readonly<{ fetch?: typeof globalThis.fetch; signal?: AbortSignal; now?: () => number }>;

const BASE_SIZES: readonly BoatSize[] = [
  { id: 'small', multiplier: 0.5, cpuCores: 2, memoryGb: 4, diskGb: 12, hourlyUsd: '0.018' },
  { id: 'default', multiplier: 1, cpuCores: 4, memoryGb: 8, diskGb: 50, hourlyUsd: '0.036' },
  { id: 'large', multiplier: 2, cpuCores: 8, memoryGb: 16, diskGb: 125, hourlyUsd: '0.072' },
];
const XLARGE: BoatSize = { id: 'xlarge', multiplier: 5.56, cpuCores: 16, memoryGb: 32, diskGb: 251, hourlyUsd: '0.200' };

function encodeRequest(path: string, body: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ path, body });
}

function decodeRequest(value: string): { path: string; body: Readonly<Record<string, unknown>> } {
  try {
    const parsed = mini.strictObject({ path: text(), body: mini.record(mini.string(), mini.unknown()) }).parse(JSON.parse(value));
    return parsed;
  } catch {
    throw new BoatNativeError('native_idempotency_invariant');
  }
}

function endpoint(launch: BoatLaunchV1): { path: string; body: Readonly<Record<string, unknown>> } {
  const common = { type: launch.size, snapshots: true, noEnv: true, ttlSeconds: null } as const;
  if (launch.source.kind === 'blank') return { path: '/sandboxes', body: common };
  if (launch.source.kind === 'named-snapshot') return { path: '/sandboxes', body: { ...common, from: launch.source.name } };
  return { path: `/sandboxes/${encodeURIComponent(launch.source.sandboxId)}/fork`, body: common };
}

export function createBoatNativeClient(options: BoatNativeClientOptions = {}) {
  const transport = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await transport(`${API_ORIGIN}${path}`, { ...init, redirect: 'error', signal: options.signal });
    } catch {
      throw new BoatNativeError('native_transport_unavailable', true);
    }
    let value: unknown;
    try { value = await response.json(); } catch { throw new BoatNativeError('native_response_invalid'); }
    if (!response.ok) {
      const error = parseBoatValue(errorResponse, value);
      if (response.status === 401 || error.code === 'unauthorized') throw new BoatNativeError('native_authorization_failed');
      if (error.code === 'idempotency_in_progress') throw new BoatNativeError('native_idempotency_in_progress', true);
      if (error.code === 'idempotency_key_reused') throw new BoatNativeError('native_idempotency_mismatch');
      if (['daily_limit_reached', 'limit_reached', 'member_limit_reached', 'machine_class_plan_required', 'trial_machine_class_not_allowed'].includes(error.code)) {
        throw new BoatNativeError(`native_${error.code}`, false);
      }
      if (response.status === 429 || error.code === 'rate_limited') throw new BoatNativeError('native_rate_limited', true);
      if (response.status === 404 && error.code === 'not_found') throw new BoatNativeError('native_not_found');
      throw new BoatNativeError(response.status >= 500 ? 'native_service_unavailable' : `native_${error.code}`, response.status >= 500);
    }
    return value;
  }

  async function submitAcquire(operation: BoatAcquireOperationV1): Promise<BoatAcquireResult> {
    const retained = decodeRequest(operation.requestFingerprint);
    try {
      const value = await request(retained.path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operation.idempotencyKey },
        body: JSON.stringify(retained.body),
      });
      const accepted = parseBoatValue(createResponse, value);
      return { kind: 'pending', operation: { ...operation, sandboxId: accepted.sandbox.id } };
    } catch (error) {
      if (error instanceof BoatNativeError && error.code === 'native_idempotency_mismatch') return { kind: 'refused', code: error.code };
      if (error instanceof BoatNativeError && (error.retryable || error.code === 'native_idempotency_in_progress')) return { kind: 'pending', operation };
      if (error instanceof BoatNativeError && error.code.startsWith('native_') && error.code.includes('limit')) return { kind: 'refused', code: error.code };
      throw error;
    }
  }

  return {
    async check() {
      await request('/limits');
      return { available: true as const };
    },
    async options(): Promise<BoatOptions> {
      const [limitsValue, snapshotsValue, sandboxesValue] = await Promise.all([
        request('/limits'), request('/named-snapshots'), request('/sandboxes'),
      ]);
      const limits = parseBoatValue(limitsResponse, limitsValue);
      const snapshots = parseBoatValue(snapshotsResponse, snapshotsValue).snapshots
        .filter((value): value is typeof value & { status: 'ready' } => value.status === 'ready')
        .map(({ name, status }) => ({ name, status }));
      const sandboxes = parseBoatValue(sandboxesResponse, sandboxesValue).sandboxes
        .filter(value => ['ready', 'idle', 'running', 'archived'].includes(value.state))
        .map(value => ({ id: value.id, ...(value.name ? { name: value.name } : {}), state: value.state }));
      return { sizes: limits.sandboxPlanDollars !== undefined && limits.sandboxPlanDollars >= 100 ? [...BASE_SIZES, XLARGE] : BASE_SIZES, snapshots, sandboxes };
    },
    async acquire(input: Readonly<{ launch: BoatLaunchV1; idempotencyKey: string }>): Promise<BoatAcquireResult> {
      const launch = BoatLaunchV1Schema.parse(input.launch);
      if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 255) return { kind: 'refused', code: 'invalid_request' };
      if (launch.source.kind === 'named-snapshot') {
        const source = launch.source;
        const listed = parseBoatValue(snapshotsResponse, await request('/named-snapshots'));
        if (!listed.snapshots.some(value => value.name === source.name && value.status === 'ready')) {
          return { kind: 'refused', code: 'native_snapshot_not_ready' };
        }
      }
      const selected = endpoint(launch);
      return submitAcquire(BoatAcquireOperationV1Schema.parse({
        kind: 'acquire', idempotencyKey: input.idempotencyKey, requestFingerprint: encodeRequest(selected.path, selected.body),
        sourceKind: launch.source.kind, requestedAtMs: now(),
      }));
    },
    async reconcileAcquire(raw: BoatAcquireOperationV1): Promise<BoatAcquireResult> {
      const operation = BoatAcquireOperationV1Schema.parse(raw);
      if (operation.sandboxId) {
        const observed = await this.inspect({ sandboxId: operation.sandboxId });
        if (observed.kind === 'present' && observed.power === 'running') return { kind: 'bound', resource: { sandboxId: operation.sandboxId } };
        if (observed.kind === 'failed') return { kind: 'refused', code: 'native_acquire_failed' };
        return { kind: 'pending', operation };
      }
      if (now() - operation.requestedAtMs >= IDEMPOTENCY_RETENTION_MS) return { kind: 'unknown', code: 'native_idempotency_expired' };
      return submitAcquire(operation);
    },
    async inspect(raw: BoatResourceV1) {
      const resource = BoatResourceV1Schema.parse(raw);
      try {
        const response = parseBoatValue(sandboxResponse, await request(`/sandboxes/${encodeURIComponent(resource.sandboxId)}`));
        if (response.sandbox.id !== resource.sandboxId) throw new BoatNativeError('native_identity_mismatch');
        const state = response.sandbox.state;
        if (['ready', 'idle', 'running'].includes(state)) return { kind: 'present' as const, power: 'running' as const };
        if (state === 'archived') return { kind: 'present' as const, power: 'stopped' as const };
        if (['provisioning', 'provisioned', 'cloning', 'archiving'].includes(state)) return { kind: 'pending' as const, power: 'unknown' as const };
        if (['error', 'cancelled'].includes(state)) return { kind: 'failed' as const, power: 'unknown' as const };
        return { kind: 'pending' as const, power: 'unknown' as const };
      } catch (error) {
        if (error instanceof BoatNativeError && error.code === 'native_not_found') return { kind: 'absent' as const, power: 'unknown' as const };
        throw error;
      }
    },
    async bootstrap(raw: BoatResourceV1, publicKey: string) {
      const resource = BoatResourceV1Schema.parse(raw);
      const key = parseBoatValue(BoatPublicKeySchema, publicKey, 'native_ssh_key_invalid');
      const response = parseBoatValue(sshResponse, await request(`/sandboxes/${encodeURIComponent(resource.sandboxId)}/sshkey`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
      }));
      if (!response.machineIp || !response.hostKey || response.sshUser !== 'user') throw new BoatNativeError('native_ssh_evidence_invalid');
      let address = response.machineIp;
      let port = 22;
      if (response.sshEndpoint) {
        const separator = response.sshEndpoint.lastIndexOf(':');
        const candidatePort = Number(response.sshEndpoint.slice(separator + 1));
        if (separator <= 0 || !Number.isInteger(candidatePort) || candidatePort < 1 || candidatePort > 65535) throw new BoatNativeError('native_ssh_evidence_invalid');
        address = response.sshEndpoint.slice(0, separator);
        port = candidatePort;
      }
      return { address, port, username: 'user' as const, hostKey: response.hostKey };
    },
    async power(raw: BoatResourceV1, intent: 'stop' | 'resume' | 'start') {
      const resource = BoatResourceV1Schema.parse(raw);
      const nativeIntent = intent === 'start' ? 'resume' : intent;
      await request(`/sandboxes/${encodeURIComponent(resource.sandboxId)}/${nativeIntent}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        ...(nativeIntent === 'resume' ? { body: JSON.stringify({ ttlSeconds: null }) } : {}),
      });
      const observed = await this.inspect(resource);
      return observed.kind === 'present' && observed.power === (nativeIntent === 'stop' ? 'stopped' : 'running')
        ? { kind: 'confirmed' as const } : { kind: 'pending' as const };
    },
    async destroy(input: Readonly<{ resource: BoatResourceV1 }>) {
      const resource = BoatResourceV1Schema.parse(input.resource);
      const response = parseBoatValue(deletionResponse, await request(`/sandboxes/${encodeURIComponent(resource.sandboxId)}`, {
        method: 'DELETE', headers: { 'X-Ascii-Confirm-Delete': resource.sandboxId },
      }));
      if (response.operation.targetId !== resource.sandboxId) throw new BoatNativeError('native_identity_mismatch');
      return { kind: 'pending' as const, operation: BoatDeleteOperationV1Schema.parse({
        kind: 'delete', operationId: response.operation.id, sandboxId: resource.sandboxId,
      }) };
    },
    async reconcileDestroy(raw: BoatDeleteOperationV1) {
      const operation = BoatDeleteOperationV1Schema.parse(raw);
      const response = parseBoatValue(deletionResponse, await request(`/deletion-operations/${encodeURIComponent(operation.operationId)}`));
      if (response.operation.id !== operation.operationId || response.operation.targetId !== operation.sandboxId) throw new BoatNativeError('native_identity_mismatch');
      if (response.operation.status === 'completed') return { kind: 'confirmed' as const };
      if (response.operation.status === 'blocked') return { kind: 'failed' as const, code: 'native_delete_blocked' };
      return { kind: 'pending' as const };
    },
  };
}
