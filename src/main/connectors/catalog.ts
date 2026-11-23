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
    },
    {
      id: 'dingtalk.calendarList',
      name: 'Read calendar',
      description: 'List calendar events for a date range.',
      risk: 'read',
    },
    {
      id: 'dingtalk.todoList',
      name: 'Read tasks',
      description: 'List personal DingTalk tasks.',
      risk: 'read',
    },
    {
      id: 'dingtalk.chatSearch',
      name: 'Search messages',
      description: 'Search DingTalk messages by keyword, conversation, and time range.',
      risk: 'read',
    },
    {
      id: 'dingtalk.messageList',
      name: 'Read messages',
      description: 'Read recent messages from one DingTalk conversation.',
      risk: 'read',
    },
    {
      id: 'dingtalk.send',
      name: 'Send message',
      description: 'Send a DingTalk message immediately as the connected user.',
      risk: 'external-write',
      requiresApproval: false,
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
    },
    {
      id: 'github.listRepositories',
      name: 'List my repositories',
      description: 'List repositories owned by the connected account, including private and fork repositories, with page/perPage pagination and optional language enrichment.',
      risk: 'read',
    },
    {
      id: 'github.getRepository',
      name: 'Read a repository',
      description: 'Read one repository with its visibility, fork and archive state, stars, forks, topics, license, and language breakdown.',
      risk: 'read',
    },
    {
      id: 'github.searchIssues',
      name: 'Search issues and pull requests',
      description: 'Search issues and pull requests with GitHub search syntax.',
      risk: 'read',
    },
    {
      id: 'github.listIssues',
      name: 'List repository issues',
      description: 'List open, closed, or all issues in one repository.',
      risk: 'read',
    },
    {
      id: 'github.getIssue',
      name: 'Read an issue',
      description: 'Read one issue with its bounded body text.',
      risk: 'read',
    },
    {
      id: 'github.listPullRequests',
      name: 'List pull requests',
      description: 'List open, closed, or all pull requests in one repository.',
      risk: 'read',
    },
    {
      id: 'github.getPullRequest',
      name: 'Read a pull request',
      description: 'Read one pull request with its branches, summary, and change counts.',
      risk: 'read',
    },
    {
      id: 'github.createIssue',
      name: 'Create an issue',
      description: 'Create a GitHub issue after approval.',
      risk: 'external-write',
    },
    {
      id: 'github.comment',
      name: 'Comment on an issue or pull request',
      description: 'Add a comment to an issue or pull request after approval.',
      risk: 'external-write',
    },
  ],
}

export const WECOM_MAIL_CONNECTOR: ConnectorDefinition = {
  kind: 'wecomMail',
  name: 'WeCom Mail',
  description: 'Search, read, and send WeCom Mail through the official WeCom MCP endpoint.',
  icon: 'mail',
  helpUrl: 'https://developer.work.weixin.qq.com/document/path/101805',
  hideConnectionName: true,
  configFields: [],
  credentialFields: [
    {
      key: 'apiKeyOrUrl',
      label: 'API key (or full endpoint URL)',
      type: 'password',
      required: true,
      placeholder: 'Paste an API key or https://qyapi.weixin.qq.com/mcp/robot-mail?apikey=...',
    },
  ],
  capabilities: [
    {
      id: 'wecomMail.search',
      name: 'Search WeCom Mail',
      description: 'Search the mailbox and list messages by sender, recipient, time, folder, or labels.',
      risk: 'read',
    },
    {
      id: 'wecomMail.get',
      name: 'Read WeCom Mail',
      description: 'Read one WeCom Mail message by its encoded mail id.',
      risk: 'read',
    },
    {
      id: 'wecomMail.send',
      name: 'Send WeCom Mail',
      description: 'Send, reply to, or forward WeCom Mail. Sending is queued for approval first.',
      risk: 'external-write',
    },
  ],
}

export const BUILT_IN_CONNECTORS: readonly ConnectorDefinition[] = [
  EMAIL_CONNECTOR,
  GITHUB_CONNECTOR,
  DINGTALK_CONNECTOR,
  WECOM_MAIL_CONNECTOR,
]

export function builtinConnectorDefinitions(): Map<string, ConnectorDefinition> {
  return new Map(BUILT_IN_CONNECTORS.map((definition) => [definition.kind, definition]))
}
