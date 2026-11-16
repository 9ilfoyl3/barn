import '@fontsource-variable/public-sans'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/inter'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { TooltipProvider } from './components/ui/tooltip'
import './i18n'
import './styles.css'

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
const syncThemeClass = (): void => {
  document.documentElement.classList.toggle('dark', colorScheme.matches)
}

syncThemeClass()
colorScheme.addEventListener('change', syncThemeClass)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={350} skipDelayDuration={120}>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
)
