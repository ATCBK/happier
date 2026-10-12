import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas.web';
import {
  homePlanetDrawnHeight,
  homePlanetGeometry,
  homePlanetSceneOptions,
  homeRiseFootFade,
  homeRiseLimb,
} from '@/components/atmosphere/homePlanetPlacement';

/**
 * Rise foot-fade harness (FX6): Home's Rise planet through the product painter at the live 1440 × 900
 * Home pane, with a hero that runs past the fold. `drawn: false` reproduces the pane-height canvas.
 */
type Input = Readonly<{ theme: 'light' | 'dark'; drawn: boolean; nextTop: number; aboveBottom: number; composerTop: number }>;
const pane = { width: 991, height: 850 };
const mount = document.getElementById('product');
if (!mount) throw new Error('Missing harness mount');
const root = createRoot(mount);

function Rise(props: Input & { onReady: () => void }) {
  const fade = homeRiseFootFade({ aboveBottom: props.aboveBottom, nextTop: props.nextTop, phone: false });
  const height = props.drawn ? homePlanetDrawnHeight(pane.height, fade) : pane.height;
  const geometry = homePlanetGeometry('rise', pane, { widgets: true, limb: homeRiseLimb(props.composerTop) });
  const options = homePlanetSceneOptions(geometry, { width: pane.width, height }, { theme: props.theme, style: 'balanced', digits: true });
  const page = props.theme === 'dark' ? '#131111' : '#f5f5f5';
  return (
    <div style={{ position: 'relative', width: pane.width, height: 1100, background: page, overflow: 'hidden' }}>
      <PlanetCanvas width={pane.width} height={height} options={options} fade={fade} onReady={props.onReady} />
      <div style={{ position: 'absolute', left: 0, top: pane.height, width: 14, height: 1, background: '#888' }} />
      <div style={{ position: 'absolute', left: 0, top: props.nextTop, width: 28, height: 1, background: '#888' }} />
    </div>
  );
}

(window as unknown as { FX6: unknown }).FX6 = {
  rise: (input: Input) => new Promise<void>((resolve) => root.render(<Rise {...input} onReady={resolve} />)),
};
