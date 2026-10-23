import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
    emitSessionResumeRequest,
    useSessionResumeRequestListener,
    useSessionResumeRequestAvailable,
} from './sessionResumeRequests';

describe('sessionResumeRequests', () => {
    it('publishes exact-Home listener availability and withdraws it on unmount', async () => {
        const seen: boolean[] = [];
        function Availability() {
            const available = useSessionResumeRequestAvailable('availability-session', 'home-a');
            React.useEffect(() => { seen.push(available); }, [available]);
            return null;
        }
        const listener = async () => true;
        function Listener({ serverId }: { serverId: string }) {
            useSessionResumeRequestListener('availability-session', listener, serverId);
            return null;
        }
        const observer = await renderScreen(React.createElement(Availability));
        const otherHome = await renderScreen(React.createElement(Listener, { serverId: 'home-b' }));
        expect(seen).toEqual([false]);
        const exactHome = await renderScreen(React.createElement(Listener, { serverId: 'home-a' }));
        expect(seen).toEqual([false, true]);
        await exactHome.unmount();
        expect(seen).toEqual([false, true, false]);
        await otherHome.unmount();
        await observer.unmount();
    });
    it('rejects when the requested session has no registered resume listener', async () => {
        await expect(emitSessionResumeRequest('session-without-listener')).rejects.toThrow();
    });

    it('resumes only the exact Home and rejects an unavailable Home with a duplicate session ID', async () => {
        let resumedA = false;
        let resumedB = false;
        function ResumeListeners() {
            useSessionResumeRequestListener('same', async () => { resumedA = true; return true; }, 'home-a');
            useSessionResumeRequestListener('same', async () => { resumedB = true; return true; }, 'home-b');
            return null;
        }
        const screen = await renderScreen(React.createElement(ResumeListeners));
        await expect(emitSessionResumeRequest('same', 'home-b')).resolves.toBe(true);
        expect(resumedB).toBe(true);
        expect(resumedA).toBe(false);
        await expect(emitSessionResumeRequest('same', 'missing-home')).rejects.toThrow();
        expect(resumedA).toBe(false);
        await screen.unmount();
    });

    it('awaits only listeners registered for the requested session and unregisters on unmount', async () => {
        const requestedListener = vi.fn(async () => false);
        const otherSessionListener = vi.fn(async () => true);

        function ResumeListeners() {
            useSessionResumeRequestListener('requested-session', requestedListener);
            useSessionResumeRequestListener('other-session', otherSessionListener);
            return null;
        }

        const screen = await renderScreen(React.createElement(ResumeListeners));

        await expect(emitSessionResumeRequest('requested-session')).resolves.toBe(false);
        expect(requestedListener).toHaveBeenCalledTimes(1);
        expect(otherSessionListener).not.toHaveBeenCalled();

        await screen.unmount();
        await expect(emitSessionResumeRequest('requested-session')).rejects.toThrow();
    });
});
