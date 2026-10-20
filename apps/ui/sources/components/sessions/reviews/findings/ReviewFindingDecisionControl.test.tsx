import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { commitPreferredLanguage, getPreferredLanguage } from '@/text/preferredLanguage';
import { ReviewFindingDecisionControl } from './ReviewFindingRow';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const { getPreferredLanguage } = await import('@/text/preferredLanguage');
    return createTextModuleMock({ translate: (key) => `${getPreferredLanguage()}:${key}` });
});

const initialLanguage = getPreferredLanguage();
afterEach(async () => { await act(async () => { commitPreferredLanguage(initialLanguage); }); });

it('updates mounted finding decisions on a committed locale switch', async () => {
    commitPreferredLanguage('en');
    const screen = await renderScreen(<ReviewFindingDecisionControl testIDPrefix="decisions"
        decision="undecided" disabled={false} onDecide={() => {}} />);
    expect(screen.getTextContent()).toContain('en:session.reviewFindings.status.accept');
    await act(async () => { commitPreferredLanguage('fr'); });
    for (const decision of ['accept', 'reject', 'defer']) {
        expect(screen.getTextContent()).toContain(`fr:session.reviewFindings.status.${decision}`);
    }
});
