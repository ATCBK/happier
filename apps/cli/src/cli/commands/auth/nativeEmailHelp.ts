
export const NATIVE_EMAIL_USAGE = [
  'Usage:',
  '  happier auth email login --email <email> --password <password> [--invitation-token <token>] [--json]',
  '  happier auth email provision --email <email> --password <password> --mode plain|e2ee --verification-token <token> [--invitation-token <token>] [--json]',
  '  happier auth email provision --email <email> [--json]   (requests mailbox verification; no Account is created yet)',
  '  happier auth email connect --email <email> --password <password> [--verification-token <token>] [--yes] [--json]   (enters Account Security enrollment)',
  '  happier auth email verify-request --email <email> [--json]',
  '  happier auth email reset-request --email <email> [--json]',
  '  happier auth email reset-submit --token <bearer> --new-password <password> [--json]',
  '  happier auth email change-request --email <new-email> [--yes] [--json]   (authenticated; sends verification)',
  '  happier auth email change-complete --verification-token <token> [--json]   (authenticated; consumes verification)',
  '  happier auth recovery-key validate --key <recovery-key> [--json]',
  '  happier auth recovery-key login --key <recovery-key> [--json]',
].join('\n');

