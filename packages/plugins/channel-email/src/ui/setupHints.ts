import type { ActionContribution } from '@happier-dev/plugin-sdk/actions';
import { EMAIL_UI_TRANSLATIONS } from './translations.js';

function label(key: keyof typeof EMAIL_UI_TRANSLATIONS.en) {
  return { key, fallback: EMAIL_UI_TRANSLATIONS.en[key] };
}

/** The ordinary Action form owns entry; the Channels page persists setup facts. */
export const EMAIL_SETUP_INPUT_HINTS = {
  title: label('channels.email.setup.title'),
  description: label('channels.email.setup.description'),
  submitLabel: label('channels.email.setup.submit'),
  fields: [
    { path: 'mailbox', title: label('channels.email.setup.mailbox'), placeholder: 'team@example.com', widget: 'text', required: true },
    { path: 'credentialRef', title: label('channels.email.setup.account'), description: label('channels.email.setup.accountDescription'),
      widget: 'select', connectedAccountOptions: true, required: true },
    { path: 'trustStrategy.kind', title: label('channels.email.setup.trust'), description: label('channels.email.setup.trustDescription'), widget: 'select', required: true,
      options: [
        { value: 'exchangeOrganization', label: label('channels.email.setup.exchange'), description: label('channels.email.setup.exchangeDescription') },
        { value: 'authenticationResults', label: 'Authentication-Results', description: label('channels.email.setup.authResultsDescription') },
      ] },
    { path: 'trustStrategy.authSource', title: label('channels.email.setup.authSource'), widget: 'text',
      visibleWhen: { op: 'eq', path: 'trustStrategy.kind', value: 'exchangeOrganization' },
      requiredWhen: { op: 'eq', path: 'trustStrategy.kind', value: 'exchangeOrganization' } },
    { path: 'trustStrategy.authservId', title: label('channels.email.setup.authservId'), widget: 'text',
      visibleWhen: { op: 'eq', path: 'trustStrategy.kind', value: 'authenticationResults' },
      requiredWhen: { op: 'eq', path: 'trustStrategy.kind', value: 'authenticationResults' } },
    { path: 'allowedDomains', title: label('channels.email.setup.domains'), description: label('channels.email.setup.domainsDescription'),
      placeholder: 'example.com', widget: 'text_list', listSeparator: 'comma' },
    { path: 'quotedHistory', title: label('channels.email.setup.history'), description: label('channels.email.setup.historyDescription'), widget: 'select',
      options: [{ value: 'stripKnown', label: label('channels.email.setup.stripKnown') }, { value: 'always', label: label('channels.email.setup.always') }, { value: 'never', label: label('channels.email.setup.never') }] },
    { path: 'stripSignatures', title: label('channels.email.setup.signatures'), widget: 'boolean', defaultValue: true },
    { path: 'bodyFormat', title: label('channels.email.setup.bodyFormat'), description: label('channels.email.setup.bodyFormatDescription'), widget: 'select',
      options: [{ value: 'markdown', label: 'Markdown' }, { value: 'text', label: label('channels.email.setup.text') }] },
  ],
} as const satisfies NonNullable<ActionContribution['inputHints']>;
