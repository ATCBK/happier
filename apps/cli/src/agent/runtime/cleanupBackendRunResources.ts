import { stopCaffeinate } from '@/integrations/caffeinate';

export async function cleanupBackendRunResources(opts: {
  stopKeepAlive: () => void;
  reconnectionHandle?: { cancel: () => void } | null;
  stopMcpServer: () => void;
  resetRuntime: () => Promise<void>;
  unmountUi: () => void;
}): Promise<void> {
  opts.stopKeepAlive();
  opts.reconnectionHandle?.cancel();
  stopCaffeinate();
  opts.stopMcpServer();
  await opts.resetRuntime();
  opts.unmountUi();
}
