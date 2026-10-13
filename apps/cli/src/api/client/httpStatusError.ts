import { readHttpStatus } from '@happier-dev/plugin-sdk/http';

export { readHttpStatus } from '@happier-dev/plugin-sdk/http';

export class HttpStatusError extends Error {
  readonly response: Readonly<{ status: number }>;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
    // Keep a minimal Axios-like shape so existing status-based policies can treat it consistently,
    // without carrying request config/headers that may include secrets.
    this.response = { status };
  }
}

export function isAuthenticationStatus(status: number | null | undefined): status is 401 | 403 {
  return status === 401 || status === 403;
}

export function isAuthenticationError(error: unknown): boolean {
  return isAuthenticationStatus(readHttpStatus(error));
}

export function readAuthenticationStatus(error: unknown): 401 | 403 | null {
  const status = readHttpStatus(error);
  return isAuthenticationStatus(status) ? status : null;
}

export function createHttpStatusError(status: number, message: string, code?: string): HttpStatusError & { code?: string } {
  const error = new HttpStatusError(status, message) as HttpStatusError & { code?: string };
  if (typeof code === 'string' && code.length > 0) {
    error.code = code;
  }
  return error;
}

export function createAuthenticationHttpStatusError(
  status: 401 | 403,
  message: string,
): HttpStatusError & { code?: string } {
  return createHttpStatusError(status, message, 'not_authenticated');
}
