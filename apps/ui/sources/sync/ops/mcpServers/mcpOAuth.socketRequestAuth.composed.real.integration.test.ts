import { afterEach, beforeAll, it } from 'vitest';
import '../../../../../cli/src/vitestSetup';

import {
    exerciseMcpOAuthMachineTest,
    prepareMcpOAuthSocketRequestAuthFixture,
    closeMcpOAuthSocketRequestAuthFixture,
} from '../../../../../cli/src/mcp/oauth/mcpOAuthSocketRequestAuth.testkit.mjs';

beforeAll(prepareMcpOAuthSocketRequestAuthFixture);
afterEach(closeMcpOAuthSocketRequestAuthFixture);

it('composes authenticated sign-in, registered OAuth Test snapshot persistence and per-request bridge credentials',
    exerciseMcpOAuthMachineTest);
