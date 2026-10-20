export function normalizeRelayAccessCanonicalPublicServerUrl(raw: unknown): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) {
        parsed.username = '';
        parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
}
