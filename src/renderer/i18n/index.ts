import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  resources,
  SUPPORTED_LANGUAGES,
  type AppLanguage,
} from './resources'

export const LANGUAGE_STORAGE_KEY = 'barn.language'
export type LanguagePreference = 'system' | AppLanguage

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.includes(value as AppLanguage)
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || isAppLanguage(value)
}

function storedLanguagePreference(): LanguagePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return isLanguagePreference(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

export function applyDocumentLanguage(language: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = language
}

const initialPreference = storedLanguagePreference()

void i18n.use(initReactI18next).init({
  resources,
  lng: isAppLanguage(initialPreference) ? initialPreference : 'en',
  fallbackLng: 'en',
  supportedLngs: SUPPORTED_LANGUAGES,
  load: 'currentOnly',
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
  initAsync: false,
  returnNull: false,
})

applyDocumentLanguage(i18n.resolvedLanguage ?? 'en')
i18n.on('languageChanged', applyDocumentLanguage)

async function systemLanguage(): Promise<AppLanguage> {
  try {
    return await window.barn.i18n.getNativeLocale()
  } catch {
    // Browser language detection remains the fallback when the native bridge is unavailable.
  }
  const browserLanguage = typeof navigator === 'undefined' ? 'en' : navigator.language
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export async function initializeAppLanguage(): Promise<void> {
  const preference = storedLanguagePreference()
  if (isAppLanguage(preference)) {
    if (i18n.resolvedLanguage !== preference) await i18n.changeLanguage(preference)
    return
  }
  await i18n.changeLanguage(await systemLanguage())
}

export async function changeAppLanguage(preference: LanguagePreference): Promise<void> {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference)
  } catch {
    // Language persistence is best-effort; the in-memory language still changes.
  }
  await i18n.changeLanguage(preference === 'system' ? await systemLanguage() : preference)
}

export function currentAppLanguage(): AppLanguage {
  return isAppLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : 'en'
}

export function currentLanguagePreference(): LanguagePreference {
  return storedLanguagePreference()
}

export default i18n
