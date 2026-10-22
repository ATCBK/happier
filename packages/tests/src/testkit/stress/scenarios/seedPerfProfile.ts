import { randomBytes } from 'node:crypto';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import type { TestAuth } from '../../auth';
import { buildTestAccountCliAuthCredentials } from '../../cliAuth';
import { createEncryptedArtifactViaApi } from '../../artifactApi';
import { registerMachineIdentity } from '../../machineIdentity';
import { encryptDataKeyBase64 } from '../../rpcCrypto';
import { createSessionWithCiphertexts } from '../../sessions';
import { fetchJson } from '../../http';
import { buildPerfProfile } from './perfProfile';
import { runStressTasksWithConcurrencyLimit } from './runStressTasksWithConcurrencyLimit';

export async function seedPerfProfile(params: {
  baseUrl: string; auth: TestAuth; seed: number; concurrency: number; workspaceDir: string;
  liveMachineId?: string;
}) {
  const profile = buildPerfProfile(params.seed);
  const credentials = buildTestAccountCliAuthCredentials({ auth: params.auth, mode: 'dataKey' });
  if (!('encryption' in credentials)) throw new Error('Performance E2EE fixture requires canonical data-key credentials');
  const wrap = (key: Uint8Array) => Buffer.from(sealEncryptedDataKeyEnvelopeV1({
    dataKey: key, recipientPublicKey: Buffer.from(credentials.encryption.publicKey, 'base64'), randomBytes,
  })).toString('base64');
  const machines = await runStressTasksWithConcurrencyLimit(profile.machines, params.concurrency, async (machine, index) => {
    if (index === 0 && params.liveMachineId) return params.liveMachineId;
    const dataKey = randomBytes(32);
    const response = await registerMachineIdentity({
      baseUrl: params.baseUrl, token: params.auth.token, machineId: machine.id,
      metadata: encryptDataKeyBase64({ ...machine, version: '0.0.0-perf-fixture', displayName: machine.host }, dataKey),
      dataEncryptionKey: wrap(dataKey),
    });
    if (response.status !== 200) throw new Error(`Performance Machine seed failed (${response.status})`);
    return response.machineId;
  });
  const sessions = await runStressTasksWithConcurrencyLimit(profile.sessions, params.concurrency, async (session, index) => {
    const dataKey = randomBytes(32);
    const created = await createSessionWithCiphertexts({
      baseUrl: params.baseUrl, token: params.auth.token, tag: session.tag,
      metadataCiphertextBase64: encryptDataKeyBase64({
        v: 1, name: session.title, path: params.workspaceDir, homeDir: params.workspaceDir,
        machineId: machines[session.machineIndex], host: profile.machines[session.machineIndex]!.host,
        version: '0.0.0-perf-fixture', flavor: 'claude',
      }, dataKey), dataEncryptionKeyBase64: wrap(dataKey),
      agentStateCiphertextBase64: encryptDataKeyBase64({ requests: {}, completedRequests: {} }, dataKey),
    });
    for (const [sequence, message] of session.messages.entries()) {
      const localId = `perf-${params.seed}-${index}-${sequence}`;
      const value = message.role === 'user'
        ? { role: 'user', content: { type: 'text', text: message.text } }
        : { role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: localId,
          message: { content: [{ type: 'text', text: message.text }] } } } };
      const response = await fetchJson<{ didWrite?: boolean }>(`${params.baseUrl}/v2/sessions/${created.sessionId}/messages`, {
        method: 'POST', headers: { Authorization: `Bearer ${params.auth.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': localId },
        body: JSON.stringify({ localId, content: { t: 'encrypted', c: encryptDataKeyBase64(value, dataKey) } }),
      });
      if (response.status !== 200 || response.data?.didWrite !== true) throw new Error(`Performance transcript seed failed (${response.status})`);
    }
    return { sessionId: created.sessionId, machineId: machines[session.machineIndex]!, dataKey, messageCount: session.messages.length, title: session.title };
  });
  const artifacts = [...profile.artifacts, ...profile.workflows];
  await runStressTasksWithConcurrencyLimit(artifacts, params.concurrency, async artifact => {
    await createEncryptedArtifactViaApi({
      baseUrl: params.baseUrl, token: params.auth.token, artifactId: artifact.id,
      headerJson: artifact.header, bodyJson: artifact.body, cliAccessKey: credentials,
    });
  });
  return { machines, sessions, summary: {
    seed: params.seed, machines: machines.length, sessions: sessions.length,
    transcriptMessages: sessions.reduce((count, session) => count + session.messageCount, 0),
    longTranscripts: sessions.filter(session => session.messageCount >= 500).length,
    artifacts: profile.artifacts.length, workflows: profile.workflows.length,
  } };
}
