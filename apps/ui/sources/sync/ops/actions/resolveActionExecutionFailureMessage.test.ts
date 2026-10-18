import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { resolveActionExecutionFailureMessage } from './resolveActionExecutionFailureMessage';

describe('Action failure presentation', () => {
    it('uses the existing permission denial for credential scope refusals', () => {
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' }, 'Fallback'))
            .toBe(t('errors.permissionDenied'));
    });

    it('retains ordinary Action failure and successful-result behavior', () => {
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: 'other_failure', error: 'Details' }, 'Fallback'))
            .toBe('Details');
        expect(resolveActionExecutionFailureMessage({ ok: true, result: { results: [{ ok: true }] } }, 'Fallback'))
            .toBeNull();
    });
});
