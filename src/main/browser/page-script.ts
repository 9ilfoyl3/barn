export interface SnapshotOptions {
  textLimit: number
  maxElements: number
}

export interface PageSnapshot {
  url: string
  title: string
  text: string
  elements: Array<{
    ref: string
    role: string
    name: string
    tag: string
    type?: string
    value?: string
    checked?: boolean
    disabled?: boolean
    href?: string
    placeholder?: string
  }>
  truncated: boolean
}

export interface PageAction {
  type: 'click' | 'type' | 'select' | 'press' | 'scroll' | 'hover' | 'wait'
  ref?: string | undefined
  text?: string | undefined
  value?: string | undefined
  key?: string | undefined
  direction?: 'up' | 'down' | 'left' | 'right' | undefined
  amount?: number | undefined
  ms?: number | undefined
  submit?: boolean | undefined
}

export function collectPageSnapshot(options: SnapshotOptions): PageSnapshot {
  document.querySelectorAll('[data-barn-ref]').forEach((element) => {
    element.removeAttribute('data-barn-ref')
  })

  const inferRole = (tag: string, inputType: string | undefined): string => {
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      if (inputType === 'checkbox') return 'checkbox'
      if (inputType === 'radio') return 'radio'
      if (inputType === 'button' || inputType === 'submit') return 'button'
      return 'textbox'
    }
    return tag
  }

  const selectors = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')

  const elements: PageSnapshot['elements'] = []
  let index = 0
  for (const element of Array.from(document.querySelectorAll<HTMLElement>(selectors))) {
    if (elements.length >= options.maxElements) break
    if (element.closest('[aria-hidden="true"]') !== null) continue
    const style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || element.getClientRects().length === 0) continue
    if ('disabled' in element && (element as HTMLButtonElement).disabled) {
      // Keep disabled controls visible in the snapshot but mark them.
    }

    index += 1
    const ref = `e${index}`
    element.setAttribute('data-barn-ref', ref)
    const input = element as HTMLInputElement
    const tag = element.tagName.toLowerCase()
    const explicitRole = element.getAttribute('role')
    const role = explicitRole ?? inferRole(tag, input.type)
    const name = (
      element.getAttribute('aria-label')
      ?? element.getAttribute('title')
      ?? element.innerText?.trim().replace(/\s+/g, ' ')
      ?? input.placeholder
      ?? input.value
      ?? ''
    ).slice(0, 240)
    const description: PageSnapshot['elements'][number] = {
      ref,
      role,
      name,
      tag,
    }
    if (tag === 'input') description.type = input.type || 'text'
    if (input.value !== undefined && input.type !== 'password') description.value = String(input.value).slice(0, 500)
    if (input.type === 'checkbox' || input.type === 'radio') description.checked = input.checked
    if ('disabled' in element) description.disabled = Boolean((element as HTMLButtonElement).disabled)
    if (element instanceof HTMLAnchorElement) description.href = element.href
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.placeholder.length > 0) description.placeholder = element.placeholder
    }
    elements.push(description)
  }

  const fullText = document.body?.innerText ?? ''
  return {
    url: location.href,
    title: document.title,
    text: fullText.slice(0, options.textLimit),
    elements,
    truncated: fullText.length > options.textLimit || elements.length >= options.maxElements,
  }
}

export function readPageText(maxChars: number): { url: string; title: string; text: string; truncated: boolean } {
  const fullText = document.body?.innerText ?? ''
  return {
    url: location.href,
    title: document.title,
    text: fullText.slice(0, maxChars),
    truncated: fullText.length > maxChars,
  }
}

export async function performPageActions(actions: PageAction[]): Promise<{ performed: number; url: string; title: string }> {
  const elementFor = (ref: string | undefined): HTMLElement | null => {
    if (ref === undefined) return null
    return document.querySelector<HTMLElement>(`[data-barn-ref="${ref.replace(/[^a-zA-Z0-9_-]/g, '')}"]`)
  }

  const setNativeValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void => {
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter !== undefined) setter.call(element, value)
    else element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const dispatchKey = (element: HTMLElement, key: string): void => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
  }

  for (const action of actions) {
    const element = elementFor(action.ref)
    if (action.type === 'click') {
      if (element === null) throw new Error(`Unknown element ref: ${action.ref ?? '(missing)'}`)
      element.scrollIntoView({ block: 'center', inline: 'center' })
      element.focus()
      element.click()
      continue
    }
    if (action.type === 'type') {
      if (element === null) throw new Error(`Unknown element ref: ${action.ref ?? '(missing)'}`)
      element.scrollIntoView({ block: 'center', inline: 'center' })
      element.focus()
      if (element.isContentEditable) {
        element.textContent = action.text ?? ''
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text ?? '' }))
      } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        setNativeValue(element, action.text ?? '')
      } else {
        throw new Error(`Element ${action.ref} does not accept text`)
      }
      if (action.submit === true) {
        const form = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
          ? element.form
          : element.closest('form')
        form?.requestSubmit()
      }
      continue
    }
    if (action.type === 'select') {
      if (!(element instanceof HTMLSelectElement)) throw new Error(`Element ${action.ref ?? '(missing)'} is not a select`)
      element.focus()
      setNativeValue(element, action.value ?? '')
      continue
    }
    if (action.type === 'hover') {
      if (element === null) throw new Error(`Unknown element ref: ${action.ref ?? '(missing)'}`)
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      continue
    }
    if (action.type === 'press') {
      const target = element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : document.body)
      dispatchKey(target, action.key ?? 'Enter')
      if (action.key === 'Enter' && target instanceof HTMLInputElement) target.form?.requestSubmit()
      continue
    }
    if (action.type === 'scroll') {
      const amount = action.amount ?? 600
      const direction = action.direction ?? 'down'
      window.scrollBy({
        left: direction === 'left' ? -amount : direction === 'right' ? amount : 0,
        top: direction === 'up' ? -amount : direction === 'down' ? amount : 0,
        behavior: 'instant',
      })
      continue
    }
    if (action.type === 'wait') {
      await new Promise<void>((resolve) => setTimeout(resolve, action.ms ?? 250))
      continue
    }
    throw new Error(`Unsupported action: ${(action as { type: string }).type}`)
  }

  return {
    performed: actions.length,
    url: location.href,
    title: document.title,
  }
}



export function classifyPageActions(actions: PageAction[]): {
  consequential: boolean
  summary: string
  details: string
} {
  const elementFor = (ref: string | undefined): HTMLElement | null => {
    if (ref === undefined) return null
    return document.querySelector<HTMLElement>(`[data-barn-ref="${ref.replace(/[^a-zA-Z0-9_-]/g, '')}"]`)
  }
  const formFor = (element: HTMLElement | null): HTMLFormElement | null => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      return element.form
    }
    return element?.closest('form') ?? null
  }

  let submitForm: HTMLFormElement | null = null
  let download = false
  for (const action of actions) {
    const element = elementFor(action.ref)
    if (action.type === 'type' && action.submit === true) submitForm = formFor(element)
    if (action.type === 'click') {
      if (element instanceof HTMLButtonElement && (element.type === 'submit' || element.form !== null)) submitForm = element.form
      if (element instanceof HTMLInputElement && (element.type === 'submit' || element.type === 'image')) submitForm = element.form
      if (element instanceof HTMLAnchorElement && element.hasAttribute('download')) download = true
    }
    if (action.type === 'press' && action.key === 'Enter') {
      const target = element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
      submitForm = formFor(target)
    }
  }

  if (download) {
    return {
      consequential: true,
      summary: 'Start a browser download',
      details: `The Agent wants to download a file from ${location.host}.`,
    }
  }
  if (submitForm !== null) {
    const formName = submitForm.getAttribute('aria-label') ?? submitForm.getAttribute('name') ?? 'a form'
    return {
      consequential: true,
      summary: `Submit ${formName} on ${location.host}`,
      details: `The Agent wants to submit ${formName} at ${location.href}. Review the page before allowing this action.`,
    }
  }
  return { consequential: false, summary: '', details: '' }
}
