import { describe, expect, it } from 'vitest';

import { isOriginalTerminalExecutionAction } from './externalActionExecutionAuthorization';

describe('paired terminal Action admission', () => {
    it('admits the Machine repository resolver without manufacturing a Session origin', () => {
        // The QA terminal bearer authenticated ordinary reads, but the loaded
        // server's narrower allowlist refused this catalog-owned Machine Action.
        expect(isOriginalTerminalExecutionAction('scm.hostingRepository.resolveAddress')).toBe(true);
    });
});
