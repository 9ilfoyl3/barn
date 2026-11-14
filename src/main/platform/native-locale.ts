import { app } from 'electron'

export type NativeLocale = 'en' | 'zh-CN'

export function nativeLocale(languages: readonly string[] = app.getPreferredSystemLanguages()): NativeLocale {
  if (process.env.BARN_UI_LANGUAGE === 'en' || process.env.BARN_UI_LANGUAGE === 'zh-CN') {
    return process.env.BARN_UI_LANGUAGE
  }
  return languages.some((language) => language.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en'
}

export function nativeCopy(locale: NativeLocale) {
  return locale === 'zh-CN'
    ? {
        attachFiles: '添加文件',
        chooseFolder: '选择要监听的文件夹',
        noActiveWindow: '没有活动窗口',
      }
    : {
        attachFiles: 'Attach files',
        chooseFolder: 'Choose a folder to watch',
        noActiveWindow: 'No active window',
      }
}
