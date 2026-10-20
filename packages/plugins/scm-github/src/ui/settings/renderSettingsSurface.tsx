import { createTriageSourceSettingsSurface } from '@happier-dev/triage-sources/ui';
import { GITHUB_CONNECTED_ACCOUNT_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../../triage/contribution.js';
import { decodeGithubTriageConfiguration, encodeGithubTriageConfiguration, GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1 } from '../../triage/configuration.js';

/** The shared page owns the control and lifecycle; GitHub owns only its private token. */
export const renderSurface = createTriageSourceSettingsSurface({
  pluginId: GITHUB_PLUGIN_ID,
  listInstancesLocalActionId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances,
  connectedAccountServiceLocalId: GITHUB_CONNECTED_ACCOUNT_ID,
  connectedAccountPurpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  sourceDisplayName: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1.displayName,
  scopeSelection: {
    unitLabel: 'repositories',
    listScopeUnitsLocalActionId: GITHUB_TRIAGE_ACTION_IDS_V1.listScopeUnits,
    readSelection: (draft) => {
      const decoded = decodeGithubTriageConfiguration(draft.configuration.token);
      return decoded.ok ? decoded.configuration.selection : null;
    },
    writeSelection: (draft, selection, units) => {
      const token = encodeGithubTriageConfiguration({ v: 1, selection, units });
      return token === null ? null : { ...draft, configuration: { v: 1, token } };
    },
  },
  configuredInstanceKeyStability: GITHUB_TRIAGE_INSTANCE_KEY_STABILITY_V1,
  nativeLoginLabel: { key: 'plugins.github.settings.nativeLogin', fallback: 'Use this machine’s GitHub CLI login' },
  nativeAuthenticationFailureLabel: { key: 'plugins.github.settings.nativeLoginUnavailable', fallback: 'Sign in with gh CLI on this machine.' },
});
