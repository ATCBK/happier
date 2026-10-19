import { sanitizeBugReportUrl } from '@happier-dev/protocol/bugs/reports/sanitize';
import { sanitizeDoctorSnapshotUrls, type DoctorSnapshot } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import type { DiagnosisReportV1 } from '@happier-dev/protocol/actions/diagnosticsActionFamily';

import { createDiagnosticServerUrlKey as createComparableServerUrlKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { isDaemonOfAnotherAccount } from '@/sync/domains/server/relayDrift/relayDriftModel';

export type DiagnosisFinding = Readonly<DiagnosisReportV1['findings'][number]>;
export type DiagnosisFindingSeverity = DiagnosisFinding['severity'];
export type DiagnosisFindingCode = DiagnosisFinding['code'];

export type ServerDiagnosticsStatus =
  | { state: 'ok' }
  | { state: 'disabled' }
  | { state: 'auth_error' }
  | { state: 'timeout' }
  | { state: 'http_error'; httpStatus: number }
  | { state: 'unknown'; detail: string };

export type DiagnosisInput = Readonly<{
  ui: Readonly<{
    activeServerId: string;
    activeServerUrl: string;
    profileId: string | null;
  }>;
  serverProfiles: ReadonlyArray<Readonly<{ id: string; serverUrl: string }>>;
  machinesByServerId: Readonly<Record<string, ReadonlyArray<Readonly<{ id: string; active: boolean }>>>>;
  machineDoctorSnapshots: ReadonlyArray<Readonly<{ machineId: string; serverId: string; snapshot: DoctorSnapshot }>>;
  pastedDoctorSnapshots: ReadonlyArray<DoctorSnapshot>;
  serverDiagnostics: ServerDiagnosticsStatus;
  nowMs: number;
}>;

export type DiagnosisReport = Readonly<DiagnosisReportV1>;

function normalizeUrl(raw: string): string {
  const sanitized = sanitizeBugReportUrl(raw) ?? raw;
  return sanitized.replace(/\/+$/, '');
}

function pushFinding(findings: DiagnosisFinding[], finding: DiagnosisFinding): void {
  const key = `${finding.code}:${(finding.machineIds ?? []).join(',')}:${JSON.stringify(finding.details ?? {})}`;
  if (findings.some((f) => `${f.code}:${(f.machineIds ?? []).join(',')}:${JSON.stringify(f.details ?? {})}` === key)) return;
  findings.push(finding);
}

export function buildDiagnosisReport(input: DiagnosisInput): DiagnosisReport {
  const findings: DiagnosisFinding[] = [];
  const uiServerUrl = normalizeUrl(input.ui.activeServerUrl);
  const uiServerComparableKey = createComparableServerUrlKey(input.ui.activeServerUrl);
  const uiProfileId = input.ui.profileId;

  const activeMachines = input.machinesByServerId[input.ui.activeServerId] ?? [];
  if (activeMachines.filter((m) => m.active).length === 0) {
    pushFinding(findings, {
      code: 'machine.none_online',
      severity: 'warning',
      details: { activeServerId: input.ui.activeServerId },
    });
  }

  const normalizedServerProfileUrls = new Set(input.serverProfiles.map((p) => createComparableServerUrlKey(p.serverUrl)));
  if (uiServerComparableKey && !normalizedServerProfileUrls.has(uiServerComparableKey)) {
    pushFinding(findings, {
      code: 'server.profile_missing_for_active_url',
      severity: 'warning',
      details: { activeServerUrl: uiServerUrl },
    });
  }

  const machineServerUrlSet = new Set<string>();

  for (const entry of input.machineDoctorSnapshots) {
    const snapshot = sanitizeDoctorSnapshotUrls(entry.snapshot);
    const machineServerUrl = normalizeUrl(snapshot.server.serverUrl);
    const machineServerComparableKey = createComparableServerUrlKey(snapshot.server.serverUrl);
    if (machineServerComparableKey) machineServerUrlSet.add(machineServerComparableKey);

    if (uiServerComparableKey && machineServerComparableKey && uiServerComparableKey !== machineServerComparableKey) {
      pushFinding(findings, {
        code: 'server.mismatch.ui_vs_machine',
        severity: 'error',
        machineIds: [entry.machineId],
        details: { uiServerUrl, machineServerUrl },
      });
    }

    // The account comparison is the drift owner's (`relayDriftModel`), shared with every surface
    // that describes a daemon.
    if (isDaemonOfAnotherAccount({ daemonAccountId: snapshot.accountId, appAccountId: uiProfileId })) {
      pushFinding(findings, {
        code: 'auth.mismatch.ui_vs_machine_account',
        severity: 'error',
        machineIds: [entry.machineId],
        details: { uiProfileId, machineAccountId: snapshot.accountId ?? undefined },
      });
    } else if (!snapshot.accountId) {
      pushFinding(findings, {
        code: 'auth.machine_missing_account',
        severity: 'warning',
        machineIds: [entry.machineId],
      });
    }

    if (snapshot.settings.activeServerId && snapshot.settings.activeServerId !== snapshot.server.activeServerId) {
      pushFinding(findings, {
        code: 'server.mismatch.settings_vs_resolved',
        severity: 'warning',
        machineIds: [entry.machineId],
        details: { settingsActiveServerId: snapshot.settings.activeServerId, resolvedServerId: snapshot.server.activeServerId },
      });
    }
  }

  if (machineServerUrlSet.size > 1) {
    pushFinding(findings, {
      code: 'server.multiple_machines_multiple_servers',
      severity: 'warning',
      details: { machineServerUrls: Array.from(machineServerUrlSet.values()) },
    });
  }

  for (const snapshot of input.pastedDoctorSnapshots) {
    const sanitized = sanitizeDoctorSnapshotUrls(snapshot);
    const pastedServerUrl = normalizeUrl(sanitized.server.serverUrl);
    const pastedServerComparableKey = createComparableServerUrlKey(sanitized.server.serverUrl);
    if (uiServerComparableKey && pastedServerComparableKey && uiServerComparableKey !== pastedServerComparableKey) {
      pushFinding(findings, {
        code: 'server.mismatch.ui_vs_pasted',
        severity: 'warning',
        details: { uiServerUrl, pastedServerUrl },
      });
    }
  }

  switch (input.serverDiagnostics.state) {
    case 'ok':
      break;
    case 'disabled':
      pushFinding(findings, { code: 'server.diagnostics_disabled', severity: 'info' });
      break;
    case 'auth_error':
      pushFinding(findings, { code: 'auth.server_401', severity: 'error' });
      break;
    case 'timeout':
      pushFinding(findings, { code: 'server.unreachable', severity: 'error' });
      break;
    case 'http_error':
      pushFinding(findings, { code: 'server.http_error', severity: 'error', details: { httpStatus: input.serverDiagnostics.httpStatus } });
      break;
    case 'unknown':
      pushFinding(findings, { code: 'server.http_error', severity: 'warning', details: { detail: input.serverDiagnostics.detail } });
      break;
  }

  return {
    capturedAt: new Date(input.nowMs || Date.now()).toISOString(),
    findings,
  };
}
