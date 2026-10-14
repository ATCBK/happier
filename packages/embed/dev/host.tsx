import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HappierSession } from '@happier-dev/embed/react';
import type { EmbedCredential, EmbedCredentialRequest } from '@happier-dev/embed';
import { request } from './hostRequest';

type Lead = { id: string; name: string; contact: string; notes: string; stage: string; sessionId: string | null;
  analysis: { score: number; summary: string; nextStep: string } | null; stageUpdates: number };
type State = { userId: string; happierUrl: string; leads: Lead[]; copilotSessionId: string | null };

const getCredential = (input: EmbedCredentialRequest) => request<EmbedCredential>('/api/happier/credential', input);

function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [selectedId, setSelectedId] = useState('northstar');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [activity, setActivity] = useState('idle');
  const [copilotActivity, setCopilotActivity] = useState('idle');
  const refresh = () => request<State>('/api/state').then(setState).catch((cause: Error) => setError(cause.message));
  useEffect(() => { void refresh(); }, []);
  const lead = state?.leads.find((entry) => entry.id === selectedId) ?? state?.leads[0];
  if (!state) return <main><h1>Leads</h1><p role="status">{error || 'Opening your pipeline…'}</p></main>;
  return <main>
    <header><div><p className="eyebrow">Fieldwork</p><h1>Your next conversation</h1><p>Understand the lead, then make the next move.</p></div>
      <label>Salesperson <select aria-label="Salesperson" value={state.userId} onChange={async (event) => {
        await request('/api/user', { userId: event.target.value }); await refresh();
      }}><option value="salesperson">Maya</option><option value="other-salesperson">Sam</option></select></label>
    </header>
    {error && <p role="alert">{error} <button onClick={() => { setError(''); void refresh(); }}>Retry</button></p>}
    <div className="workspace">
      <aside aria-label="Lead pipeline"><h2>Inbound leads</h2><table><thead><tr><th>Company</th><th>Stage</th></tr></thead><tbody>
        {state.leads.map((entry) => <tr key={entry.id} data-selected={entry.id === lead?.id}><td>
          <button data-testid={`lead-${entry.id}`} onClick={() => setSelectedId(entry.id)}>{entry.name}</button>
        </td><td>{entry.stage}</td></tr>)}
      </tbody></table><button className="quiet" onClick={() => void refresh()}>Refresh pipeline</button></aside>
      {lead && <section aria-label="Lead detail"><div className="section-heading"><div><h2>{lead.name}</h2><p>{lead.contact}</p></div><span className="badge" role="status">{activity.replace('_', ' ')}</span></div>
        <p>{lead.notes}</p>
        <article className="analysis" aria-label="Lead analysis">{lead.analysis ? <><p className="score">{lead.analysis.score}<small>/100 fit</small></p><p>{lead.analysis.summary}</p><p><strong>Next step</strong> · {lead.analysis.nextStep}</p></> : <><h3>Find your opening</h3><p>Let the agent read these notes and suggest a useful next step.</p></>}</article>
        {lead.sessionId ? <div className="chat"><HappierSession happierUrl={state.happierUrl} sessionId={lead.sessionId} getCredential={getCredential}
          title={`Chat about ${lead.name}`} onStateChange={(next) => { setActivity(next.activity ?? next.phase); if (next.phase === 'ready') void refresh(); }} /></div>
          : <button className="primary" disabled={creating} data-testid="analyze-lead" onClick={async () => {
            setCreating(true); setError('');
            try { await request(`/api/leads/${lead.id}/chat`, {}); await refresh(); }
            catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to open this lead.'); }
            finally { setCreating(false); }
          }}>{creating ? 'Starting analysis…' : 'Analyze this lead'}</button>}
      </section>}
      <section className="copilot" aria-label="Pipeline copilot"><div className="section-heading"><h2>Pipeline copilot</h2><span className="badge" role="status">{copilotActivity.replace('_', ' ')}</span></div><p>A place to work across your pipeline.</p>
        <div className="chat"><HappierSession key={state.userId} happierUrl={state.happierUrl} sessionId={state.copilotSessionId ?? undefined}
          getCredential={getCredential} title="Pipeline copilot"
          onSessionCreated={() => { /* Creation is a fact; verified mint on the backend establishes ownership. */ void refresh(); }}
          onStateChange={(next) => { setCopilotActivity(next.activity ?? next.phase); if (next.phase === 'ready') void refresh(); }} /></div>
      </section>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Dashboard />);
