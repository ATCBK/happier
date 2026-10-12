import type { ActionContribution } from '@happier-dev/plugin-sdk/actions';
import { EMAIL_UI_TRANSLATIONS } from './translations.js';

function label(key: keyof typeof EMAIL_UI_TRANSLATIONS.en) {
  return { key, fallback: EMAIL_UI_TRANSLATIONS.en[key] };
}

/** The ordinary Action form owns entry; the Channels page persists setup facts. */
export const EMAIL_SETUP_INPUT_HINTS = {
  title: label('channels.email.setup.title'),
  submitLabel: label('channels.email.setup.submit'),
  fields: [
    { path: 'mailbox', title: label('channels.email.setup.mailbox'), widget: 'text', required: true },
    { path: 'credentialRef', title: label('channels.email.setup.account'), widget: 'select', connectedAccountOptions: true, required: true },
    { path: 'trustStrategy.kind', title: label('channels.email.setup.trust'), widget: 'select', required: true,
      options: [{ value: 'exchangeOrganization', label: label('channels.email.setup.exchange') }, { value: 'authenticationResults', label: 'Authentication-Results' }] },
    { path: 'trustStrategy.authSource', title: label('channels.email.setup.authSource'), widget: 'text',
      visibleWhen: { op: 'eq', path: 'trustStrategy.kind', value: 'exchangeOrganization' },
      requiredWhen: { op: 'eq', path: 'trustStrategy.kind', value: 'exchangeOrganization' } },
    { path: 'trustStrategy.authservId', title: label('channels.email.setup.authservId'), widget: 'text',
      visibleWhen: { op: 'eq', path: 'trustStrategy.kind', value: 'authenticationResults' },
      requiredWhen: { op: 'eq', path: 'trustStrategy.kind', value: 'authenticationResults' } },
    { path: 'allowedDomains', title: label('channels.email.setup.domains'), widget: 'text_list', listSeparator: 'comma' },
    { path: 'quotedHistory', title: label('channels.email.setup.history'), widget: 'select',
      options: [{ value: 'stripKnown', label: label('channels.email.setup.stripKnown') }, { value: 'always', label: label('channels.email.setup.always') }, { value: 'never', label: label('channels.email.setup.never') }] },
    { path: 'stripSignatures', title: label('channels.email.setup.signatures'), widget: 'boolean' },
    { path: 'bodyFormat', title: label('channels.email.setup.bodyFormat'), widget: 'select',
      options: [{ value: 'markdown', label: 'Markdown' }, { value: 'text', label: label('channels.email.setup.text') }] },
  ],
} as const satisfies NonNullable<ActionContribution['inputHints']>;
