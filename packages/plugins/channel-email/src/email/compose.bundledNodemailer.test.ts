import { describe, expect, it, vi } from 'vitest';

vi.mock('nodemailer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nodemailer')>();
  return { default: { createTransport: actual.createTransport } };
});

import { composeEmail } from './compose.js';

describe('composeEmail under the bundled nodemailer module shape', () => {
  it('creates MIME mail when CommonJS exports are exposed through default', async () => {
    await expect(composeEmail({
      mailbox: 'sender@example.com',
      recipients: ['recipient@example.com'],
      deliveryKey: 'delivery-1',
      subject: 'Hello',
      content: { text: 'Hello', html: '<p>Hello</p>' },
    })).resolves.toMatchObject({ envelope: { from: 'sender@example.com', to: ['recipient@example.com'] } });
  });
});
