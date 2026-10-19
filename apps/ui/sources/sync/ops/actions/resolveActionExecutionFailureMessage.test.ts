import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureMessage } from './resolveActionExecutionFailureMessage';

describe('Action failure presentation', () => {
    it('uses the existing permission denial for credential scope refusals', () => {
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' }, 'Fallback'))
            .toBe(t('errors.permissionDenied'));
    });

    it('says the Home did not confirm a widget write whose acknowledgement never came back, instead of the generic fallback', () => {
        for (const errorCode of ['widget_add_unknown', 'widget_write_ack_unknown']) {
            expect(resolveActionExecutionErrorMessage({ kind: 'refused', errorCode }, 'Couldn’t add it.')).toBe(t('widgetAdd.refusals.writeUnconfirmed'));
        }
        expect(resolveActionExecutionErrorMessage({ kind: 'refused', errorCode: 'something_else' }, 'Couldn’t add it.')).toBe('Couldn’t add it.');
    });

    it('retains ordinary Action failure and successful-result behavior', () => {
        expect(resolveActionExecutionFailureMessage({ ok: false, errorCode: 'other_failure', error: 'Details' }, 'Fallback'))
            .toBe('Details');
        expect(resolveActionExecutionFailureMessage({ ok: true, result: { results: [{ ok: true }] } }, 'Fallback'))
            .toBeNull();
    });
});
