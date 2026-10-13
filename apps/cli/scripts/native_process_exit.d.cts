export function isNativeProcessExited(message: unknown): boolean;
export function reportNativeProcessExited(proc: Pick<NodeJS.Process, 'send' | 'connected' | 'stderr'>, code: number | null, signal: NodeJS.Signals | null): Promise<void>;
