import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { describe, expect, it } from 'vitest';

import { applySessionVisualNetworkChoice, parseSessionVisualNetworkOrigins, readSessionVisualNetworkChoice } from './sessionBoardVisualNetwork';

const html = (requestedCapabilities?: unknown): SessionSurfaceItemV1 => ({
    v: 1, title: 'Dashboard', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main>Hi</main>'),
        ...(requestedCapabilities === undefined ? {} : { requestedCapabilities }) },
} as SessionSurfaceItemV1);

describe('Session visual network choice', () => {
    it('reads the stored policy as none, exact sites or any site', () => {
        expect(readSessionVisualNetworkChoice(html())).toEqual({ mode: 'none', origins: [] });
        expect(readSessionVisualNetworkChoice(html({ networkOrigins: ['https://b.example', 'https://a.example'] })))
            .toEqual({ mode: 'origins', origins: ['https://a.example', 'https://b.example'] });
        expect(readSessionVisualNetworkChoice(html({ network: 'open' }))).toEqual({ mode: 'open', origins: [] });
    });

    it('is not offered for a note, and a malformed stored policy is neither shown nor edited as open', () => {
        const note = { v: 1, title: 'Note', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: createSessionSurfaceNoteDocumentV1('Body') } } as SessionSurfaceItemV1;
        expect(readSessionVisualNetworkChoice(note)).toBeNull();
        const malformed = html({ network: 'open', networkOrigins: ['https://a.example'] });
        expect(readSessionVisualNetworkChoice(malformed)).toBeNull();
        expect(applySessionVisualNetworkChoice(malformed, { mode: 'none', origins: [] })).toBeNull();
    });

    it('writes the chosen network and keeps the rest of the stored request', () => {
        const base = html({ hostMethods: ['notify'], network: 'open' });
        const sites = applySessionVisualNetworkChoice(base, { mode: 'origins', origins: ['https://api.example.com'] });
        expect(sites?.source).toMatchObject({ requestedCapabilities: { hostMethods: ['notify'], networkOrigins: ['https://api.example.com'] } });
        expect(readSessionVisualNetworkChoice(sites!)).toEqual({ mode: 'origins', origins: ['https://api.example.com'] });
        expect(readSessionVisualNetworkChoice(applySessionVisualNetworkChoice(sites!, { mode: 'none', origins: [] })!))
            .toEqual({ mode: 'none', origins: [] });
    });

    it('separates typed sites from entries that are not exact HTTPS origins', () => {
        expect(parseSessionVisualNetworkOrigins('https://a.example/,\nhttps://b.example https://a.example')).toEqual({
            origins: ['https://a.example', 'https://b.example'], invalid: [] });
        expect(parseSessionVisualNetworkOrigins('http://a.example\nhttps://*.b.example\nhttps://c.example/path').invalid)
            .toEqual(['http://a.example', 'https://*.b.example', 'https://c.example/path']);
    });
});
