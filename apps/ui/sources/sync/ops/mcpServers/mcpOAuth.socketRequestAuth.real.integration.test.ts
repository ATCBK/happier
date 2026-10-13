import { afterEach, it } from 'vitest';

import {
    exerciseMcpOAuthSocketRequestAuth,
    closeMcpOAuthSocketRequestAuthFixture,
} from '../../../../../cli/src/mcp/oauth/mcpOAuthSocketRequestAuth.testkit.mjs';

afterEach(closeMcpOAuthSocketRequestAuthFixture);

it('composes authenticated socket sign-in, durable issuer validation and per-request bridge credentials',
    exerciseMcpOAuthSocketRequestAuth);
