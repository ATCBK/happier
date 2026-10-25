import { Buffer } from 'node:buffer';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import type { MachineProvisionerAcquireResultV1, MachineProvisionerBootstrapCarrierV1, MachineProvisionerCheckResultV1, MachineProvisionerDestroyResultV1, MachineProvisionerNativeCauseV1, MachineProvisionerNativeExecResultV1, MachineProvisionerObservationV1, MachineProvisionerPowerResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { BILLING, CONTRIBUTION, reference, ROLE_SCHEMAS, VercelLaunchSchema, VercelOperationSchema, VercelResourceSchema, VercelScopeSchema, type VercelScope, type VercelResource, type VercelLaunch, type VercelOperation } from './schemas.js';

// Official Vercel OpenAPI, fetched 2026-10-25. v4 creation; v2 named,
// session, snapshot, command and team APIs. No SDK or command-line dependency.
export const VERCEL_API = 'https://api.vercel.com';
const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const number = defineProtocolNumber();

const sessionSchema = defineProtocolObject({
  id: text, sourceSandboxName: text, projectId: text, createdAt: number,
}, open);
const namedSchema = defineProtocolObject({
  name: text, createdAt: number, currentSessionId: text, currentSnapshotId: text.optional(),
  persistent: defineProtocolLiteral(true), status: defineProtocolUnion([defineProtocolLiteral('running'), defineProtocolLiteral('stopped'), defineProtocolLiteral('stopping')]),
  tags: defineProtocolObject({ 'happier-managed-id': text }, open),
  expiresAt: number.optional(),
}, open);
const namedResponse = defineProtocolObject({ sandbox: namedSchema, session: sessionSchema }, open);
const sessionResponse = defineProtocolObject({ session: sessionSchema }, open);
const projectResponse = defineProtocolObject({ id: text }, open);
const stdinResponse = defineProtocolObject({ bytesWritten: number }, open);
const snapshotSchema = defineProtocolObject({
  id: text, sourceSessionId: text, status: defineProtocolUnion([defineProtocolLiteral('created'), defineProtocolLiteral('deleted'), defineProtocolLiteral('failed')]),
  createdAt: number, expiresAt: number.optional(),
}, open);
const snapshotResponse = defineProtocolObject({ snapshot: snapshotSchema }, open);
const pageSchema = defineProtocolObject({
  snapshots: defineProtocolArray(snapshotSchema),
  pagination: defineProtocolObject({ next: defineProtocolUnion([text, defineProtocolLiteral(null)]) }, open),
}, open);
const commandSchema = defineProtocolObject({
  id: text, sessionId: text, exitCode: defineProtocolUnion([defineProtocolNumber({ integer: true }), defineProtocolLiteral(null)]),
}, open);
const commandResponse = defineProtocolObject({ command: commandSchema }, open);
const teamSchema = defineProtocolObject({
  id: text, billing: defineProtocolObject({ plan: defineProtocolUnion([defineProtocolLiteral('hobby'), defineProtocolLiteral('pro'), defineProtocolLiteral('enterprise')]) }, open),
}, open);
const logSchema = defineProtocolObject({ stream: defineProtocolUnion([defineProtocolLiteral('stdout'), defineProtocolLiteral('stderr')]), data: defineProtocolString() }, open);
type Native = ProtocolSchemaOutput<typeof namedResponse>;
type Failure = Readonly<{ kind: 'unavailable' | 'unknown' | 'refused'; code: string; nativeCause?: MachineProvisionerNativeCauseV1 }>;
type Http = Readonly<{ kind: 'ok'; value: unknown }> | Readonly<{ kind: 'absent'; nativeCause?: MachineProvisionerNativeCauseV1 }> | Failure;
type ReadNative = Readonly<{ kind: 'present'; value: Native }> | Exclude<Http, { kind: 'ok' }>;
type Acquisition = MachineProvisionerAcquireResultV1<VercelResource, VercelOperation>;
type Destruction = MachineProvisionerDestroyResultV1<VercelOperation>;
const invalid = (): Failure => ({ kind: 'unavailable', code: 'vercel_invalid_response' });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const pending = (operation: VercelOperation, nativeCause?: MachineProvisionerNativeCauseV1): Acquisition => ({
  kind: 'pending', nativeOperationRef: reference(operation), ...(nativeCause ? { nativeCause } : {}),
});
const accepted = (operation: VercelOperation): Destruction => ({ kind: 'accepted', nativeOperationRef: reference(operation) });
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function errorCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'credential_unavailable'
    ? 'credential_unavailable' : 'vercel_transport_unavailable';
}

export function createVercelNativeClient(inputScope: VercelScope, request: typeof fetch, signal?: AbortSignal, observedAt = Date.now()) {
  const scope = VercelScopeSchema.parse(inputScope);
  const sameScope = (value: VercelScope) => value.teamId === scope.teamId && value.projectId === scope.projectId;
  const namedPath = (name: string) => '/v2/sandboxes/' + encodeURIComponent(name);
  const sessionPath = (id: string) => '/v2/sandboxes/sessions/' + encodeURIComponent(id);
  const snapshotPath = (id: string) => '/v2/sandboxes/snapshots/' + encodeURIComponent(id);
  const namedParams = { projectId: scope.projectId, resume: 'false' };
  async function http(path: string, method = 'GET', body?: unknown, parameters: Readonly<Record<string, string>> = {}, effect = method !== 'GET', ndjson = false): Promise<Http> {
    if (signal?.aborted) return { kind: effect ? 'unknown' : 'unavailable', code: 'vercel_operation_cancelled' };
    const url = VERCEL_API + path + '?' + new URLSearchParams({ teamId: scope.teamId, ...parameters });
    let response: Response;
    try {
      response = await request(url, { method, redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) { return { kind: effect ? 'unknown' : 'unavailable', code: errorCode(error) }; }
    if (!response.ok) {
      // The observed status class is a native fact. Vendor bodies/codes are not
      // admitted diagnostic content, and are never copied into public results.
      const nativeCause: MachineProvisionerNativeCauseV1 = { httpStatusClass: response.status >= 400 && response.status < 500
        ? '4xx' : response.status >= 500 && response.status < 600 ? '5xx' : response.status >= 300 && response.status < 400 ? '3xx' : 'other' };
      if (response.status === 404) return { kind: 'absent', nativeCause };
      if (response.status === 401 || response.status === 403) return { kind: 'unavailable', code: 'credential_unavailable', nativeCause };
      return { kind: effect ? response.status < 500 ? 'refused' : 'unknown' : 'unavailable',
        code: 'vercel_http_' + response.status, nativeCause };
    }
    try {
      const raw = await response.text();
      if (ndjson) {
        const lines = raw.split('\n').filter(line => line.trim());
        return { kind: 'ok', value: lines.map(line => JSON.parse(line) as unknown) };
      }
      return { kind: 'ok', value: raw ? JSON.parse(raw) as unknown : null };
    } catch { return { kind: effect ? 'unknown' : 'unavailable', code: 'vercel_invalid_response' }; }
  }
  function decodeNative(result: Http, identity: Pick<VercelResource, 'name' | 'managedId'> & Partial<Pick<VercelResource, 'createdAt'>>): ReadNative {
    if (result.kind !== 'ok') return result;
    const decoded = namedResponse.safeParse(result.value);
    if (!decoded.success) return invalid();
    const value = decoded.data;
    if (value.sandbox.name !== identity.name || value.sandbox.tags['happier-managed-id'] !== identity.managedId
      || identity.createdAt !== undefined && value.sandbox.createdAt !== identity.createdAt
      || value.session.id !== value.sandbox.currentSessionId
      || value.session.sourceSandboxName !== identity.name || value.session.projectId !== scope.projectId) {
      return { kind: 'refused', code: 'vercel_identity_mismatch' };
    }
    return { kind: 'present', value };
  }
  async function read(resource: VercelResource): Promise<ReadNative> {
    if (!sameScope(resource)) return { kind: 'refused', code: 'vercel_scope_mismatch' };
    return decodeNative(await http(namedPath(resource.name), 'GET', undefined, namedParams), resource);
  }
  async function readSnapshot(id: string) {
    const response = await http(snapshotPath(id));
    if (response.kind !== 'ok') return response;
    const decoded = snapshotResponse.safeParse(response.value);
    return decoded.success && decoded.data.snapshot.id === id
      ? { kind: 'present' as const, value: decoded.data.snapshot } : invalid();
  }
  async function storage(native: Native): Promise<'retained' | 'lost' | 'unknown'> {
    if (native.sandbox.status === 'running') return 'retained';
    if (native.sandbox.status === 'stopping') return 'unknown';
    const id = native.sandbox.currentSnapshotId;
    if (!id) return 'lost';
    const snapshot = await readSnapshot(id);
    if (snapshot.kind === 'absent') return 'lost';
    if (snapshot.kind !== 'present') return 'unknown';
    return snapshot.value.status === 'created' && snapshot.value.sourceSessionId === native.session.id
      && (snapshot.value.expiresAt === undefined || snapshot.value.expiresAt > observedAt) ? 'retained' : 'lost';
  }
  async function check(): Promise<MachineProvisionerCheckResultV1> {
    const result = await http('/v9/projects/' + encodeURIComponent(scope.projectId));
    if (result.kind !== 'ok') return { available: false, code: result.kind === 'absent' ? 'vercel_project_unavailable' : result.code,
      ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
    const project = projectResponse.safeParse(result.value);
    return project.success && project.data.id === scope.projectId
      ? { available: true } : { available: false, code: 'vercel_project_unavailable' };
  }
  async function limits() {
    const result = await http('/v2/teams/' + encodeURIComponent(scope.teamId));
    if (result.kind !== 'ok') return { kind: 'unavailable' as const,
      code: result.kind === 'absent' ? 'vercel_team_unavailable' : result.code,
      ...(result.nativeCause ? { nativeCause: result.nativeCause } : {}) };
    const decoded = teamSchema.safeParse(result.value);
    if (!decoded.success || decoded.data.id !== scope.teamId) return { kind: 'unavailable' as const, code: 'vercel_plan_unavailable' };
    const plan = decoded.data.billing.plan;
    return { kind: 'available' as const, plan, vcpus: plan === 'hobby' ? 4 : plan === 'pro' ? 8 : 32,
      timeoutMs: plan === 'hobby' ? 2_700_000 : 86_400_000 };
  }
  async function acquire(inputLaunch: VercelLaunch, managedId: string): Promise<Acquisition> {
    signal?.throwIfAborted();
    const launch = VercelLaunchSchema.safeParse(inputLaunch);
    const operation = VercelOperationSchema.safeParse({ kind: 'acquire', name: 'happier-' + managedId, managedId, ...scope });
    if (!launch.success || !operation.success || operation.data.kind !== 'acquire') return { kind: 'rejected', code: 'invalid_request' };
    const cap = await limits();
    signal?.throwIfAborted();
    if (cap.kind !== 'available') return { kind: 'rejected',
      code: cap.code === 'credential_unavailable' ? 'credential_unavailable' : 'provider_unavailable',
      ...(cap.nativeCause ? { nativeCause: cap.nativeCause } : {}) };
    if (launch.data.vcpus > cap.vcpus || launch.data.timeoutMs > cap.timeoutMs) return { kind: 'rejected', code: 'invalid_request' };
    const before = await http(namedPath(operation.data.name), 'GET', undefined, namedParams);
    // An existing name, even one carrying our tag, is never acquisition authority.
    if (before.kind !== 'absent') return pending(operation.data);
    signal?.throwIfAborted();
    const created = await http('/v4/sandboxes', 'POST', { projectId: scope.projectId, name: operation.data.name,
      image: launch.data.image, region: launch.data.region, architecture: 'amd64', persistent: true,
      resources: { vcpus: launch.data.vcpus, memory: launch.data.vcpus * 2048 }, timeout: launch.data.timeoutMs,
      snapshotExpiration: launch.data.snapshotExpirationMs,
      keepLastSnapshots: { count: 1, deleteEvicted: true, expiration: launch.data.snapshotExpirationMs },
      networkPolicy: { mode: 'allow-all' }, ports: [], tags: { 'happier-managed-id': managedId } });
    if (created.kind === 'unavailable' && created.code === 'credential_unavailable') return { kind: 'rejected', code: 'credential_unavailable',
      ...(created.nativeCause ? { nativeCause: created.nativeCause } : {}) };
    if (created.kind === 'absent') return { kind: 'rejected', code: 'provider_unavailable',
      ...(created.nativeCause ? { nativeCause: created.nativeCause } : {}) };
    if (created.kind === 'refused' && created.code !== 'vercel_http_409') return { kind: 'rejected',
      code: created.code === 'vercel_http_400' || created.code === 'vercel_http_422' ? 'invalid_request' : 'provider_unavailable',
      ...(created.nativeCause ? { nativeCause: created.nativeCause } : {}) };
    const decoded = decodeNative(created, operation.data);
    if (decoded.kind !== 'present') return pending(operation.data, created.kind === 'ok' ? undefined : created.nativeCause);
    // Capture paid identity even after cancellation; no bootstrap effect follows here.
    return { kind: 'bound', resource: reference({ ...scope, name: operation.data.name, managedId, createdAt: decoded.value.sandbox.createdAt }) };
  }
  async function recover(input: VercelOperation): Promise<Acquisition> {
    const operation = VercelOperationSchema.parse(input);
    if (operation.kind !== 'acquire' || !sameScope(operation)) return pending(operation);
    const result = decodeNative(await http(namedPath(operation.name), 'GET', undefined, namedParams), operation);
    return result.kind === 'present' ? { kind: 'bound', resource: reference({ ...scope, name: operation.name,
      managedId: operation.managedId, createdAt: result.value.sandbox.createdAt }) } : pending(operation);
  }
  async function inspect(input: VercelResource): Promise<MachineProvisionerObservationV1> {
    const resource = VercelResourceSchema.parse(input);
    const result = await read(resource);
    if (result.kind === 'absent') {
      // Managed absence covers billed attachments too. Never let an absent VM
      // make the shared owner discard unknown or surviving snapshot custody.
      const owned = await snapshots(resource);
      return owned !== null && owned.length === 0
        ? { observedAt, availability: 'absent', storage: 'lost', billing: BILLING }
        : { observedAt, availability: 'unavailable', reason: 'vercel_snapshot_cleanup_unqualified' };
    }
    if (result.kind !== 'present') return { observedAt, availability: 'unavailable', reason: result.code };
    return { observedAt, availability: 'present',
      power: result.value.sandbox.status === 'stopping' ? 'unknown' : result.value.sandbox.status,
      storage: await storage(result.value), billing: BILLING, daemon: 'unknown',
      ...(result.value.sandbox.expiresAt === undefined ? {} : { nativeExpiry: result.value.sandbox.expiresAt }) };
  }
  async function running(resource: VercelResource): Promise<Native> {
    const result = await read(resource);
    if (result.kind !== 'present') fail(result.kind === 'absent' ? 'vercel_resource_absent' : result.code);
    if (result.value.sandbox.status !== 'running') fail('vercel_resource_stopped');
    return result.value;
  }
  async function execute(native: Native, argv: readonly string[], input?: Uint8Array, timeoutMs?: number | null) {
    if (!argv.length) fail('invalid_request');
    const started = await http(sessionPath(native.session.id) + '/cmd', 'POST', { command: argv[0], args: argv.slice(1),
      wait: false, attachStdin: input !== undefined, ...(timeoutMs == null ? {} : { timeout: timeoutMs }) });
    if (started.kind !== 'ok') fail(started.kind === 'absent' ? 'vercel_command_absent' : started.code);
    const initial = commandResponse.safeParse(started.value);
    if (!initial.success || initial.data.command.sessionId !== native.session.id) fail('vercel_invalid_response');
    const command = initial.data.command;
    const path = sessionPath(native.session.id) + '/cmd/' + encodeURIComponent(command.id);
    if (input !== undefined) {
      // REST's stdin body budget is 1 MB. Derive each raw fragment from its
      // actual JSON overhead, so the host's larger file fragments stay valid.
      let offset = 0;
      do {
        const overhead = Buffer.byteLength(JSON.stringify({ data: '', offset, close: true }));
        const bytesPerRequest = Math.floor((1_000_000 - overhead) / 4) * 3;
        const end = Math.min(input.length, offset + bytesPerRequest);
        const result = await http(path + '/stdin', 'POST', { data: Buffer.from(input.subarray(offset, end)).toString('base64'),
          offset, close: end === input.length });
        if (result.kind !== 'ok') fail(result.kind === 'absent' ? 'vercel_command_absent' : result.code);
        const written = stdinResponse.safeParse(result.value);
        if (!written.success || written.data.bytesWritten !== end) fail('vercel_stdin_unconfirmed');
        offset = end;
      } while (offset < input.length);
    }
    const finished = await http(path, 'GET', undefined, { wait: 'true' });
    if (finished.kind !== 'ok') fail(finished.kind === 'absent' ? 'vercel_command_absent' : finished.code);
    const result = commandResponse.safeParse(finished.value);
    if (!result.success || result.data.command.id !== command.id || result.data.command.sessionId !== native.session.id
      || result.data.command.exitCode === null) fail('vercel_command_unconfirmed');
    const logs = await http(path + '/logs', 'GET', undefined, {}, false, true);
    if (logs.kind !== 'ok' || !Array.isArray(logs.value)) fail(logs.kind === 'ok' || logs.kind === 'absent' ? 'vercel_logs_unavailable' : logs.code);
    let stdout = '', stderr = '';
    for (const line of logs.value) {
      const parsed = logSchema.safeParse(line);
      if (!parsed.success) fail('vercel_logs_unavailable');
      if (parsed.data.stream === 'stdout') stdout += parsed.data.data; else stderr += parsed.data.data;
    }
    return { exitCode: result.data.command.exitCode, stdout, stderr };
  }
  async function put(native: Native, path: string, bytes: Uint8Array, mode = 0o600) {
    if (!path.startsWith('/') || path.includes('\0') || !Number.isInteger(mode) || mode < 0 || mode > 0o777) fail('invalid_request');
    const command = 'umask 077; cat > ' + quote(path) + ' && chmod ' + mode.toString(8) + ' ' + quote(path);
    const result = await execute(native, ['sh', '-c', command], bytes);
    if (result.exitCode !== 0) fail('vercel_file_unconfirmed');
  }
  async function bootstrap(resource: VercelResource): Promise<MachineProvisionerBootstrapCarrierV1> {
    const native = await running(resource);
    const probe = await execute(native, ['sh', '-c', 'uname -s; uname -m; printf "%s\\n" "$HOME"']);
    const parts = (probe.stdout.endsWith('\n') ? probe.stdout.slice(0, -1) : probe.stdout).split(/\r?\n/);
    if (probe.exitCode !== 0 || parts.length !== 3 || parts[0] !== 'Linux' || parts[1] !== 'x86_64' || !parts[2]!.startsWith('/')) fail('vercel_guest_unsupported');
    return { kind: 'native', transport: { contributionRef: CONTRIBUTION, schemaVersion: 1 },
      guestHome: { homeDir: parts[2]!, happyHomeDir: parts[2]! + '/.happier', daemonStartup: 'native-process' } };
  }
  async function exec(input: ReturnType<typeof ROLE_SCHEMAS.execInput.parse>): Promise<MachineProvisionerNativeExecResultV1> {
    const parsed = ROLE_SCHEMAS.execInput.parse(input);
    const native = await running(parsed.resource);
    if (parsed.processConfig) {
      const { environment, detachedDaemonStartArgv } = parsed.processConfig;
      const home = environment.HAPPIER_HOME_DIR;
      if (!home?.startsWith('/') || !detachedDaemonStartArgv?.length || Object.keys(environment).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) fail('invalid_request');
      // The existing enrollment owner supplies the installed payload command.
      // Persist its native boot recipe on the same retained filesystem, never
      // reconstruct an installer, credential, enrollment or Session lifecycle.
      const script = '#!/bin/sh\n' + Object.entries(environment).map(([key, value]) => 'export ' + key + '=' + quote(value)).join('\n')
        + '\nexec ' + detachedDaemonStartArgv.map(quote).join(' ') + '\n';
      await put(native, home + '/vercel-daemon-start.new', Buffer.from(script), 0o700);
      const publish = await execute(native, ['sh', '-c', 'mv ' + quote(home + '/vercel-daemon-start.new') + ' ' + quote(home + '/vercel-daemon-start')]);
      if (publish.exitCode !== 0) fail('vercel_boot_unconfirmed');
      const start = await execute(native, detachedDaemonStartArgv, undefined, parsed.timeoutMs);
      if (start.exitCode !== 0) fail('vercel_boot_unconfirmed');
      return { kind: 'process-configured' };
    }
    const result = await execute(native, parsed.argv,
      parsed.inputBase64 === undefined ? undefined : Buffer.from(parsed.inputBase64, 'base64'), parsed.timeoutMs);
    return { termination: { observed: { kind: 'exit', exitCode: result.exitCode }, requestedBy: { kind: 'none' } },
      stdoutBase64: Buffer.from(result.stdout).toString('base64'), stderrBase64: Buffer.from(result.stderr).toString('base64'),
      stdoutTruncated: false, stderrTruncated: false };
  }
  async function putFile(input: ReturnType<typeof ROLE_SCHEMAS.putFileInput.parse>): Promise<MachineProvisionerPowerResultV1> {
    const parsed = ROLE_SCHEMAS.putFileInput.parse(input);
    try { await put(await running(parsed.resource), parsed.guestPath, Buffer.from(parsed.bytesBase64, 'base64'), parsed.mode); return { kind: 'confirmed' }; }
    catch (error) { return { kind: 'unknown', code: error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'vercel_file_unconfirmed' }; }
  }
  async function power(resource: VercelResource, intent: string): Promise<MachineProvisionerPowerResultV1> {
    if (!['start', 'stop', 'resume'].includes(intent)) return { kind: 'refused', code: 'vercel_intent_unsupported' };
    const native = await read(VercelResourceSchema.parse(resource));
    if (native.kind !== 'present') return { kind: native.kind === 'refused' || native.kind === 'absent' ? 'refused' : 'unknown',
      code: native.kind === 'absent' ? 'vercel_resource_absent' : native.code };
    if (intent === 'stop') {
      if (native.value.sandbox.status === 'running') {
        const stopped = await http(sessionPath(native.value.session.id) + '/stop', 'POST');
        if (stopped.kind !== 'ok') return { kind: 'unknown', code: stopped.kind === 'absent' ? 'vercel_stop_unconfirmed' : stopped.code };
      }
      const current = await inspect(resource);
      return current.power === 'stopped' && current.storage === 'retained'
        ? { kind: 'confirmed' } : { kind: 'unknown', code: 'vercel_stop_unconfirmed' };
    }
    if (native.value.sandbox.status === 'stopping') return { kind: 'unknown', code: 'vercel_stopping' };
    if (native.value.sandbox.status === 'stopped' && await storage(native.value) !== 'retained') return { kind: 'refused', code: 'vercel_snapshot_unavailable' };
    const resumed = native.value.sandbox.status === 'running' ? native : decodeNative(
      await http(namedPath(resource.name), 'GET', undefined, { projectId: scope.projectId, resume: 'true' }, true), resource);
    if (resumed.kind !== 'present' || resumed.value.sandbox.status !== 'running') return { kind: 'unknown', code: 'vercel_resume_unconfirmed' };
    try {
      const started = await execute(resumed.value, ['sh', '-c', 'exec "$HOME/.happier/vercel-daemon-start"']);
      return started.exitCode === 0 ? { kind: 'confirmed' } : { kind: 'unknown', code: 'vercel_boot_unconfirmed' };
    } catch { return { kind: 'unknown', code: 'vercel_boot_unconfirmed' }; }
  }
  async function snapshots(resource: VercelResource): Promise<readonly string[] | null> {
    const ids: string[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = await http('/v2/sandboxes/snapshots', 'GET', undefined, { project: scope.projectId, name: resource.name, ...(cursor ? { cursor } : {}) });
      if (page.kind !== 'ok') return null;
      const parsed = pageSchema.safeParse(page.value);
      if (!parsed.success) return null;
      for (const snapshot of parsed.data.snapshots) {
        if (snapshot.status === 'deleted') continue;
        const source = await http(sessionPath(snapshot.sourceSessionId));
        if (source.kind !== 'ok') return null;
        const decoded = sessionResponse.safeParse(source.value);
        if (!decoded.success || decoded.data.session.id !== snapshot.sourceSessionId || decoded.data.session.projectId !== resource.projectId || decoded.data.session.sourceSandboxName !== resource.name
          || decoded.data.session.createdAt < resource.createdAt || snapshot.createdAt < resource.createdAt) return null;
        ids.push(snapshot.id);
      }
      cursor = parsed.data.pagination.next;
      if (cursor && seen.has(cursor)) return null;
      if (cursor) seen.add(cursor);
    } while (cursor);
    return [...new Set(ids)];
  }
  async function cleanup(input: VercelOperation): Promise<{ kind: 'confirmed' | 'retryable' } | { kind: 'unknown'; code?: string }> {
    const operation = VercelOperationSchema.parse(input);
    if (operation.kind !== 'delete' || operation.phase !== 'delete' || !sameScope(operation.resource)) return { kind: 'unknown', code: 'vercel_cleanup_unqualified' };
    const native = await read(operation.resource);
    if (native.kind === 'present') return { kind: 'retryable' };
    if (native.kind !== 'absent') return { kind: 'unknown', code: native.code };
    let survives = false;
    for (const id of operation.snapshotIds) {
      const snapshot = await readSnapshot(id);
      if (snapshot.kind === 'present' && snapshot.value.status !== 'deleted') survives = true;
      else if (snapshot.kind !== 'absent' && snapshot.kind !== 'present') return { kind: 'unknown', code: snapshot.code };
    }
    return { kind: survives ? 'retryable' : 'confirmed' };
  }
  async function destroy(input: { resource: VercelResource } | { nativeOperation: VercelOperation }): Promise<Destruction> {
    let operation: VercelOperation = 'resource' in input ? { kind: 'delete', resource: VercelResourceSchema.parse(input.resource), phase: 'stop', snapshotIds: [] }
      : VercelOperationSchema.parse(input.nativeOperation);
    if (operation.kind === 'acquire') {
      const recovered = await recover(operation);
      if (recovered.kind !== 'bound') return { kind: 'unknown', code: 'vercel_cleanup_unqualified' };
      operation = { kind: 'delete', resource: recovered.resource.value, phase: 'stop', snapshotIds: [] };
    }
    if (!sameScope(operation.resource)) return { kind: 'refused', code: 'vercel_scope_mismatch' };
    let native = await read(operation.resource);
    if (native.kind !== 'present' && native.kind !== 'absent') return native.kind === 'refused'
      ? { kind: 'refused', code: native.code } : accepted(operation);
    if (operation.phase === 'stop') {
      if (native.kind === 'absent') {
        const ids = await snapshots(operation.resource);
        if (ids === null) return { kind: 'unknown', code: 'vercel_cleanup_unqualified' };
        return ids.length === 0 ? { kind: 'confirmed' }
          : accepted({ ...operation, phase: 'delete', snapshotIds: ids });
      }
      if (native.value.sandbox.status === 'running') {
        const stopped = await http(sessionPath(native.value.session.id) + '/stop', 'POST');
        if (stopped.kind !== 'ok') return accepted(operation);
        native = await read(operation.resource);
      }
      if (native.kind !== 'present' || native.value.sandbox.status !== 'stopped') return accepted(operation);
      const ids = await snapshots(operation.resource);
      if (ids === null) return accepted(operation);
      operation = { ...operation, phase: 'delete', snapshotIds: ids };
      // Publish the exact attachment closure to the existing row owner before
      // destroying native metadata. A lost later reply still has these IDs.
      return accepted(operation);
    }
    if (native.kind === 'present') {
      const deleted = await http(namedPath(operation.resource.name), 'DELETE', undefined, { projectId: scope.projectId, deleteOrphanSnapshots: 'true' });
      if (deleted.kind !== 'ok' && deleted.kind !== 'absent') return accepted(operation);
      native = await read(operation.resource);
      if (native.kind !== 'absent') return accepted(operation);
    }
    // Vercel owns orphan/reference qualification. Unconditional snapshot DELETE
    // would destroy a deliberately shared restore source. Native orphan cleanup
    // is asynchronous; exact survivors remain retained and visibly incomplete.
    return (await cleanup(operation)).kind === 'confirmed' ? { kind: 'confirmed' } : accepted(operation);
  }
  return { check, limits, acquire, recover, inspect, bootstrap, exec, putFile, power, destroy, cleanup };
}
