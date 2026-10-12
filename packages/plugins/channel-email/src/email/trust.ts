import { normalizeEmailAddress } from './address.js';

export type EmailTrustStrategy =
    | { kind: 'exchangeOrganization'; authSource: string }
    | { kind: 'authenticationResults'; authservId: string };

type TrustResult = { trusted: boolean; markersMissing: boolean };
type HeaderToken = { kind: 'atom' | 'quoted' | 'separator'; value: string };

function headerValues(headers: ReadonlyMap<string, readonly string[]>, name: string): readonly string[] {
    const result: string[] = [];
    for (const [key, values] of headers) {
        if (key.toLowerCase() === name) result.push(...values);
    }
    return result;
}

function unfoldHeader(value: string): string | null {
    const unfolded = value.replace(/\r\n[\t ]+/g, ' ');
    return /[\x00-\x08\x0a-\x1f\x7f]/.test(unfolded) ? null : unfolded;
}

function tokenizeAuthenticationResults(value: string): HeaderToken[] | null {
    const input = unfoldHeader(value);
    if (input === null) return null;
    const tokens: HeaderToken[] = [];
    let index = 0;
    while (index < input.length) {
        const character = input[index]!;
        if (character === ' ' || character === '\t') { index += 1; continue; }
        if (character === '(') {
            let depth = 1;
            index += 1;
            while (index < input.length && depth > 0) {
                const next = input[index++]!;
                if (next === '\\') {
                    if (index === input.length) return null;
                    index += 1;
                } else if (next === '(') depth += 1;
                else if (next === ')') depth -= 1;
            }
            if (depth !== 0) return null;
            continue;
        }
        if (character === ')') return null;
        if (character === ';' || character === '=') {
            tokens.push({ kind: 'separator', value: character });
            index += 1;
            continue;
        }
        if (character === '"') {
            let quoted = '';
            let closed = false;
            index += 1;
            while (index < input.length) {
                const next = input[index++]!;
                if (next === '"') { closed = true; break; }
                if (next === '\\') {
                    if (index === input.length) return null;
                    quoted += input[index++]!;
                } else quoted += next;
            }
            if (!closed) return null;
            tokens.push({ kind: 'quoted', value: quoted });
            continue;
        }
        const start = index;
        while (index < input.length && !/[\t ()";=]/.test(input[index]!)) index += 1;
        tokens.push({ kind: 'atom', value: input.slice(start, index) });
    }
    return tokens;
}

function authenticationResults(value: string): {
    authservId: string;
    results: { method: string; result: string; properties: ReadonlyMap<string, string> }[];
} | null {
    const tokens = tokenizeAuthenticationResults(value);
    if (!tokens?.[0] || tokens[0].kind === 'separator') return null;
    const authservId = tokens[0].value.toLowerCase();
    const separator = (index: number, value: string) => tokens[index]?.kind === 'separator' && tokens[index]?.value === value;
    let index = 1;
    if (tokens[index]?.kind === 'atom' && tokens[index]?.value === '1') index += 1;
    if (!separator(index, ';')) return null;
    if (tokens[index + 1]?.kind === 'atom' && tokens[index + 1]?.value.toLowerCase() === 'none' && index + 2 === tokens.length) {
        return { authservId, results: [] };
    }
    const results: { method: string; result: string; properties: ReadonlyMap<string, string> }[] = [];
    while (index < tokens.length) {
        if (!separator(index++, ';')) return null;
        const methodToken = tokens[index++];
        if (methodToken?.kind !== 'atom') return null;
        const method = /^([a-z][a-z0-9_-]*)(?:\/1)?$/i.exec(methodToken.value)?.[1]?.toLowerCase();
        if (!method || !separator(index++, '=')) return null;
        const result = tokens[index++];
        if (result?.kind !== 'atom' || !/^[a-z][a-z0-9_-]*$/i.test(result.value)) return null;
        const properties = new Map<string, string>();
        while (index < tokens.length && !separator(index, ';')) {
            const keyToken = tokens[index++];
            if (keyToken?.kind !== 'atom') return null;
            const key = keyToken.value.toLowerCase();
            if (key !== 'reason' && !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/.test(key)) return null;
            if (!separator(index++, '=')) return null;
            const propertyValue = tokens[index++];
            if (!propertyValue || propertyValue.kind === 'separator' || properties.has(key)) return null;
            properties.set(key, propertyValue.value.toLowerCase());
        }
        results.push({ method, result: result.value.toLowerCase(), properties });
    }
    return { authservId, results };
}

/**
 * Only top-level raw headers belong here; embedded MIME headers stay with their message.
 * RFC 8601 §§4–5 require the receiving MTA to prepend its result and strip forged
 * results claiming its authserv-id. A configured id assumes that receiving boundary.
 * This verifies sender identity; Channels alone owns exact allowlist admission.
 */
export function evaluateEmailTrust(input: {
    headers: ReadonlyMap<string, readonly string[]>;
    from: string | null;
    sender: string | null;
    strategy: EmailTrustStrategy;
}): TrustResult {
    const from = input.from === null ? null : normalizeEmailAddress(input.from);
    if (!from || headerValues(input.headers, 'from').length > 1 || headerValues(input.headers, 'sender').length > 1) {
        return { trusted: false, markersMissing: false };
    }
    if (input.strategy.kind === 'exchangeOrganization') {
        const authAs = headerValues(input.headers, 'x-ms-exchange-organization-authas');
        const authSource = headerValues(input.headers, 'x-ms-exchange-organization-authsource');
        const sender = input.sender === null ? null : normalizeEmailAddress(input.sender);
        const internal = authAs.length === 1 ? unfoldHeader(authAs[0]!)?.trim().toLowerCase() : null;
        const source = authSource.length === 1 ? unfoldHeader(authSource[0]!)?.trim().toLowerCase() : null;
        const configuredSource = input.strategy.authSource.trim().toLowerCase();
        const markersMissing = !internal || !source || !sender || !configuredSource;
        return { trusted: !markersMissing && internal === 'internal' && source === configuredSource && sender === from, markersMissing };
    }
    const topmost = headerValues(input.headers, 'authentication-results')[0];
    const parsed = topmost === undefined ? null : authenticationResults(topmost);
    if (!parsed) return { trusted: false, markersMissing: true };
    const configuredId = input.strategy.authservId.trim().toLowerCase();
    if (!configuredId) return { trusted: false, markersMissing: true };
    if (parsed.authservId !== configuredId) return { trusted: false, markersMissing: false };
    const fromDomain = from.slice(from.lastIndexOf('@') + 1);
    let markersMissing = true;
    for (const result of parsed.results) {
        if (result.method !== 'dmarc' && result.method !== 'dkim') continue;
        const identity = result.properties.get(result.method === 'dmarc' ? 'header.from' : 'header.d');
        if (result.result !== 'pass' || identity) markersMissing = false;
        // Strict alignment. No suffix or guessed organizational-domain matching.
        if (result.result === 'pass' && identity === fromDomain) return { trusted: true, markersMissing: false };
    }
    return { trusted: false, markersMissing };
}

export function classifyEmailActor(input: {
    headers: ReadonlyMap<string, readonly string[]>;
    from: string | null;
    mailbox: string;
    trust: { trusted: boolean; markersMissing: boolean };
}): { principalId: string | null; kind: 'human' | 'unknown' | 'bot' | 'integration'; isIntegrationSelf: boolean } {
    const from = input.from === null ? null : normalizeEmailAddress(input.from);
    const principalId = input.trust.trusted ? from : null;
    const mailbox = normalizeEmailAddress(input.mailbox);
    if (from && from === mailbox) return { principalId, kind: 'integration', isIntegrationSelf: true };
    const values = (name: string) => headerValues(input.headers, name);
    const bot = values('auto-submitted').some((value) => value.split(';', 1)[0]?.trim().toLowerCase() !== 'no')
        || values('precedence').some((value) => /^(bulk|junk|list)$/i.test(value.trim()))
        || ['list-id', 'list-unsubscribe', 'x-autoreply', 'x-auto-reply', 'x-autorespond', 'x-ms-exchange-inbox-rules-loop'].some((name) => values(name).length > 0)
        || values('content-type').some((value) => /^(multipart\/report|message\/disposition-notification)$/i.test(value.split(';', 1)[0]?.trim() ?? ''));
    return { principalId, kind: bot ? 'bot' : principalId ? 'human' : 'unknown', isIntegrationSelf: false };
}
