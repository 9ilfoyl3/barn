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
        attachFolder: '添加文件夹',
        chooseWorkingDirectory: '选择当前工作目录',
        openBarn: '打开 Barn',
        needsYou: '需要你',
        launchAtLogin: '登录时启动',
        quitBarn: '退出 Barn',
        noActiveWindow: '没有活动窗口',
      }
    : {
        attachFiles: 'Attach files',
        chooseFolder: 'Choose a folder to watch',
        attachFolder: 'Attach a folder',
        chooseWorkingDirectory: 'Choose current working directory',
        openBarn: 'Open Barn',
        needsYou: 'Needs you',
        launchAtLogin: 'Launch at login',
        quitBarn: 'Quit Barn',
        noActiveWindow: 'No active window',
      }
}
