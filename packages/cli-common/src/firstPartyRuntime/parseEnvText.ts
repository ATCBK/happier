export function parseEnvText(raw: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of String(raw ?? '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx <= 0) continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1);
        if (!key) continue;
        env[key] = value;
    }
    return env;
}
