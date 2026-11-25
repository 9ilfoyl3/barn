// Lucian UX/UI Prompt #434 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#434
import { useTranslation } from 'react-i18next'
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import './input.css'

export type InputValidation = (value: string) => string | boolean | undefined

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode
  helperText?: ReactNode
  error?: string | boolean
  success?: boolean
  validate?: InputValidation
  leadingIcon?: ReactNode
  trailing?: ReactNode
  containerClassName?: string
  fieldClassName?: string
  inputClassName?: string
  density?: 'default' | 'compact'
  appearance?: 'default' | 'flush'
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({
  label,
  helperText,
  error,
  success,
  validate,
  leadingIcon,
  trailing,
  containerClassName,
  fieldClassName,
  inputClassName,
  density = 'default',
  appearance = 'default',
  disabled,
  id: providedId,
  type = 'text',
  value,
  defaultValue,
  onChange,
  onFocus,
  onBlur,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  ...rest
}, forwardedRef) {
  const { t } = useTranslation()
  const generatedId = useId()
  const id = providedId ?? generatedId
  const messageId = `${id}-message`
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [focused, setFocused] = useState(false)
  const [localError, setLocalError] = useState<string>()
  const [localSuccess, setLocalSuccess] = useState(false)
  const [shake, setShake] = useState(false)

  const externalError = typeof error === 'string' ? error : error === true ? '' : undefined
  const resolvedError = externalError ?? localError
  const hasError = resolvedError !== undefined
  const resolvedSuccess = !hasError && (success === true || localSuccess)
  const message = hasError ? resolvedError : resolvedSuccess ? '' : helperText
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  useEffect(() => () => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
  }, [])

  useEffect(() => {
    if (!hasError || reducedMotion) return
    setShake(true)
    const timer = setTimeout(() => setShake(false), 460)
    return () => clearTimeout(timer)
  }, [hasError, reducedMotion, resolvedError])

  function validateValue(next: string): void {
    if (validate !== undefined) {
      const result = validate(next)
      if (typeof result === 'string') {
        setLocalError(result)
        setLocalSuccess(false)
      } else if (result === true) {
        setLocalError('Invalid value')
        setLocalSuccess(false)
      } else {
        setLocalError(undefined)
        setLocalSuccess(false)
      }
      return
    }
    if (type === 'email' && next.trim().length > 0) {
      if (EMAIL_PATTERN.test(next.trim())) {
        setLocalError(undefined)
        setLocalSuccess(true)
      } else {
        setLocalError(t('input.invalidEmail'))
        setLocalSuccess(false)
      }
      return
    }
    if (type === 'url' && next.trim().length > 0) {
      try {
        const parsed = new URL(next.trim())
        if (parsed.protocol.length < 2) throw new Error('Invalid URL')
        setLocalError(undefined)
        setLocalSuccess(true)
      } catch {
        setLocalError(t('input.invalidUrl'))
        setLocalSuccess(false)
      }
      return
    }
    setLocalError(undefined)
    setLocalSuccess(false)
  }

  return (
    <div className={`barn-input ${containerClassName ?? ''}`.trim()} data-density={density} data-appearance={appearance}>
      {label !== undefined && <label className="barn-input-label" htmlFor={id}>{label}</label>}
      <div
        ref={fieldRef}
        className={`barn-input-field${focused ? ' is-focus' : ''}${hasError ? ' is-err' : ''}${resolvedSuccess ? ' is-ok' : ''}${shake ? ' is-shaking' : ''}${disabled ? ' is-disabled' : ''} ${fieldClassName ?? ''}`.trim()}
      >
        {leadingIcon !== undefined && <span className="barn-input-leading" aria-hidden="true">{leadingIcon}</span>}
        <input
          {...rest}
          ref={forwardedRef}
          id={id}
          type={type}
          value={value}
          defaultValue={defaultValue}
          disabled={disabled}
          aria-invalid={hasError ? true : ariaInvalid}
          aria-describedby={message !== undefined && message !== '' ? [describedBy, messageId].filter(Boolean).join(' ') : describedBy}
          className={`barn-input-control ${inputClassName ?? ''}`.trim()}
          onChange={(event) => {
            setLocalError(undefined)
            setLocalSuccess(false)
            onChange?.(event)
            if (timerRef.current !== undefined) clearTimeout(timerRef.current)
            const next = event.target.value
            timerRef.current = setTimeout(() => validateValue(next), reducedMotion ? 300 : 800)
          }}
          onFocus={(event) => {
            setFocused(true)
            onFocus?.(event)
          }}
          onBlur={(event) => {
            setFocused(false)
            if (timerRef.current !== undefined) clearTimeout(timerRef.current)
            validateValue(event.target.value)
            onBlur?.(event)
          }}
        />
        {trailing !== undefined && <span className="barn-input-trailing">{trailing}</span>}
        {(resolvedSuccess || hasError) && (
          <span className="barn-input-status" aria-hidden="true">
            <span className="barn-input-ok">
              <svg viewBox="0 0 24 24"><path d="m5.5 12.5 4 4 9-9.5" /></svg>
            </span>
            <span className="barn-input-no">
              <svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01" /></svg>
            </span>
          </span>
        )}
      </div>
      {message !== undefined && message !== '' && (
        <p className={`barn-input-message${hasError ? ' error' : resolvedSuccess ? ' success' : ''}`} id={messageId} aria-live="polite">
          {message}
        </p>
      )}
      {(resolvedSuccess || hasError) && message === '' && (
        <span className="barn-input-sr-only" id={messageId}>
          {hasError ? t('input.invalidValue') : t('input.validValue')}
        </span>
      )}
    </div>
  )
})
