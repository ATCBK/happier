import type { AccountJsonKvCollectionPort } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { kvGet, kvList, kvMutate } from '@/sync/api/account/apiKv';
import type { ServerFetch } from '@/sync/http/client';
import { resolveTodoAccountStorageContext } from './todoOps';
import { decodeTodoStoredContent, encodeTodoStoredContent } from './todoStoredContent';
import { isRawAccountStorageEncryption } from '@/sync/encryption/accountStorageContext';

/** Reuses Todo's released envelope and authoritative Account-mode admission. */
export function createTodoAccountKvTransport(args: Readonly<{
  credentials: AuthCredentials; request: ServerFetch; requireCurrent: () => void;
}>): AccountJsonKvCollectionPort {
  const context = async () => { args.requireCurrent(); const value = await resolveTodoAccountStorageContext(args.credentials, { request: args.request }); args.requireCurrent(); return value; };
  return {
    read: async key => {
      const admitted = await context();
      const row = await kvGet(args.credentials, key, { request: args.request, retry: 'none' });
      args.requireCurrent();
      return { value: row ? (await decodeTodoStoredContent({ key, encoded: row.value, expectedMode: admitted.mode, encryption: admitted.encryption })).value : null, version: row?.version ?? -1 };
    },
    list: async prefix => {
      const admitted = await context();
      const rows: { key: string; value: unknown; version: number }[] = [];
      const seen = new Set<string>();
      let afterKey: string | undefined;
      for (;;) {
        const page = await kvList(args.credentials, { prefix, limit: 1000, afterKey, request: args.request, retry: 'none' });
        args.requireCurrent();
        for (const row of page.items) {
          if (!row.key.startsWith(prefix) || seen.has(row.key)) throw new Error('task_content_invalid');
          seen.add(row.key);
          rows.push({ key: row.key, version: row.version, value: (await decodeTodoStoredContent({ key: row.key, encoded: row.value, expectedMode: admitted.mode, encryption: admitted.encryption })).value });
        }
        if (page.items.length < 1000) return rows;
        afterKey = page.items[page.items.length - 1]!.key;
      }
    },
    mutate: async mutations => {
      const admitted = await context();
      const encoded = await Promise.all(mutations.map(async row => ({ key: row.key, version: row.version,
        value: await encodeTodoStoredContent({ key: row.key, mode: admitted.mode, value: row.value,
          encryption: isRawAccountStorageEncryption(admitted.encryption) ? admitted.encryption : null }),
      })));
      args.requireCurrent();
      const result = await kvMutate(args.credentials, encoded, { request: args.request, retry: 'none' });
      if (result.success) return result;
      args.requireCurrent();
      return { success: false, errors: await Promise.all(result.errors.map(async row => ({ key: row.key, version: row.version,
        value: row.value === null ? null : (await decodeTodoStoredContent({ key: row.key, encoded: row.value, expectedMode: admitted.mode, encryption: admitted.encryption })).value,
      }))) };
    },
  };
}
