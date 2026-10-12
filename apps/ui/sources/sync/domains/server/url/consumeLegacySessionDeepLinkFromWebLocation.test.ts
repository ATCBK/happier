import { afterEach, expect, it, vi } from 'vitest';

import { consumeLegacySessionDeepLinkFromWebLocation } from './consumeLegacySessionDeepLinkFromWebLocation';

afterEach(() => vi.unstubAllGlobals());

function consume(href: string) {
    let location = new URL(href);
    let destination: string | null = null;
    // Browser location/history are the genuine external boundary; route logic is real.
    vi.stubGlobal('window', { location: { href } });
    const consumed = consumeLegacySessionDeepLinkFromWebLocation({
        isAuthenticated: true,
        replaceRelativeUrl: (next) => { location = new URL(next, location); },
        navigateToRoute: (next) => { destination = next; },
    });
    return { consumed, destination, cleaned: location.pathname + location.search + location.hash };
}

it('keeps Home, message and child identity when consuming a genuine Root link', () => {
    const home = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const result = consume(`https://app.example.test/?id=session-123&serverId=${home}&messageId=message%2F1&jumpChildId=child%2F2`);
    expect(result.consumed).toBe(true);
    expect(result.destination).toBe(`/session/session-123/message/message%2F1?serverId=${home}&jumpChildId=child%2F2`);
    expect(new URL(result.cleaned, 'https://app.example.test').searchParams.get('id')).toBeNull();
});

it('keeps an unqualified historical link unqualified', () => {
    expect(consume('https://app.example.test/?id=session-123')).toEqual({
        consumed: true, destination: '/session/session-123', cleaned: '/',
    });
});

it('does not interpret an entity route query as a legacy Session', () => {
    expect(consume('https://app.example.test/machine/machine-123?id=session-123&serverId=srv_example')).toEqual({
        consumed: false, destination: null,
        cleaned: '/machine/machine-123?id=session-123&serverId=srv_example',
    });
});
