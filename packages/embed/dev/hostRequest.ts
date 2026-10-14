export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail: string | null = null;
    try {
      const payload: unknown = await response.json();
      if (typeof payload === 'object' && payload !== null && 'error' in payload) {
        const error = (payload as { error?: unknown }).error;
        if (typeof error === 'string' && error.trim().length > 0) detail = error;
      }
    } catch {
      // The fixture still has a stable status fallback for empty or non-JSON failures.
    }
    throw new Error(detail ?? `Request failed (${response.status})`);
  }
  return response.json();
}
