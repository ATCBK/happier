// Native canary qualification established confinement on this exact release.
// Managed installation and native admission consume the same support basis;
// a newer version must be qualified before changing it.
export const CODEX_SUPPORTED_RUNTIME_VERSION = '0.162.1';
export const CODEX_SUPPORTED_RUNTIME_RELEASE_TAG = `rust-v${CODEX_SUPPORTED_RUNTIME_VERSION}`;

export const CODEX_TOOL_RESTRICTION_RUNTIME_REMEDY =
  `Codex cannot enforce the requested native tool policy for this configuration. `
  + `Use Codex ${CODEX_SUPPORTED_RUNTIME_VERSION}; reinstall it on the selected Machine `
  + `with Happier's Install Action (machines.agents.install, intent: install, force: true).`;
