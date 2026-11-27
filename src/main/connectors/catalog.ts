import type { ConnectorDefinition } from '../../shared/models'

const EMAIL_MAILBOX_PROPERTY = {
  type: 'string',
  description: 'Mailbox name. Defaults to INBOX.',
  default: 'INBOX',
} as const

const EMAIL_LIMIT_PROPERTY = {
  type: 'integer',
  minimum: 1,
  maximum: 50,
  default: 20,
} as const

const EMAIL_ADDRESS_PROPERTY = {
  oneOf: [
    { type: 'string', format: 'email' },
    { type: 'array', items: { type: 'string', format: 'email' }, minItems: 1, maxItems: 50 },
  ],
} as const

const GITHUB_REPOSITORY_PROPERTIES = {
  owner: { type: 'string', description: 'Repository owner login.' },
  repo: { type: 'string', description: 'Repository name.' },
} as const

const GITHUB_PAGINATION_PROPERTIES = {
  page: { type: 'integer', minimum: 1, maximum: 1_000, default: 1 },
  perPage: { type: 'integer', minimum: 1, maximum: 50 },
  limit: { type: 'integer', minimum: 1, maximum: 50 },
} as const

const GITHUB_STATE_PROPERTY = {
  type: 'string',
  enum: ['open', 'closed', 'all'],
  default: 'open',
} as const

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
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mailbox: EMAIL_MAILBOX_PROPERTY,
          limit: EMAIL_LIMIT_PROPERTY,
        },
      },
    },
    {
      id: 'email.search',
      name: 'Search mail',
      description: 'Search messages by sender, recipient, subject, or text.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search phrase.' },
          mailbox: EMAIL_MAILBOX_PROPERTY,
          limit: EMAIL_LIMIT_PROPERTY,
        },
      },
    },
    {
      id: 'email.read',
      name: 'Read mail',
      description: 'Read one message by its UID, including bounded text content and attachment metadata.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['uid'],
        properties: {
          uid: { type: 'integer', minimum: 1, description: 'Message UID returned by list or search.' },
          mailbox: EMAIL_MAILBOX_PROPERTY,
        },
      },
    },
    {
      id: 'email.send',
      name: 'Send mail',
      description: 'Send a plain-text or HTML email. Sending is queued for approval before execution.',
      risk: 'external-write',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['to', 'subject'],
        anyOf: [{ required: ['text'] }, { required: ['html'] }],
        properties: {
          to: { ...EMAIL_ADDRESS_PROPERTY, description: 'One recipient or up to 50 recipients.' },
          cc: { ...EMAIL_ADDRESS_PROPERTY, description: 'Optional one or more cc recipients.' },
          bcc: { ...EMAIL_ADDRESS_PROPERTY, description: 'Optional one or more bcc recipients.' },
          subject: { type: 'string', description: 'Message subject.' },
          text: { type: 'string', description: 'Plain-text body. Provide text, html, or both.' },
          html: { type: 'string', description: 'HTML body. Provide text, html, or both.' },
        },
      },
    },
  ],
}

const DINGTALK_TARGET_PROPERTIES = {
  conversationId: { type: 'string', description: 'Group conversation openConversationId.' },
  userId: { type: 'string', description: 'Direct-message recipient userId.' },
  openDingTalkId: { type: 'string', description: 'Direct-message recipient openDingTalkId.' },
} as const

const DINGTALK_TARGET_RULE = {
  oneOf: [
    { required: ['conversationId'] },
    { required: ['userId'] },
    { required: ['openDingTalkId'] },
  ],
} as const

export const DINGTALK_CONNECTOR: ConnectorDefinition = {
  kind: 'dingtalk',
  name: 'DingTalk',
  description: 'Connect your DingTalk account to search chats and contacts, read your calendar, tasks, and messages, and send messages directly.',
  icon: 'message-circle',
  hideConnectionName: true,
  configFields: [],
  credentialFields: [],
  capabilities: [
    {
      id: 'dingtalk.contactSearch',
      name: 'Search contacts',
      description: 'Search DingTalk colleagues and contacts by name or keyword.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: { query: { type: 'string', description: 'Name or keyword to search.' } },
      },
    },
    {
      id: 'dingtalk.calendarList',
      name: 'Read calendar',
      description: 'List calendar events for a date range.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start: { type: 'string', description: 'Optional start time, yyyy-MM-dd HH:mm:ss.' },
          end: { type: 'string', description: 'Optional end time, yyyy-MM-dd HH:mm:ss.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
    {
      id: 'dingtalk.todoList',
      name: 'Read tasks',
      description: 'List personal DingTalk tasks.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1, maximum: 10_000, default: 1 },
          size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
    {
      id: 'dingtalk.chatList',
      name: 'List chats',
      description: 'List group conversations joined by the connected DingTalk user.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
        },
      },
    },
    {
      id: 'dingtalk.chatSearch',
      name: 'Search messages',
      description: 'Search DingTalk messages by keyword, conversation, and time range.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Message keyword or phrase.' },
          conversationId: { type: 'string', description: 'Optional group conversation to search.' },
          start: { type: 'string', description: 'Optional start time, yyyy-MM-dd HH:mm:ss.' },
          end: { type: 'string', description: 'Optional end time, yyyy-MM-dd HH:mm:ss.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
    {
      id: 'dingtalk.messageList',
      name: 'Read messages',
      description: 'Read recent messages from one DingTalk conversation.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        ...DINGTALK_TARGET_RULE,
        properties: {
          ...DINGTALK_TARGET_PROPERTIES,
          time: { type: 'string', description: 'Optional cursor time, yyyy-MM-dd HH:mm:ss.' },
          direction: { type: 'string', enum: ['newer', 'older'], default: 'older' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
    },
    {
      id: 'dingtalk.send',
      name: 'Send message',
      description: 'Send a DingTalk message immediately as the connected user.',
      risk: 'external-write',
      requiresApproval: false,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['content'],
        ...DINGTALK_TARGET_RULE,
        properties: {
          ...DINGTALK_TARGET_PROPERTIES,
          content: { type: 'string', description: 'Message body. This is the required content field, not text.' },
          title: { type: 'string', description: 'Optional message title.' },
        },
      },
    },
  ],
}

export const GITHUB_CONNECTOR: ConnectorDefinition = {
  kind: 'github',
  name: 'GitHub',
  description: 'Search repositories, read issues and pull requests, and make approved updates through the GitHub REST API.',
  icon: 'github',
  helpUrl: 'https://github.com/settings/personal-access-tokens/new',
  configFields: [],
  credentialFields: [
    {
      key: 'token',
      label: 'Personal access token',
      type: 'password',
      required: true,
      placeholder: 'github_pat_…',
    },
  ],
  capabilities: [
    {
      id: 'github.searchRepositories',
      name: 'Search repositories',
      description: 'Search repositories visible to the connected GitHub account with page/perPage pagination and optional language enrichment.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'GitHub repository search query.' },
          includeLanguages: { type: 'boolean', default: false },
          ...GITHUB_PAGINATION_PROPERTIES,
        },
      },
    },
    {
      id: 'github.listRepositories',
      name: 'List my repositories',
      description: 'List repositories owned by the connected account, including private and fork repositories, with page/perPage pagination and optional language enrichment.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          includeLanguages: { type: 'boolean', default: false },
          ...GITHUB_PAGINATION_PROPERTIES,
        },
      },
    },
    {
      id: 'github.getRepository',
      name: 'Read a repository',
      description: 'Read one repository with its visibility, fork and archive state, stars, forks, topics, license, and language breakdown.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'repo'],
        properties: {
          ...GITHUB_REPOSITORY_PROPERTIES,
          includeLanguages: { type: 'boolean', default: true },
        },
      },
    },
    {
      id: 'github.searchIssues',
      name: 'Search issues and pull requests',
      description: 'Search issues and pull requests with GitHub search syntax.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'GitHub issues and pull requests search query.' },
          ...GITHUB_PAGINATION_PROPERTIES,
        },
      },
    },
    {
      id: 'github.listIssues',
      name: 'List repository issues',
      description: 'List open, closed, or all issues in one repository.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'repo'],
        properties: {
          ...GITHUB_REPOSITORY_PROPERTIES,
          state: GITHUB_STATE_PROPERTY,
          ...GITHUB_PAGINATION_PROPERTIES,
        },
      },
    },
    {
      id: 'github.getIssue',
      name: 'Read an issue',
      description: 'Read one issue with its bounded body text.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'repo', 'number'],
        properties: {
          ...GITHUB_REPOSITORY_PROPERTIES,
          number: { type: 'integer', minimum: 1, description: 'Issue number.' },
        },
      },
    },
    {
      id: 'github.listPullRequests',
      name: 'List pull requests',
      description: 'List open, closed, or all pull requests in one repository.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'repo'],
        properties: {
          ...GITHUB_REPOSITORY_PROPERTIES,
          state: GITHUB_STATE_PROPERTY,
          ...GITHUB_PAGINATION_PROPERTIES,
        },
      },
    },
    {
      id: 'github.getPullRequest',
      name: 'Read a pull request',
      description: 'Read one pull request with its branches, summary, and change counts.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'repo', 'number'],
        properties: {
          ...GITHUB_REPOSITORY_PROPERTIES,
          number: { type: 'integer', minimum: 1, description: 'Pull request number.' },
        },
      },
    },
    {
      id: 'github.createIssue',
      name: 'Create an issue',
      description: 'Create a GitHub issue after approval.',
      risk: 'external-write',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'repo', 'title'],
        properties: {
          ...GITHUB_REPOSITORY_PROPERTIES,
          title: { type: 'string', description: 'Issue title.' },
          body: { type: 'string', description: 'Optional issue body.' },
          labels: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        },
      },
    },
    {
      id: 'github.comment',
      name: 'Comment on an issue or pull request',
      description: 'Add a comment to an issue or pull request after approval.',
      risk: 'external-write',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['owner', 'repo', 'number', 'body'],
        properties: {
          ...GITHUB_REPOSITORY_PROPERTIES,
          number: { type: 'integer', minimum: 1, description: 'Issue or pull request number.' },
          body: { type: 'string', description: 'Comment body.' },
        },
      },
    },
  ],
}

export const BUILT_IN_CONNECTORS: readonly ConnectorDefinition[] = [
  EMAIL_CONNECTOR,
  GITHUB_CONNECTOR,
  DINGTALK_CONNECTOR,
]

export function builtinConnectorDefinitions(): Map<string, ConnectorDefinition> {
  return new Map(BUILT_IN_CONNECTORS.map((definition) => [definition.kind, definition]))
}
