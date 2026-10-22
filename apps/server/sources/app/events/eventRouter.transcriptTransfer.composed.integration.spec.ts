import { registerTranscriptFollowTimingTests } from './transcriptFollowTiming.composed.testkit';

// Calibration is informational. No transfer ceiling is admitted until the real
// transport scenario is stable across ten unchanged runs and rejects regression.
registerTranscriptFollowTimingTests('sqlite', 0, 'heavy-history-transfer');
