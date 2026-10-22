import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

// These two controls belong to the client/transcript lifetime, not the host
// generation. All other members come directly from the typed installed source.
type ClientOwnedControl = 'wakePendingMaterialization' | 'preparePendingMessageComposerAdmission';
type InstalledRuntimeControls = Omit<SessionRuntimeControls, ClientOwnedControl>;

function installedRuntimeControls({
  wakePendingMaterialization: _wake,
  preparePendingMessageComposerAdmission: _admission,
  ...controls
}: SessionRuntimeControls): InstalledRuntimeControls {
  return controls;
}

export function applySessionRuntimeControls(
  target: Partial<SessionRuntimeControls>,
  controls: SessionRuntimeControls | null,
): void {
  for (const key of Object.keys(installedRuntimeControls(target)) as (keyof InstalledRuntimeControls)[]) {
    delete target[key];
  }
  if (controls) Object.assign(target, installedRuntimeControls(controls));
}
