import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk/manifest';

const en = {
  "kind": "sandbox",
  "description": "Files persist across runs. Stopping ends running processes and clears their memory.",
  "image": "Image",
  "region": "Region",
  "vcpus": "vCPUs",
  "timeout": "Run timeout (milliseconds)",
  "snapshotExpiration": "Snapshot retention (milliseconds)",
  "timeoutDescription": "Defaults to 5 minutes. Maximum: 45 minutes on Hobby; 24 hours on Pro and Enterprise. Happier does not extend runs automatically.",
  "retentionDescription": "Use 0 for no expiry. Retained snapshots are billed after the sandbox stops.",
  "token": "Access token",
  "teamId": "Team ID",
  "projectId": "Project ID",
  "account": "Vercel account",
  "checkStatus": "Account connected",
  "checkUnavailable": "Vercel account unavailable. Check the token, team, and project.",
  "confirmTitle": "Create a Vercel sandbox?",
  "confirmBody": "Vercel bills running compute and retained snapshots. Files can persist across runs; process memory cannot.",
  "deleteTitle": "Delete this sandbox?",
  "deleteBody": "Deletes this sandbox and its owned snapshots. Its files cannot be recovered after deletion."
} as const;

export function label(key: keyof typeof en): PluginLocalizedStringV2 {
  return { key: 'machineVercel.' + key, fallback: en[key] };
}
