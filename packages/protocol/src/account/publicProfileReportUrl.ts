/** One admission rule for the service-owned report link, shared by configuration and public DTOs. */
export function normalizePublicProfileReportUrlV1(raw: string): string | null {
    const value = raw.trim();
    if (!value || /\p{Cc}/u.test(value)) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url.toString();
    if (url.protocol !== 'mailto:' || url.host || url.hash || value.slice('mailto:'.length).startsWith('//')) return null;
    let recipients: string;
    try {
        recipients = decodeURIComponent(url.pathname);
    } catch {
        return null;
    }
    if (!recipients.split(',').every(recipient => /^[^\s@/?#,;]+@[^\s@/?#,;]+$/.test(recipient))) return null;
    return url.toString();
}
