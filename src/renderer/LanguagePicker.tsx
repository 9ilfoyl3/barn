import { Check, ChevronLeft, ChevronRight, Globe2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  changeAppLanguage,
  currentLanguagePreference,
  type LanguagePreference,
} from './i18n'
import type { FloatingMenuSide } from './floating-menu'
import { SecondaryMenu } from './components/SecondaryMenu'

const LANGUAGE_CHOICES: ReadonlyArray<{ value: LanguagePreference; labelKey: 'language.system' | 'language.english' | 'language.chinese' }> = [
  { value: 'system', labelKey: 'language.system' },
  { value: 'en', labelKey: 'language.english' },
  { value: 'zh-CN', labelKey: 'language.chinese' },
]

export function LanguagePicker() {
  const { t } = useTranslation()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [submenuSide, setSubmenuSide] = useState<FloatingMenuSide>('right')
  const menuId = useId()
  const preference = currentLanguagePreference()

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        className="account-menu-item"
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Globe2 size={15} aria-hidden="true" />
        <span>{t('language.menuLabel')}</span>
        {open && submenuSide === 'left'
          ? <ChevronLeft className="account-menu-chevron" size={14} aria-hidden="true" />
          : <ChevronRight className="account-menu-chevron" size={14} aria-hidden="true" />}
      </button>
      <SecondaryMenu
        ref={menuRef}
        open={open}
        anchor={triggerRef}
        id={menuId}
        className="language-submenu"
        role="menu"
        ariaLabel={t('language.label')}
        onSideChange={setSubmenuSide}
      >
        {LANGUAGE_CHOICES.map((choice) => {
          const selected = choice.value === preference
          return (
            <button
              key={choice.value}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              onClick={() => {
                void changeAppLanguage(choice.value)
                setOpen(false)
              }}
            >
              <span>{t(choice.labelKey)}</span>
              {selected && <Check size={15} aria-hidden="true" />}
            </button>
          )
        })}
      </SecondaryMenu>
    </>
  )
}
