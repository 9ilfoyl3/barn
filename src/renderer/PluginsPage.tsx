import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleX,
  Info,
  LoaderCircle,
  Mail,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type {
  ConnectorCapabilityDefinition,
  ConnectorConfig,
  ConnectorConfigValue,
  ConnectorDefinition,
  ConnectorInstance,
  ConnectorSetupField,
  ConnectorTestResult,
  DingTalkRuntimeStatus,
  SkillSummary,
} from '../shared/models'
import { SkillsPanel } from './SkillsPanel'
import { Input } from './components/Input'
import { Input as BeuiInput } from './components/beui/components/motion/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/beui/components/motion/tabs'
import { notifyError, notifySuccess, useErrorToast } from './notifications'
import './plugins-page.css'
import { Button } from './components/Button'

type PluginsTab = 'plugins' | 'skills'
type ConnectorCategory = 'integrations' | 'china'

interface EditorState {
  definition: ConnectorDefinition
  instance?: ConnectorInstance | undefined
}

const CATEGORY_ORDER: readonly ConnectorCategory[] = ['integrations', 'china']

const DINGTALK_CAPABILITY_COPY = {
  'dingtalk.contactSearch': {
    en: { name: 'Search contacts', description: 'Search DingTalk colleagues and contacts by name or keyword.' },
    zh: { name: '搜索联系人', description: '按姓名或关键词搜索钉钉同事和联系人。' },
  },
  'dingtalk.calendarList': {
    en: { name: 'Read calendar', description: 'List calendar events for a date range.' },
    zh: { name: '读取日历', description: '按时间范围列出钉钉日历日程。' },
  },
  'dingtalk.todoList': {
    en: { name: 'Read tasks', description: 'List personal DingTalk tasks.' },
    zh: { name: '读取待办', description: '列出当前账号的钉钉待办。' },
  },
  'dingtalk.chatSearch': {
    en: { name: 'Search messages', description: 'Search DingTalk messages by keyword, conversation, and time range.' },
    zh: { name: '搜索消息', description: '按关键词、会话和时间范围搜索钉钉消息。' },
  },
  'dingtalk.messageList': {
    en: { name: 'Read messages', description: 'Read recent messages from one DingTalk conversation.' },
    zh: { name: '读取消息', description: '读取指定钉钉会话中的最近消息。' },
  },
  'dingtalk.send': {
    en: { name: 'Send message', description: 'Send a DingTalk message immediately as the connected user.' },
    zh: { name: '发送消息', description: '以当前登录用户身份直接发送钉钉消息。' },
  },
} as const

const DIRECT_WRITE_LABEL = {
  en: 'Direct send',
  zh: '直接发送',
} as const

const DINGTALK_SETUP_COPY = {
  en: {
    title: 'Connect DingTalk',
    intro: 'Barn installs a small local connector so the Agent can work with your DingTalk account. Installation is confirmed here and your sign-in happens in the browser.',
    install: 'Install',
    installing: 'Installing…',
    signIn: 'Sign in to DingTalk',
    signingIn: 'Waiting for sign-in…',
    installed: 'Installation complete',
    installedDescription: 'Sign in with your browser to let Barn access DingTalk with your account permissions.',
    connected: 'DingTalk connected',
    connectedDescription: 'Your DingTalk account is ready. Messages send directly as the signed-in user.',
    connectedAs: 'Connected as',
    reconnect: 'Sign in again',
    done: 'Done',
    checking: 'Checking DingTalk…',
  },
  zh: {
    title: '连接钉钉',
    intro: 'Barn 会在本机安装一个小型连接组件，让 Agent 可以使用你的钉钉账号。安装会在这里确认，登录将在浏览器中完成。',
    install: '确认安装',
    installing: '正在安装…',
    signIn: '登录钉钉',
    signingIn: '等待登录完成…',
    installed: '安装完成',
    installedDescription: '请在浏览器中登录，并授权 Barn 使用你的钉钉账号。',
    connected: '钉钉已连接',
    connectedDescription: '你的钉钉账号已就绪。消息会直接以当前登录账号发送。',
    connectedAs: '当前账号',
    reconnect: '重新登录',
    done: '完成',
    checking: '正在检查钉钉连接…',
  },
} as const

export function PluginsPage({ onTrySkill }: { onTrySkill?: (skill: SkillSummary) => void }) {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState<PluginsTab>('plugins')
  const [query, setQuery] = useState('')
  const [definitions, setDefinitions] = useState<ConnectorDefinition[]>([])
  const [instances, setInstances] = useState<ConnectorInstance[]>([])
  const [selectedKind, setSelectedKind] = useState<string>()
  const [editor, setEditor] = useState<EditorState>()
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string>()
  const [error, setError] = useState<string>()
  const [testResults, setTestResults] = useState<Record<string, ConnectorTestResult>>({})

  useErrorToast(error)

  useEffect(() => {
    void reload()
  }, [])

  const selectedDefinition = definitions.find((definition) => definition.kind === selectedKind)
  const selectedInstances = selectedDefinition === undefined
    ? []
    : instances.filter((instance) => instance.kind === selectedDefinition.kind)
  const normalizedQuery = query.trim().toLocaleLowerCase()

  const filteredDefinitions = useMemo(() => definitions.filter((definition) => {
    if (normalizedQuery.length === 0) return true
    const name = translatedDefinitionName(definition, t)
    return `${name} ${definition.name} ${definition.description} ${definition.capabilities.map((capability) => capability.id).join(' ')}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  }), [definitions, normalizedQuery, t])

  const groupedDefinitions = useMemo(() => Object.fromEntries(
    CATEGORY_ORDER.map((category) => [
      category,
      filteredDefinitions.filter((definition) => connectorCategory(definition.kind) === category),
    ]),
  ) as Record<ConnectorCategory, ConnectorDefinition[]>, [filteredDefinitions])

  async function reload(): Promise<void> {
    try {
      const [nextDefinitions, nextInstances] = await Promise.all([
        window.barn.connectors.listDefinitions(),
        window.barn.connectors.list(),
      ])
      setDefinitions(nextDefinitions)
      setInstances(nextInstances)
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  async function toggle(connector: ConnectorInstance): Promise<void> {
    setBusyId(connector.id)
    setError(undefined)
    try {
      await window.barn.connectors.update(connector.id, { enabled: !connector.enabled })
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  async function remove(connector: ConnectorInstance): Promise<void> {
    if (!window.confirm(t('connectorSettings.removeConfirm', { name: connector.name }))) return
    setBusyId(connector.id)
    setError(undefined)
    try {
      await window.barn.connectors.remove(connector.id)
      if (connector.kind === 'dingtalk') await window.barn.dingtalk.logout().catch(() => undefined)
      setTestResults((current) => {
        const next = { ...current }
        delete next[connector.id]
        return next
      })
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  async function test(connector: ConnectorInstance): Promise<void> {
    setBusyId(connector.id)
    setError(undefined)
    try {
      const result = await window.barn.connectors.test(connector.id)
      setTestResults((current) => ({ ...current, [connector.id]: result }))
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  function openDefinition(definition: ConnectorDefinition, startCreating = false): void {
    setSelectedKind(definition.kind)
    setEditor(startCreating ? { definition } : undefined)
    setError(undefined)
  }

  function openEdit(connector: ConnectorInstance): void {
    const definition = definitions.find((entry) => entry.kind === connector.kind)
    if (definition === undefined) {
      setError(t('connectorSettings.unknownDefinition', { kind: connector.kind }))
      return
    }
    setSelectedKind(definition.kind)
    setEditor({ definition, instance: connector })
  }

  async function saveEditor(input: {
    name: string
    config: ConnectorConfig
    credentials: Record<string, string>
  }): Promise<void> {
    if (editor === undefined) return
    setBusyId(editor.instance?.id ?? 'new')
    setError(undefined)
    try {
      const connector = editor.instance === undefined
        ? await window.barn.connectors.create({
            kind: editor.definition.kind,
            name: input.name,
            config: input.config,
          })
        : await window.barn.connectors.update(editor.instance.id, {
            name: input.name,
            config: input.config,
          })
      if (Object.keys(input.credentials).length > 0) {
        await window.barn.connectors.saveCredentials({
          connectorId: connector.id,
          values: input.credentials,
        })
      }
      setSelectedKind(editor.definition.kind)
      setEditor(undefined)
      notifySuccess(t('connectorSettings.saved', { name: connector.name }))
      await reload()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusyId(undefined)
    }
  }

  const catalog = (
    <div className="plugins-catalog">
      <h1 className="visually-hidden">{t('plugins.title')}</h1>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as typeof tab)
          setQuery('')
        }}
        variant="underline"
      >
        <header className="plugins-heading">
          <TabsList className="plugins-tabs" aria-label={t('plugins.title')}>
            <TabsTrigger className="plugins-tab" value="plugins">{t('plugins.title')}</TabsTrigger>
            <TabsTrigger className="plugins-tab" value="skills">{t('plugins.skills')}</TabsTrigger>
          </TabsList>
        </header>

        <BeuiInput
          className="plugins-search"
          leftIcon={<Search size={17} aria-hidden="true" />}
          aria-label={tab === 'skills' ? t('plugins.searchSkills') : t('plugins.search')}
          onChange={setQuery}
          placeholder={tab === 'skills' ? t('plugins.searchSkillsPlaceholder') : t('plugins.searchPlaceholder')}
          type="search"
          value={query}
          rightIcon={query.length > 0 ? (
            <Button type="button" aria-label={t('plugins.clearSearch')} onClick={() => setQuery('')}>
              <X size={14} />
            </Button>
          ) : undefined}
        />

        <TabsContent className="plugins-tab-panel" value="skills">
          <SkillsPanel query={query} {...(onTrySkill === undefined ? {} : { onTrySkill })} />
        </TabsContent>

        <TabsContent className="plugins-tab-panel" value="plugins">
          {loading ? (
            <div className="plugins-loading" role="status">
              <LoaderCircle className="spin" size={18} aria-hidden="true" />
              <span>{t('common.loading')}</span>
            </div>
          ) : (
            <div className="plugins-sections">
              {normalizedQuery.length === 0 && (
                <section className="plugins-section" aria-labelledby="plugins-mcp-title">
                  <div className="plugins-section-header">
                    <h2 id="plugins-mcp-title">{t('plugins.mcpServers')}</h2>
                    <Button
                      className="plugins-section-link"
                      disabled
                      title={t('plugins.comingSoon')}
                      type="button"
                    >
                      {t('plugins.addMcp')}
                    </Button>
                  </div>
                </section>
              )}

              {CATEGORY_ORDER.map((category) => {
                const categoryDefinitions = groupedDefinitions[category]
                if (categoryDefinitions.length === 0) return null
                return (
                  <PluginSection
                    definitions={categoryDefinitions}
                    instances={instances}
                    key={category}
                    onOpen={openDefinition}
                    title={t(`plugins.categories.${category}`)}
                  />
                )
              })}

              {filteredDefinitions.length === 0 && (
                <div className="plugins-no-results" role="status">
                  <Search size={20} aria-hidden="true" />
                  <span>{t('plugins.noResults')}</span>
                </div>
              )}

              <p className="plugins-safety-note">{t('plugins.safetyNote')}</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )

  const detail = selectedDefinition === undefined ? undefined : (
    <div className="plugins-detail">
      <header className="plugins-detail-header">
        <Button
          aria-label={t('plugins.back')}
          className="plugins-back"
          onClick={() => {
            setSelectedKind(undefined)
            setEditor(undefined)
            setError(undefined)
          }}
          title={t('plugins.back')}
          type="button"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <div className="plugins-detail-title">
          <ConnectorIcon definition={selectedDefinition} size="large" />
          <div>
            <span>{t('plugins.title')} / {t(`plugins.categories.${connectorCategory(selectedDefinition.kind)}`)}</span>
            <h1>{translatedDefinitionName(selectedDefinition, t)}</h1>
          </div>
        </div>
      </header>

      <p className="plugins-detail-description">
        {t(`connectorSettings.kinds.${selectedDefinition.kind}.description`, {
          defaultValue: selectedDefinition.description,
        })}
      </p>

      <section className="plugins-detail-section" aria-labelledby="plugin-connections-title">
        <div className="plugins-detail-section-header">
          <div>
            <h2 id="plugin-connections-title">{t('plugins.connections')}</h2>
            <p>{t('plugins.connectionsDescription')}</p>
          </div>
          {editor === undefined && (
            <Button
              size="sm"
              type="button"
              variant="primary"
              onClick={() => setEditor({ definition: selectedDefinition })}
            >
              <Plus size={14} aria-hidden="true" />
              {t('plugins.addConnection')}
            </Button>
          )}
        </div>

        {selectedInstances.length === 0 ? (
          editor === undefined && (
            <div className="plugins-detail-empty">
              <Plug size={18} aria-hidden="true" />
              <span>{t('plugins.noConnections')}</span>
            </div>
          )
        ) : (
          <div className="plugins-instance-list">
            {selectedInstances.map((connector) => (
              <ConnectorInstanceRow
                busy={busyId === connector.id}
                connector={connector}
                key={connector.id}
                testResult={testResults[connector.id]}
                onEdit={() => openEdit(connector)}
                onRemove={() => void remove(connector)}
                onTest={() => void test(connector)}
                onToggle={() => void toggle(connector)}
              />
            ))}
          </div>
        )}

        {editor !== undefined && (
          <ConnectorEditor
            busy={busyId === (editor.instance?.id ?? 'new')}
            definition={editor.definition}
            instance={editor.instance}
            key={`${editor.definition.kind}:${editor.instance?.id ?? 'new'}`}
            onCancel={() => setEditor(undefined)}
            onSave={(input) => void saveEditor(input)}
          />
        )}
      </section>

      <section className="plugins-detail-section" aria-labelledby="plugin-capabilities-title">
        <div className="plugins-detail-section-header">
          <div>
            <h2 id="plugin-capabilities-title">{t('plugins.capabilities')}</h2>
            <p>{t('plugins.capabilitiesDescription')}</p>
          </div>
        </div>
        <ul className="plugins-capabilities">
          {selectedDefinition.capabilities.map((capability) => (
            <li key={capability.id}>
              <span className={`plugins-risk plugins-risk-${capability.risk}`}>
                {capability.risk === 'external-write'
                  ? capability.requiresApproval === false
                    ? DIRECT_WRITE_LABEL[i18n.language === 'zh-CN' ? 'zh' : 'en']
                    : t('plugins.approvalRequired')
                  : t('plugins.readOnly')}
              </span>
              <span>
                <strong>
                  {t(`connectorSettings.capabilities.${capabilityTranslationKey(capability.id)}`, {
                    defaultValue: capability.name,
                  })}
                </strong>
                <small>{capabilityDescription(capability, t, i18n.language)}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )

  return (
    <section className="plugins-page" aria-label={t('plugins.title')} data-testid="plugins-page">
      <div className="plugins-scroll">
        <div className="plugins-inner">
          {selectedDefinition === undefined ? catalog : detail}
        </div>
      </div>
    </section>
  )
}

function PluginSection({
  title,
  definitions,
  instances,
  onOpen,
}: {
  title: string
  definitions: ConnectorDefinition[]
  instances: ConnectorInstance[]
  onOpen(definition: ConnectorDefinition, startCreating?: boolean): void
}) {
  const { t } = useTranslation()
  return (
    <section className="plugins-section" aria-label={title}>
      <div className="plugins-section-header">
        <h2>{title}</h2>
      </div>
      <div className="plugins-list">
        {definitions.map((definition) => {
          const connectors = instances.filter((instance) => instance.kind === definition.kind)
          const status = aggregateStatus(connectors)
          return (
            <article className="plugin-row" data-plugin-kind={definition.kind} key={definition.kind}>
              <div className="plugin-row-main">
                <ConnectorIcon definition={definition} size="large" />
                <span className="plugin-row-copy">
                  <span className="plugin-row-title">
                    <strong>{translatedDefinitionName(definition, t)}</strong>
                    {connectors.length > 0 && status !== undefined && (
                      <ConnectorStatusIndicator label={t(`connectorSettings.status.${status}`)} status={status} />
                    )}
                  </span>
                  <small>
                    {connectors.length > 0
                      ? t('plugins.connectionCount', { count: connectors.length })
                      : t(`connectorSettings.kinds.${definition.kind}.description`, {
                          defaultValue: definition.description,
                        })}
                  </small>
                </span>
              </div>
              <Button
                aria-label={connectors.length > 0
                  ? t('plugins.manageNamed', { name: translatedDefinitionName(definition, t) })
                  : t('plugins.addNamed', { name: translatedDefinitionName(definition, t) })}
                className="plugin-row-action"
                onClick={() => onOpen(definition, connectors.length === 0)}
                type="button"
              >
                {connectors.length > 0 ? t('plugins.manage') : t('plugins.add')}
              </Button>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function ConnectorInstanceRow({
  connector,
  busy,
  testResult,
  onEdit,
  onToggle,
  onTest,
  onRemove,
}: {
  connector: ConnectorInstance
  busy: boolean
  testResult?: ConnectorTestResult | undefined
  onEdit(): void
  onToggle(): void
  onTest(): void
  onRemove(): void
}) {
  const { t, i18n } = useTranslation()
  return (
    <article className={`plugin-instance-row plugin-instance-row-${connector.status}`} data-connector-id={connector.id}>
      <span
        className="plugin-instance-mark"
        aria-label={t(`connectorSettings.status.${connector.status}`)}
        role="img"
        title={t(`connectorSettings.status.${connector.status}`)}
      >
        <ConnectorStatusGlyph size={15} status={connector.status} />
      </span>
      <div className="plugin-instance-copy">
        <div className="plugin-instance-title">
          <strong>{connector.name}</strong>
        </div>
        <p>{connector.capabilities.map((capability) => capabilityName(capability, t, i18n.language)).join(' · ')}</p>
        {connector.lastError !== undefined && <small className="plugins-row-error">{connector.lastError}</small>}
        {testResult !== undefined && (
          <small className={testResult.ok ? 'plugins-row-success' : 'plugins-row-error'}>
            {testResult.message}
          </small>
        )}
      </div>
      <div className="plugin-instance-actions">
        <Button
          size="sm"
          type="button"
          disabled={busy}
          state={busy ? 'loading' : 'idle'}
          loadingText={t('connectorSettings.test')}
          variant="secondary"
          onClick={onTest}
        >
          <RefreshCw size={13} aria-hidden="true" />
          {t('connectorSettings.test')}
        </Button>
        <Button
          size="sm"
          type="button"
          disabled={busy}
          variant="secondary"
          onClick={onEdit}
        >
          {t('connectorSettings.configure')}
        </Button>
        <label className="plugin-switch" title={t('connectorSettings.enabled')}>
          <input type="checkbox" checked={connector.enabled} disabled={busy} onChange={onToggle} />
          <span />
        </label>
        <Button
          className="plugin-icon-button danger"
          type="button"
          aria-label={t('connectorSettings.remove')}
          disabled={busy}
          onClick={onRemove}
        >
          <Trash2 size={14} aria-hidden="true" />
        </Button>
      </div>
    </article>
  )
}

function ConnectorStatusGlyph({
  status,
  size = 12,
}: {
  status: ConnectorInstance['status']
  size?: number
}) {
  const Icon = status === 'ready'
    ? CircleCheck
    : status === 'error'
      ? CircleX
      : status === 'needs_setup'
        ? CircleAlert
        : CirclePause
  return <Icon aria-hidden="true" data-status-icon={status} size={size} />
}

function ConnectorStatusIndicator({
  status,
  label,
}: {
  status: ConnectorInstance['status']
  label: string
}) {
  return (
    <span
      aria-label={label}
      className={`connector-status connector-status-${status}`}
      data-connector-status={status}
      role="img"
      title={label}
    >
      <ConnectorStatusGlyph size={16} status={status} />
    </span>
  )
}

function ConnectorEditor({
  definition,
  instance,
  busy,
  onCancel,
  onSave,
}: {
  definition: ConnectorDefinition
  instance?: ConnectorInstance | undefined
  busy: boolean
  onCancel(): void
  onSave(input: { name: string; config: ConnectorConfig; credentials: Record<string, string> }): void
}) {
  const { t, i18n } = useTranslation()
  const [name, setName] = useState(instance?.name ?? translatedDefinitionName(definition, t))
  const [config, setConfig] = useState<ConnectorConfig>(() => initialConfigFor(definition, instance))
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const translated = t as (key: string, options?: { defaultValue?: string }) => string
  const setupNote = translated(`connectorSettings.kinds.${definition.kind}.note`, { defaultValue: '' })

  if (definition.kind === 'dingtalk') {
    return (
      <DingTalkSetup
        instance={instance}
        language={i18n.language}
        onCancel={onCancel}
        onComplete={() => onSave({
          name: translatedDefinitionName(definition, t),
          config: {},
          credentials: {},
        })}
      />
    )
  }

  function setConfigValue(field: ConnectorSetupField, value: ConnectorConfigValue): void {
    setConfig((current) => ({ ...current, [field.key]: value }))
  }

  function setCredential(field: ConnectorSetupField, value: string): void {
    setCredentials((current) => ({ ...current, [field.key]: value }))
  }

  return (
    <form
      className="plugin-editor"
      onSubmit={(event) => {
        event.preventDefault()
        onSave({ name, config, credentials })
      }}
    >
      <div className="plugin-editor-header">
        <div>
          <span>{instance === undefined ? t('connectorSettings.addTitle') : t('connectorSettings.editTitle')}</span>
          <h3>{translatedDefinitionName(definition, t)}</h3>
        </div>
      </div>

      {setupNote.length > 0 && (
        <div className="plugin-editor-note">
          <Info size={14} aria-hidden="true" />
          <p>{setupNote}</p>
        </div>
      )}

      {!definition.hideConnectionName && (
        <label>
          <span>{t('connectorSettings.name')}</span>
          <Input value={name} required maxLength={200} onChange={(event) => setName(event.target.value)} density="compact" />
        </label>
      )}

      <div className="plugin-editor-grid">
        {definition.configFields.map((field) => (
          <label key={field.key} className={field.type === 'boolean' ? 'plugin-check-row' : undefined}>
            {field.type === 'boolean' ? (
              <>
                <input
                  type="checkbox"
                  checked={config[field.key] === true}
                  onChange={(event) => setConfigValue(field, event.target.checked)}
                />
                <span>{fieldLabel(field, t)}</span>
              </>
            ) : (
              <>
                <span>{fieldLabel(field, t)}{field.required ? ' *' : ''}</span>
                <Input
                  type={field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}
                  required={field.required}
                  value={String(config[field.key] ?? '')}
                  placeholder={translated(`connectorSettings.fieldPlaceholders.${field.key}`, { defaultValue: field.placeholder ?? '' })}
                  onChange={(event) => setConfigValue(
                    field,
                    field.type === 'number' ? Number(event.target.value) : event.target.value,
                  )}
                  density="compact"
                />
              </>
            )}
          </label>
        ))}
      </div>

      <div className="plugin-editor-credentials">
        <div>
          <h4>{t('connectorSettings.credentialsTitle')}</h4>
          <p>{instance === undefined ? t('connectorSettings.credentialsNew') : t('connectorSettings.credentialsExisting')}</p>
        </div>
        <div className="plugin-editor-grid">
          {definition.credentialFields.map((field) => (
            <label key={field.key}>
              <span>{fieldLabel(field, t)}{field.required && instance === undefined ? ' *' : ''}</span>
              <Input
                type={field.type === 'password' ? 'password' : 'text'}
                required={field.required && instance === undefined}
                value={credentials[field.key] ?? ''}
                placeholder={instance === undefined
                  ? translated(`connectorSettings.fieldPlaceholders.${field.key}`, { defaultValue: field.placeholder ?? '' })
                  : t('connectorSettings.leaveBlank')}
                autoComplete="off"
                onChange={(event) => setCredential(field, event.target.value)}
                density="compact"
              />
            </label>
          ))}
        </div>
        {definition.helpUrl !== undefined && (
          <a className="plugin-editor-help" href={definition.helpUrl} rel="noreferrer" target="_blank">
            {definition.kind === 'github' ? t('connectorSettings.githubTokenHelp') : t('connectorSettings.helpLink')}
          </a>
        )}
      </div>

      <div className="plugin-editor-actions">
        <Button className="secondary-button" type="button" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button
          className="primary-button"
          type="submit"
          disabled={busy}
          state={busy ? 'loading' : 'idle'}
          loadingText={t('common.saving')}
        >
          {t('common.save')}
        </Button>
      </div>
    </form>
  )
}

function DingTalkSetup({
  instance,
  language,
  onCancel,
  onComplete,
}: {
  instance?: ConnectorInstance | undefined
  language: string
  onCancel(): void
  onComplete(): void
}) {
  const copy = DINGTALK_SETUP_COPY[language === 'zh-CN' ? 'zh' : 'en']
  const [status, setStatus] = useState<DingTalkRuntimeStatus>()
  const [busy, setBusy] = useState<'install' | 'login'>()

  useEffect(() => {
    let active = true
    void window.barn.dingtalk.status().then((next) => {
      if (active) setStatus(next)
    }).catch((reason: unknown) => {
      if (active) notifyError(errorMessage(reason))
    })
    return () => { active = false }
  }, [])

  async function install(): Promise<void> {
    setBusy('install')
    try {
      const next = await window.barn.dingtalk.install()
      setStatus(next)
      notifySuccess(copy.installed)
    } catch (reason) {
      notifyError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  async function login(): Promise<void> {
    setBusy('login')
    try {
      const next = await window.barn.dingtalk.login()
      setStatus(next)
      onComplete()
    } catch (reason) {
      notifyError(errorMessage(reason))
    } finally {
      setBusy(undefined)
    }
  }

  const identity = [status?.userName, status?.organization].filter((value) => value !== undefined).join(' · ')
  return (
    <section className="plugin-editor dingtalk-setup" aria-label={copy.title}>
      <header className="plugin-editor-header">
        <div>
          <span>{instance === undefined ? copy.title : copy.connected}</span>
          <h3>{copy.title}</h3>
        </div>
      </header>

      {status === undefined ? (
        <div className="dingtalk-setup-status" role="status">
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
          <span>{copy.checking}</span>
        </div>
      ) : status.authenticated ? (
        <div className="dingtalk-setup-status connected" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          <div>
            <strong>{copy.connected}</strong>
            <p>{copy.connectedDescription}</p>
            {identity.length > 0 && <small>{copy.connectedAs}: {identity}</small>}
          </div>
        </div>
      ) : status.installed ? (
        <div className="dingtalk-setup-status ready" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          <div>
            <strong>{copy.installed}</strong>
            <p>{copy.installedDescription}</p>
          </div>
        </div>
      ) : (
        <div className="plugin-editor-note">
          <Info size={14} aria-hidden="true" />
          <p>{copy.intro}</p>
        </div>
      )}

      <footer className="plugin-editor-actions">
        <Button className="secondary-button" type="button" onClick={onCancel}>{tCancel(language)}</Button>
        {status?.authenticated ? (
          <>
            <Button
              className="secondary-button"
              type="button"
              disabled={busy !== undefined}
              state={busy === 'login' ? 'loading' : 'idle'}
              loadingText={copy.signingIn}
              onClick={() => void login()}
            >
              {copy.reconnect}
            </Button>
            <Button className="primary-button" type="button" onClick={onComplete}>{copy.done}</Button>
          </>
        ) : status?.installed ? (
          <Button
            className="primary-button"
            type="button"
            disabled={busy !== undefined}
            state={busy === 'login' ? 'loading' : 'idle'}
            loadingText={copy.signingIn}
            onClick={() => void login()}
          >
            {copy.signIn}
          </Button>
        ) : (
          <Button
            className="primary-button"
            type="button"
            disabled={busy !== undefined || status === undefined}
            state={busy === 'install' ? 'loading' : 'idle'}
            loadingText={copy.installing}
            onClick={() => void install()}
          >
            {copy.install}
          </Button>
        )}
      </footer>
    </section>
  )
}

function tCancel(language: string): string {
  return language === 'zh-CN' ? '取消' : 'Cancel'
}

function ConnectorIcon({
  definition,
  size = 'small',
}: {
  definition: ConnectorDefinition
  size?: 'small' | 'large'
}) {
  return (
    <span
      className={`plugin-artwork plugin-artwork-${definition.kind} plugin-artwork-${size}`}
      data-brand-icon={definition.kind}
      aria-hidden="true"
    >
      {definition.kind === 'github'
        ? <GithubBrandMark size={size} />
        : definition.kind === 'dingtalk'
          ? <DingTalkBrandMark size={size} />
          : definition.icon === 'mail'
            ? <Mail size={size === 'large' ? 20 : 16} strokeWidth={1.9} />
            : <Plug size={size === 'large' ? 20 : 16} />}
    </span>
  )
}

/** GitHub provider mark, using the official brand silhouette. */
function GithubBrandMark({ size }: { size: 'small' | 'large' }) {
  return (
    <svg
      className={size === 'large' ? 'plugin-brand-svg large' : 'plugin-brand-svg'}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M12 1.95068C17.525 1.95068 22 6.42568 22 11.9507C21.9995 14.0459 21.3419 16.0883 20.1198 17.7902C18.8977 19.4922 17.1727 20.768 15.1875 21.4382C14.6875 21.5382 14.5 21.2257 14.5 20.9632C14.5 20.6257 14.5125 19.5507 14.5125 18.2132C14.5125 17.2757 14.2 16.6757 13.8375 16.3632C16.0625 16.1132 18.4 15.2632 18.4 11.4257C18.4 10.3257 18.0125 9.43818 17.375 8.73818C17.475 8.48818 17.825 7.46318 17.275 6.08818C17.275 6.08818 16.4375 5.81318 14.525 7.11318C13.725 6.88818 12.875 6.77568 12.025 6.77568C11.175 6.77568 10.325 6.88818 9.525 7.11318C7.6125 5.82568 6.775 6.08818 6.775 6.08818C6.225 7.46318 6.575 8.48818 6.675 8.73818C6.0375 9.43818 5.65 10.3382 5.65 11.4257C5.65 15.2507 7.975 16.1132 10.2 16.3632C9.9125 16.6132 9.65 17.0507 9.5625 17.7007C8.9875 17.9632 7.55 18.3882 6.65 16.8757C6.4625 16.5757 5.9 15.8382 5.1125 15.8507C4.275 15.8632 4.775 16.3257 5.125 16.5132C5.55 16.7507 6.0375 17.6382 6.15 17.9257C6.35 18.4882 7 19.5632 9.5125 19.1007C9.5125 19.9382 9.525 20.7257 9.525 20.9632C9.525 21.2257 9.3375 21.5257 8.8375 21.4382C6.8458 20.7752 5.11342 19.502 3.88611 17.799C2.65881 16.096 1.9989 14.0498 2 11.9507C2 6.42568 6.475 1.95068 12 1.95068Z"
      />
    </svg>
  )
}

/** Official DingTalk mark, adapted from Ant Design Icons (MIT). */
function DingTalkBrandMark({ size }: { size: 'small' | 'large' }) {
  return (
    <svg
      className={size === 'large' ? 'plugin-brand-svg large' : 'plugin-brand-svg'}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M573.7 252.5C422.5 197.4 201.3 96.7 201.3 96.7c-15.7-4.1-17.9 11.1-17.9 11.1c-5 61.1 33.6 160.5 53.6 182.8c19.9 22.3 319.1 113.7 319.1 113.7S326 357.9 270.5 341.9c-55.6-16-37.9 17.8-37.9 17.8c11.4 61.7 64.9 131.8 107.2 138.4c42.2 6.6 220.1 4 220.1 4s-35.5 4.1-93.2 11.9c-42.7 5.8-97 12.5-111.1 17.8c-33.1 12.5 24 62.6 24 62.6c84.7 76.8 129.7 50.5 129.7 50.5c33.3-10.7 61.4-18.5 85.2-24.2L565 743.1h84.6L603 928l205.3-271.9H700.8l22.3-38.7c.3.5.4.8.4.8S799.8 496.1 829 433.8l.6-1h-.1c5-10.8 8.6-19.7 10-25.8c17-71.3-114.5-99.4-265.8-154.5"
      />
    </svg>
  )
}

function connectorCategory(kind: string): ConnectorCategory {
  return kind === 'dingtalk' ? 'china' : 'integrations'
}

function aggregateStatus(instances: ConnectorInstance[]): ConnectorInstance['status'] | undefined {
  if (instances.some((instance) => instance.status === 'error')) return 'error'
  if (instances.some((instance) => instance.status === 'ready')) return 'ready'
  if (instances.some((instance) => instance.status === 'needs_setup')) return 'needs_setup'
  return instances.length > 0 ? 'disabled' : undefined
}

function translatedDefinitionName(
  definition: ConnectorDefinition,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string, options?: { defaultValue?: string }) => string
  return translate(`connectorSettings.kinds.${definition.kind}.name`, { defaultValue: definition.name })
}

function fieldLabel(
  field: ConnectorSetupField,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string, options?: { defaultValue?: string }) => string
  return translate(`connectorSettings.fields.${field.key}`, { defaultValue: field.label })
}

function capabilityTranslationKey(id: string): string {
  if (id === 'email.list') return 'emailList'
  if (id === 'email.search') return 'emailSearch'
  if (id === 'email.read') return 'emailRead'
  if (id === 'email.send') return 'emailSend'
  if (id === 'github.searchRepositories') return 'githubSearchRepositories'
  if (id === 'github.listRepositories') return 'githubListRepositories'
  if (id === 'github.getRepository') return 'githubGetRepository'
  if (id === 'github.searchIssues') return 'githubSearchIssues'
  if (id === 'github.listIssues') return 'githubListIssues'
  if (id === 'github.getIssue') return 'githubGetIssue'
  if (id === 'github.listPullRequests') return 'githubListPullRequests'
  if (id === 'github.getPullRequest') return 'githubGetPullRequest'
  if (id === 'github.createIssue') return 'githubCreateIssue'
  if (id === 'github.comment') return 'githubComment'
  return id
}

function capabilityDescription(
  capability: ConnectorCapabilityDefinition,
  t: ReturnType<typeof useTranslation>['t'],
  language: string,
): string {
  const dingtalkCopy = DINGTALK_CAPABILITY_COPY[capability.id as keyof typeof DINGTALK_CAPABILITY_COPY]
  if (dingtalkCopy !== undefined) return language === 'zh-CN' ? dingtalkCopy.zh.description : dingtalkCopy.en.description
  const translate = t as (key: string, options?: { defaultValue?: string }) => string
  return translate(`connectorSettings.capabilityDescriptions.${capabilityTranslationKey(capability.id)}`, {
    defaultValue: capability.description,
  })
}

function capabilityName(
  capability: ConnectorCapabilityDefinition,
  t: ReturnType<typeof useTranslation>['t'],
  language: string,
): string {
  const dingtalkCopy = DINGTALK_CAPABILITY_COPY[capability.id as keyof typeof DINGTALK_CAPABILITY_COPY]
  if (dingtalkCopy !== undefined) return language === 'zh-CN' ? dingtalkCopy.zh.name : dingtalkCopy.en.name
  const translate = t as (key: string, options?: { defaultValue?: string }) => string
  return translate(`connectorSettings.capabilities.${capabilityTranslationKey(capability.id)}`, {
    defaultValue: capability.name,
  })
}

function initialConfigFor(definition: ConnectorDefinition, instance?: ConnectorInstance): ConnectorConfig {
  const config: ConnectorConfig = { ...instance?.config }
  for (const field of definition.configFields) {
    if (config[field.key] === undefined && field.defaultValue !== undefined) config[field.key] = field.defaultValue
  }
  return config
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
