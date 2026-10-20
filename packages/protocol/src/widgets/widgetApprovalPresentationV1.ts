import type { ApprovalPresentationContext } from '../actions/actionSpecs.js';
import { readRecord } from '../inputs/inputRecords.js';
import { PluginUiSurfaceBindingV1Schema } from '../plugins/contributions/ui/surfaceRegistry.js';
import type { WidgetSurfaceRefV1 } from './widgetInstanceV1.js';

/** Reads admitted declaration display data only; names never select a page or grant access. */
export function describeWidgetAreaApprovalSurfaceV1(surface: WidgetSurfaceRefV1, entries: readonly unknown[]): NonNullable<ApprovalPresentationContext['widgetPresentation']> | null {
  const owner = surface.owner;
  if (owner.kind !== 'pluginArea') return null;
  const matches: Readonly<Record<string, unknown>>[] = [];
  for (const raw of entries) {
    const entry = readRecord(raw);
    const binding = PluginUiSurfaceBindingV1Schema.safeParse(entry.binding);
    if (!binding.success || binding.data.kind !== 'destination' || binding.data.container !== 'appPage'
      || binding.data.destination.pluginId !== owner.pluginId || binding.data.destination.localId !== owner.pageId) continue;
    matches.push(entry);
  }
  if (matches.length !== 1) return null;
  const display = readRecord(matches[0]!.display);
  const name = typeof display.title === 'string' ? display.title : typeof display.developerFallback === 'string' ? display.developerFallback : null;
  if (!name?.trim()) return null;
  // Area declarations expose a local name, not a separate authored title.
  const areaName = owner.area.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return { pageName: name.trim(), areaName: areaName.charAt(0).toUpperCase() + areaName.slice(1) };
}

/** Preview metadata is presentation-only and remains optional for existing requests. */
export function readWidgetApprovalPresentationV1(preview: unknown): ApprovalPresentationContext['widgetPresentation'] {
  const value = readRecord(readRecord(preview).widgetPresentation);
  const name = (key: string) => typeof value[key] === 'string' && value[key].trim() ? value[key].trim() : undefined;
  const widgetName = name('widgetName'), pageName = name('pageName'), areaName = name('areaName');
  return widgetName || pageName || areaName ? { ...(widgetName ? { widgetName } : {}), ...(pageName ? { pageName } : {}), ...(areaName ? { areaName } : {}) } : undefined;
}
