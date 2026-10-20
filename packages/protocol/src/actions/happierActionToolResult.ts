import { maybeParseJson } from '../activity/parseJson.js';
import { resolveToolEnvelopeMetaV2 } from '../tools/v2/meta.js';
import { isShellToolNameAlias } from '../tools/v2/aliases.js';

const PREFIXES = ['mcp__happier__', 'happier__', 'happier_'] as const;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFirstPartyShellBridgeCall(value: unknown): Readonly<{ tool: string; json: boolean; rawToolName: string }> | null {
    const parsed = maybeParseJson(value);
    if (!isRecord(parsed)) return null;
    const meta = resolveToolEnvelopeMetaV2(parsed);
    const bridge = parsed.happierToolsShellBridge;
    if (!meta || !isShellToolNameAlias(meta.rawToolName)
        || !isRecord(bridge) || bridge.kind !== 'call' || bridge.source !== 'happier'
        || typeof bridge.rawCommand !== 'string' || !bridge.rawCommand.trim()
        || typeof bridge.tool !== 'string' || bridge.tool !== meta.canonicalToolName
        || typeof bridge.json !== 'boolean'
        || !(bridge.sessionId === null || typeof bridge.sessionId === 'string')
        || !(bridge.directory === null || typeof bridge.directory === 'string')
        || !(bridge.argsJson === null || typeof bridge.argsJson === 'string')
        || !Object.hasOwn(bridge, 'args')
        || !(bridge.agentBridge === undefined || typeof bridge.agentBridge === 'boolean')) return null;
    return { tool: bridge.tool, json: bridge.json, rawToolName: meta.rawToolName };
}

/** Consume the canonicalizer's typed annotation, never reparse an arbitrary shell command. */
export function readHappierActionToolName(toolName: string, input: unknown): string {
    const bridge = readFirstPartyShellBridgeCall(input);
    return bridge && toolName === bridge.rawToolName ? `happier__${bridge.tool}` : toolName;
}

/** Normalizers preserve operands at the top level; `_raw` is only a truncated preview. */
export function readHappierActionToolPayload(value: unknown): unknown {
    const parsed = maybeParseJson(value);
    if (!isRecord(parsed) || !resolveToolEnvelopeMetaV2(parsed)) return parsed;
    const bridge = readFirstPartyShellBridgeCall(parsed);
    return Object.fromEntries(Object.entries(parsed).filter(([key]) => ![
        '_happier', '_happy', '_raw', '_mcp', '_acp', 'locations',
        ...(bridge ? ['happierToolsShellBridge'] : []),
    ].includes(key)));
}

export function createHappierActionToolNameIndex<T extends string>(bindings: readonly Readonly<{ actionId: T; name?: string }>[]): ReadonlyMap<string, T> {
    return new Map(bindings.flatMap(binding => {
        const name = binding.name?.trim();
        return name ? [[name, binding.actionId] as const] : [];
    }));
}

function firstPartyName(name: string): string | null {
    for (const prefix of PREFIXES) if (name.startsWith(prefix)) return name.slice(prefix.length);
    return null;
}

export function readHappierActionId<T extends string>(toolName: string, index: ReadonlyMap<string, T>): T | null {
    const name = toolName.trim();
    const bare = firstPartyName(name);
    return index.get(name) ?? (bare ? index.get(bare) ?? null : null);
}

export function readHappierActionExecuteActionId<T extends string>(
    toolName: string, input: unknown, isFamilyActionId: (id: string) => id is T,
): T | null {
    if (firstPartyName(readHappierActionToolName(toolName, input).trim()) !== 'action_execute') return null;
    const value = readHappierActionToolPayload(input);
    if (!isRecord(value) || typeof value.actionId !== 'string') return null;
    const id = value.actionId.trim();
    return isFamilyActionId(id) ? id : null;
}

/** Only documented executor and MCP text/structured envelopes are candidates. */
export function readHappierActionToolResultCandidates(result: unknown, input?: unknown): readonly unknown[] {
    const normalized = maybeParseJson(result);
    const parsed = readHappierActionToolPayload(normalized);
    const candidates: unknown[] = [parsed];
    if (isRecord(normalized) && resolveToolEnvelopeMetaV2(normalized) && isRecord(parsed)
        && Object.keys(parsed).length === 1 && Object.hasOwn(parsed, 'value')) {
        candidates.push(maybeParseJson(parsed.value));
    }
    if (isRecord(parsed) && parsed.structuredContent !== undefined) candidates.push(parsed.structuredContent);
    // Claude ACP stores a single-text MCP result as the text itself (`content: "<json>"`).
    if (isRecord(parsed) && typeof parsed.content === 'string') candidates.push(maybeParseJson(parsed.content));
    const blocks = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.content) ? parsed.content : null;
    if (blocks?.length) {
        const texts: string[] = [];
        for (const block of blocks) {
            if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return candidates;
            texts.push(block.text);
        }
        candidates.push(maybeParseJson(texts.join('')));
    }
    const bridge = readFirstPartyShellBridgeCall(input);
    if (bridge?.json) {
        if (isRecord(parsed) && typeof parsed.stdout === 'string') candidates.push(maybeParseJson(parsed.stdout));
        for (const candidate of [...candidates]) {
            if (!isRecord(candidate) || candidate.v !== 1 || candidate.ok !== true || candidate.kind !== 'tools_call'
                || !isRecord(candidate.data)) continue;
            const data = candidate.data;
            if (data.source === 'happier' && data.tool === bridge.tool && data.isError === false
                && Object.hasOwn(data, 'output')) candidates.push(data.output);
        }
    }
    return candidates;
}

export type HappierActionToolFailure = Readonly<{
    /** The typed failure code: the Action's `errorCode`, or a spawn error's launch code. */
    code: string;
    /** The typed cause or reason the failure's `details` name, when it names one. */
    cause: string | null;
}>;

function readFailureCause(details: unknown): string | null {
    if (!isRecord(details)) return null;
    for (const key of ['cause', 'reason'] as const) {
        const value = details[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

/**
 * The typed Action failure a first-party Happier tool call returned: the executor's
 * `{ errorCode, error, details? }` outcome, or a Session spawn's `{ type: 'error', code }`.
 * Other MCP servers' results are never read, whatever keys they carry.
 */
export function readHappierActionToolFailure(toolName: string, input: unknown, result: unknown): HappierActionToolFailure | null {
    // Persisted tool calls are read at a boundary: a record without a name is not a first-party call.
    if (typeof toolName !== 'string' || firstPartyName(readHappierActionToolName(toolName, input).trim()) === null) return null;
    for (const candidate of readHappierActionToolResultCandidates(result, input)) {
        if (!isRecord(candidate) || candidate.ok === true) continue;
        if (typeof candidate.errorCode === 'string' && candidate.errorCode.trim() && typeof candidate.error === 'string') {
            return { code: candidate.errorCode.trim(), cause: readFailureCause(candidate.details) };
        }
        if (candidate.type === 'error' && typeof candidate.code === 'string' && candidate.code.trim()) {
            const launch = isRecord(candidate.launchError) && typeof candidate.launchError.code === 'string' && candidate.launchError.code.trim()
                ? candidate.launchError.code.trim() : null;
            return { code: launch ?? candidate.code.trim(), cause: null };
        }
    }
    return null;
}
