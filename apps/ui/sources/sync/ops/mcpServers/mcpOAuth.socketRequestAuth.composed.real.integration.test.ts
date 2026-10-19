import { afterEach, beforeAll, it } from 'vitest';
import '../../../../../cli/src/vitestSetup';

import {
    exerciseMcpOAuthMachineTest,
    prepareMcpOAuthSocketRequestAuthFixture,
    closeMcpOAuthSocketRequestAuthFixture,
} from '../../../../../cli/src/mcp/oauth/mcpOAuthSocketRequestAuth.testkit.mjs';

beforeAll(() => prepareMcpOAuthSocketRequestAuthFixture({ encryptionMode: 'e2ee' }));
afterEach(closeMcpOAuthSocketRequestAuthFixture);

it('composes E2EE CLI sign-in and reconnect, registered OAuth Test persistence and consecutive Session tool calls',
    exerciseMcpOAuthMachineTest);
