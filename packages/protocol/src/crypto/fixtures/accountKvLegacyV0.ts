// Synthetic vectors of ../0.2 at 077db90d049ee283ef99196c45c6074a3160c91d:
// UI sync/domains/todos/todoOps.ts field shapes and encryption/libsodium.ts
// encryptSecretBox: nonce(24) || secretbox(JSON.stringify(value), nonce, secret).
// Public test secret: 32 bytes of 7. Item nonce is all zero (also a valid AES
// version byte); index nonce is all 233. No real Account data or key is used.
export const legacyAccountKvVectors = [
  {
    key: 'todo.fx51-legacy',
    value: { id: 'fx51-legacy', title: 'QA FX51 synthetic legacy task', done: false,
      createdAt: 1700000000000, updatedAt: 1700000000010,
      linkedSessions: { 'synthetic-session': { title: 'QA FX51 synthetic Session', linkedAt: 1700000000010 } } },
    encoded: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATBJR3rT1LS2gE7Ls0RJLgrhCppnpcLkUCjWoD5VQb0nQQ6xUySbaB58MXQHQuOJYDlZBFjnOfdX0qJGDdmeHR+dYS8sCdx++OLq2iWbfOmTatGTr/8ld04PkTu4NZ2fX6yfBNtZgB2KwPwRlE9sSD8W/pp4W7ei97ot2mJCTt55KG1a+AUfGU/8NRVFFQbhOSF/D2EIV5Gyumip9irc3/GbftBBrGCr11MDrabbBoxqZbhxvcUNcu5PA2MUZqj/vGFE6eYjv8Y7EI3oeygDWkXRBVXWhpDw/ANuOGnilxQIBOleOKoAauNVDLSICo6NFLSUJ',
  },
  {
    key: 'todo.index', value: { undoneOrder: ['fx51-legacy'], completedOrder: [] },
    encoded: '6enp6enp6enp6enp6enp6enp6enp6enp+TWx/8Z2OnpOEOZAv1u928oBJ8lj6SgvnAoblMld1FR64Qrxx7eXeA5irqQuZHgMWi9384V0LRxGYob0BgTopwPzGQ==',
  },
] as const;
