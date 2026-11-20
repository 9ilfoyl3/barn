import type { ConnectorDefinition } from '../../shared/models'

export const EMAIL_CONNECTOR: ConnectorDefinition = {
  kind: 'email',
  name: 'Email',
  description: 'Read recent mail, search the mailbox, open messages, and send mail through IMAP and SMTP.',
  icon: 'mail',
  configFields: [
    { key: 'emailAddress', label: 'Email address', type: 'text', required: true, placeholder: 'name@example.com' },
    { key: 'imapHost', label: 'IMAP server', type: 'text', required: true, placeholder: 'imap.example.com' },
    { key: 'imapPort', label: 'IMAP port', type: 'number', required: true, defaultValue: 993 },
    { key: 'imapSecure', label: 'Use TLS for IMAP', type: 'boolean', required: false, defaultValue: true },
    { key: 'smtpHost', label: 'SMTP server', type: 'text', required: true, placeholder: 'smtp.example.com' },
    { key: 'smtpPort', label: 'SMTP port', type: 'number', required: true, defaultValue: 465 },
    { key: 'smtpSecure', label: 'Use TLS for SMTP', type: 'boolean', required: false, defaultValue: true },
    { key: 'fromName', label: 'Sender name', type: 'text', required: false },
  ],
  credentialFields: [
    { key: 'username', label: 'Username', type: 'text', required: true },
    { key: 'password', label: 'Password or app password', type: 'password', required: true },
  ],
  capabilities: [
    {
      id: 'email.list',
      name: 'List recent mail',
      description: 'List recent messages in the inbox without opening their full content.',
      risk: 'read',
    },
    {
      id: 'email.search',
      name: 'Search mail',
      description: 'Search messages by sender, recipient, subject, or text.',
      risk: 'read',
    },
    {
      id: 'email.read',
      name: 'Read mail',
      description: 'Read one message by its UID, including bounded text content and attachment metadata.',
      risk: 'read',
    },
    {
      id: 'email.send',
      name: 'Send mail',
      description: 'Send a plain-text or HTML email. Sending is queued for approval before execution.',
      risk: 'external-write',
    },
  ],
}

export const BUILT_IN_CONNECTORS: readonly ConnectorDefinition[] = [EMAIL_CONNECTOR]

export function builtinConnectorDefinitions(): Map<string, ConnectorDefinition> {
  return new Map(BUILT_IN_CONNECTORS.map((definition) => [definition.kind, definition]))
}
