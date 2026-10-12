import { expect, it } from 'vitest';
import { PAIRING_QR_MOMENT_SUPPORTED } from '../auth/pairing/PairingQrMoment';
import { ATMOSPHERE_RIPPLE_RING } from './AtmosphereRipple.native';

it('admits the normal native pairing choreography and session-finished ring', () => {
    expect(PAIRING_QR_MOMENT_SUPPORTED).toBe(true);
    expect(ATMOSPHERE_RIPPLE_RING).toBe(true);
});
