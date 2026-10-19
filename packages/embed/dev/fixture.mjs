import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EmbedCredentialRequestV1Schema } from '@happier-dev/protocol/embed';
import { actionSchemas } from './leads-fixture/contracts.mjs';

/** The fixture owns both endpoints, so every frame must select the same Home as its server SDK. */
export function buildFixtureHappierUrl(happierUrl, serverUrl) {
  const url = new URL(happierUrl);
  url.searchParams.set('server', serverUrl);
  return url.href;
}

/** CRM records are dev-only memory; host reloads retain them, server restarts reset them. */
export function createFixtureStore() {
  const requestNamespace = randomUUID();
  const leads = [
    { id: 'northstar', name: 'Northstar Labs', contact: 'Maya · Head of operations', ownerId: 'salesperson',
      notes: 'A 40-person research team wants to reduce manual inbound triage. Maya owns evaluation; budget review is next Tuesday.' },
    { id: 'verdant', name: 'Verdant Supply', contact: 'Luis · Commercial lead', ownerId: 'salesperson',
      notes: 'A regional supplier needs faster follow-up on distributor enquiries. Luis asked for an example workflow and clear pricing.' },
    { id: 'alpine', name: 'Alpine Studio', contact: 'Sam · Founder', ownerId: 'other-salesperson',
      notes: 'A design studio is exploring a lightweight pipeline. Sam is still comparing approaches and has no decision date.' },
  ].map((lead) => ({ ...lead, analysis: null, stage: 'new', stageUpdates: 0, sessionId: null }));
  const sessionOwners = new Map();
  const copilots = new Map();
  const invocations = new Map();
  const claim = (userId, sessionId) => {
    const incumbent = sessionOwners.get(sessionId);
    if (incumbent && incumbent !== userId) throw new Error('session_forbidden');
    sessionOwners.set(sessionId, userId);
  };
  return {
    listLeads: (userId) => structuredClone(leads.filter((lead) => lead.ownerId === userId)),
    canOpenSession: (userId, sessionId) => sessionOwners.get(sessionId) === userId,
    copilotSessionId: (userId) => copilots.get(userId) ?? null,
    leadCreationRequestId: (userId, leadId) => `fixture-lead-${requestNamespace}-${userId}-${leadId}`,
    attachLeadSession(userId, leadId, sessionId) {
      const lead = leads.find((entry) => entry.id === leadId && entry.ownerId === userId);
      if (!lead) throw new Error('lead_forbidden');
      claim(userId, sessionId);
      lead.sessionId = sessionId;
    },
    claimCopilot(userId, sessionId) {
      claim(userId, sessionId);
      copilots.set(userId, sessionId);
    },
    apply(action, input, idempotencyKey, sessionId) {
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new Error('idempotency_key_required');
      if (!Object.hasOwn(actionSchemas, action)) throw new Error('action_not_found');
      const parsed = actionSchemas[action].parse(input);
      const ownerId = sessionOwners.get(sessionId);
      if (!ownerId) throw new Error('session_forbidden');
      const lead = leads.find((entry) => entry.id === parsed.leadId);
      if (!lead) throw new Error('lead_not_found');
      if (lead.ownerId !== ownerId) throw new Error('lead_forbidden');
      const previous = invocations.get(idempotencyKey);
      if (previous) {
        if (previous.action !== action || !isDeepStrictEqual(previous.input, parsed)) throw new Error('idempotency_conflict');
        return structuredClone(previous.result);
      }
      if (action === 'record_analysis') {
        lead.analysis = { score: parsed.score, summary: parsed.summary, nextStep: parsed.nextStep };
      } else {
        lead.stage = parsed.stage;
        lead.stageUpdates += 1;
      }
      const result = { leadId: lead.id, invocationId: idempotencyKey };
      invocations.set(idempotencyKey, { action, input: parsed, result });
      return structuredClone(result);
    },
  };
}

/** Claim CRM ownership before the agent can call the business Actions in its first turn. */
export async function createLeadChat({ happier, store, userId, leadId }) {
  const lead = store.listLeads(userId).find((entry) => entry.id === leadId);
  if (!lead) throw new Error('lead_forbidden');
  const session = lead.sessionId ? happier.sessions.get(lead.sessionId)
    : await happier.embed.createSession({ title: lead.name }, { requestId: store.leadCreationRequestId(userId, lead.id) });
  store.attachLeadSession(userId, lead.id, session.id);
  const result = await session.send(
    `Analyze this lead. Call the Leads fixture record-analysis Action with leadId=${lead.id}, score (0-100), summary and nextStep.\n${lead.notes}`,
    { requestId: `fixture-analysis-${userId}-${lead.id}` },
  );
  if (result.status !== 'accepted' && result.status !== 'alreadyAccepted') {
    throw new Error(`fixture_initial_input_${result.status}`);
  }
  return session.id;
}

/** Generated-snippet credential flow with the CRM's user/session authorization rule. */
export function createCredentialIssuer({ embed, store, expiresInSeconds = 900 }) {
  const newChatIssuedTo = new Map();
  return {
    async issue(userId, input) {
      const request = EmbedCredentialRequestV1Schema.parse({ ...input, kind: 'credential.request' });
      for (const [tokenId, issued] of newChatIssuedTo) {
        if (issued.expiresAt <= Date.now()) newChatIssuedTo.delete(tokenId);
      }
      const { sessionId, embedPublicKey, reason, createdByTokenId } = request;
      if (!sessionId) {
        const credential = await embed.createCredential({ embedPublicKey, expiresInSeconds });
        newChatIssuedTo.set(credential.tokenId, { userId, expiresAt: Date.parse(credential.expiresAt) });
        return credential;
      }
      if (reason === 'created') {
        if (newChatIssuedTo.get(createdByTokenId)?.userId !== userId) throw new Error('session_forbidden');
        const credential = await embed.createCredential({
          sessionId, embedPublicKey, expiresInSeconds, requireCreatedBy: createdByTokenId,
        });
        // Mint is the server-verified creation proof. The callback's session id alone grants nothing.
        store.claimCopilot(userId, sessionId);
        // Keep the issuance record until its child expires, so failed admission can retry the exchange.
        return credential;
      }
      if (!store.canOpenSession(userId, sessionId)) throw new Error('session_forbidden');
      return embed.createCredential({ sessionId, embedPublicKey, expiresInSeconds });
    },
  };
}
