import { expect, it } from 'vitest';
import { CapacityBar, CompositionStrip, RankedRows } from '@happier-dev/plugin-ui/presentation';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';

it('renders neutral inventory through the public package without Usage inputs', () => {
  const mount = mountThroughReactNativeWeb(<>
    <CapacityBar theme={SURFACE_CONTEXT_THEME_FIXTURE} label="Apples" value={2} capacity={5} basis="crates" />
    <CompositionStrip theme={SURFACE_CONTEXT_THEME_FIXTURE} label="Fruit" total={5} segments={[{ id: 'apples', label: 'Apples', value: 2 }]} />
    <RankedRows theme={SURFACE_CONTEXT_THEME_FIXTURE} label="Stock" rows={[{ id: 'apples', label: 'Apples', value: 2 }]} />
  </>);
  try { expect(mount.container.textContent).toContain('crates'); expect(mount.container.querySelectorAll('[role="listitem"]')).toHaveLength(2); }
  finally { mount.unmount(); }
});

it('reads a share-valued composition as names and shares, with an identity mark before each name', () => {
  const mount = mountThroughReactNativeWeb(
    <CompositionStrip theme={SURFACE_CONTEXT_THEME_FIXTURE} label="Agents" total={1} valueKind="share"
      appearance={{ legend: 'compact' }} shareFormatter={share => `${Math.round(share * 100)}%`}
      segments={[{ id: 'claude', label: 'Claude', value: 0.908450579565246, mark: <span data-testid="mark-claude" /> },
        { id: 'codex', label: 'Codex', value: 0.091549420434754 }]} />);
  try {
    const items = [...mount.container.querySelectorAll('[role="listitem"]')];
    const labels = items.map(item => item.getAttribute('aria-label') ?? '');
    expect(labels[0]).toContain('Claude');
    expect(labels[0]).toContain('91');
    // A share is never read as its raw fraction.
    expect(labels.join(' ')).not.toContain('0.9');
    expect(mount.container.querySelector('[data-testid="mark-claude"]')).not.toBeNull();
  } finally { mount.unmount(); }
});
