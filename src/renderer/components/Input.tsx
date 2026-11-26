// Beui Motion Input adapter. Keeps Barn's native input event surface while
// rendering the beui component for all pure text and search fields.
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Input as BeuiInput } from './beui/components/motion/input'
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
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  ...rest
}, forwardedRef) {
  const { t } = useTranslation()
  const generatedId = useId()
  const id = providedId ?? generatedId
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [localError, setLocalError] = useState<string>()
  const [localSuccess, setLocalSuccess] = useState(false)

  const externalError = typeof error === 'string' ? error : error === true ? '' : undefined
  const resolvedError = externalError ?? localError
  const resolvedSuccess = resolvedError === undefined && (success === true || localSuccess)
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  useEffect(() => () => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
  }, [])

  function validateValue(next: string): void {
    if (validate !== undefined) {
      const result = validate(next)
      if (typeof result === 'string') {
        setLocalError(result)
        setLocalSuccess(false)
      } else if (result === true) {
        setLocalError(t('input.invalidValue'))
        setLocalSuccess(false)
      } else {
        setLocalError(undefined)
        setLocalSuccess(false)
      }
      return
    }
    if (type === 'email' && next.trim().length > 0) {
      setLocalError(EMAIL_PATTERN.test(next.trim()) ? undefined : t('input.invalidEmail'))
      setLocalSuccess(EMAIL_PATTERN.test(next.trim()))
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
    <div
      className={`barn-input ${containerClassName ?? ''}`.trim()}
      data-density={density}
      data-appearance={appearance}
    >
      <BeuiInput
        {...rest}
        ref={forwardedRef}
        id={id}
        type={type}
        {...(typeof label === 'string' ? { label } : {})}
        {...(value === undefined ? {} : { value: String(value) })}
        {...(defaultValue === undefined ? {} : { defaultValue: String(defaultValue) })}
        disabled={disabled}
        {...(resolvedError === undefined ? {} : { error: resolvedError === '' ? true : resolvedError })}
        {...(resolvedSuccess ? { success: true } : {})}
        leftIcon={leadingIcon}
        rightIcon={trailing}
        {...(resolvedError !== undefined || ariaInvalid !== undefined
          ? { 'aria-invalid': resolvedError !== undefined ? true : ariaInvalid }
          : {})}
        {...(() => {
          const description = [describedBy, resolvedError !== undefined ? `${id}-error` : undefined].filter(Boolean).join(' ')
          return description === '' ? {} : { 'aria-describedby': description }
        })()}
        className="beui-motion-input"
        classNames={{
          field: `barn-input-field ${fieldClassName ?? ''}`.trim(),
          input: `barn-input-control ${inputClassName ?? ''}`.trim(),
          ...(leadingIcon === undefined ? {} : { leftIcon: 'barn-input-leading' }),
          ...(trailing === undefined ? {} : { rightIcon: 'barn-input-trailing' }),
        }}
        onChange={(next) => {
          setLocalError(undefined)
          setLocalSuccess(false)
          onChange?.({
            target: { value: next },
            currentTarget: { value: next },
          } as ChangeEvent<HTMLInputElement>)
          if (timerRef.current !== undefined) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => validateValue(next), reducedMotion ? 300 : 800)
        }}
        onBlur={(event) => {
          if (timerRef.current !== undefined) clearTimeout(timerRef.current)
          validateValue(event.target.value)
          rest.onBlur?.(event)
        }}
      />
      {helperText !== undefined && resolvedError === undefined && (
        <span className="barn-input-helper">{helperText}</span>
      )}
    </div>
  )
})
