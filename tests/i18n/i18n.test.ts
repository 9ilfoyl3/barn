import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../src/renderer/i18n'

describe('renderer i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('translates UI copy and interpolates values in English and Simplified Chinese', async () => {
    expect(i18n.t('conversation.title')).toBe('What needs attention?')
    expect(i18n.t('language.current', { language: i18n.t('language.english') })).toBe('Current language: English')

    await i18n.changeLanguage('zh-CN')

    expect(i18n.t('conversation.title')).toBe('今天需要处理什么？')
    expect(i18n.t('language.current', { language: i18n.t('language.chinese') })).toBe('当前语言：中文简体')
  })

  it('uses plural forms for dynamic counts', async () => {
    expect(i18n.t('common.providers', { count: 1 })).toBe('1 provider')
    expect(i18n.t('common.providers', { count: 2 })).toBe('2 providers')

    await i18n.changeLanguage('zh-CN')

    expect(i18n.t('common.providers', { count: 1 })).toBe('1 个提供商')
    expect(i18n.t('common.providers', { count: 2 })).toBe('2 个提供商')
  })

  it('falls back to English for unsupported translation keys', async () => {
    await i18n.changeLanguage('zh-CN')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(i18n.t('settings.missingKey' as never)).toBe('settings.missingKey')
    warn.mockRestore()
  })
})
