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
  const roots: Array<Document | ShadowRoot> = []
  const seen = new Set<Document | ShadowRoot>()
  const addRoot = (root: Document | ShadowRoot): void => {
    if (seen.has(root)) return
    seen.add(root)
    roots.push(root)
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.shadowRoot !== null) addRoot(element.shadowRoot)
      if (element.tagName.toLowerCase() === 'iframe') {
        try {
          const document = (element as HTMLIFrameElement).contentDocument
          if (document !== null) addRoot(document)
        } catch {
          // Cross-origin frames are intentionally skipped.
        }
      }
    }
  }
  addRoot(document)

  for (const root of roots) {
    root.querySelectorAll('[data-barn-ref]').forEach((element) => element.removeAttribute('data-barn-ref'))
  }

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
  for (const root of roots) {
    for (const element of Array.from(root.querySelectorAll<HTMLElement>(selectors))) {
      if (elements.length >= options.maxElements) break
      if (element.closest('[aria-hidden="true"]') !== null) continue
      const view = element.ownerDocument.defaultView
      const style = view?.getComputedStyle(element)
      if (style?.display === 'none' || style?.visibility === 'hidden' || element.getClientRects().length === 0) continue

      index += 1
      const ref = `e${index}`
      element.setAttribute('data-barn-ref', ref)
      const tag = element.tagName.toLowerCase()
      const inputType = tag === 'input' ? (element as HTMLInputElement).type : undefined
      const explicitRole = element.getAttribute('role')
      const role = explicitRole ?? inferRole(tag, inputType)
      const inputValue = 'value' in element ? String((element as HTMLInputElement).value ?? '') : ''
      const placeholder = 'placeholder' in element ? String((element as HTMLInputElement).placeholder ?? '') : ''
      const name = (
        element.getAttribute('aria-label')
        ?? element.getAttribute('title')
        ?? element.innerText?.trim().replace(/\s+/g, ' ')
        ?? placeholder
        ?? inputValue
        ?? ''
      ).slice(0, 240)
      const description: PageSnapshot['elements'][number] = { ref, role, name, tag }
      if (inputType !== undefined) description.type = inputType || 'text'
      if (inputValue.length > 0 && inputType !== 'password') description.value = inputValue.slice(0, 500)
      if (inputType === 'checkbox' || inputType === 'radio') description.checked = (element as HTMLInputElement).checked
      if ('disabled' in element) description.disabled = Boolean((element as HTMLButtonElement).disabled)
      if (tag === 'a') description.href = (element as HTMLAnchorElement).href
      if (placeholder.length > 0) description.placeholder = placeholder
      elements.push(description)
    }
    if (elements.length >= options.maxElements) break
  }

  const fullText = roots
    .filter((root): root is Document => root.nodeType === Node.DOCUMENT_NODE)
    .map((root) => root.body?.innerText ?? '')
    .filter((text) => text.length > 0)
    .join('\n')
  return {
    url: location.href,
    title: document.title,
    text: fullText.slice(0, options.textLimit),
    elements,
    truncated: fullText.length > options.textLimit || elements.length >= options.maxElements,
  }
}

export function readPageText(maxChars: number): { url: string; title: string; text: string; truncated: boolean } {
  const documents: Document[] = [document]
  const seen = new Set<Document>(documents)
  const addFrames = (root: Document): void => {
    for (const frame of Array.from(root.querySelectorAll('iframe'))) {
      try {
        const document = (frame as HTMLIFrameElement).contentDocument
        if (document !== null && !seen.has(document)) {
          seen.add(document)
          documents.push(document)
          addFrames(document)
        }
      } catch {
        // Cross-origin frames are intentionally skipped.
      }
    }
  }
  addFrames(document)
  const fullText = documents.map((root) => root.body?.innerText ?? '').join('\n')
  return {
    url: location.href,
    title: document.title,
    text: fullText.slice(0, maxChars),
    truncated: fullText.length > maxChars,
  }
}

export async function performPageActions(actions: PageAction[]): Promise<{ performed: number; url: string; title: string }> {
  const roots: Array<Document | ShadowRoot> = []
  const seen = new Set<Document | ShadowRoot>()
  const addRoot = (root: Document | ShadowRoot): void => {
    if (seen.has(root)) return
    seen.add(root)
    roots.push(root)
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.shadowRoot !== null) addRoot(element.shadowRoot)
      if (element.tagName.toLowerCase() === 'iframe') {
        try {
          const document = (element as HTMLIFrameElement).contentDocument
          if (document !== null) addRoot(document)
        } catch {
          // Cross-origin frames are intentionally skipped.
        }
      }
    }
  }
  addRoot(document)

  const elementFor = (ref: string | undefined): HTMLElement | null => {
    if (ref === undefined) return null
    const selector = `[data-barn-ref="${ref.replace(/[^a-zA-Z0-9_-]/g, '')}"]`
    for (const root of roots) {
      const element = root.querySelector<HTMLElement>(selector)
      if (element !== null) return element
    }
    return null
  }

  const setNativeValue = (element: HTMLElement, value: string): void => {
    const tag = element.tagName.toLowerCase()
    const view = element.ownerDocument.defaultView
    const prototype = tag === 'select'
      ? view?.HTMLSelectElement.prototype
      : tag === 'textarea'
        ? view?.HTMLTextAreaElement.prototype
        : view?.HTMLInputElement.prototype
    const setter = prototype === undefined ? undefined : Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter !== undefined) setter.call(element, value)
    else (element as HTMLInputElement).value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const dispatchKey = (element: HTMLElement, key: string): void => {
    const view = element.ownerDocument.defaultView
    const Keyboard = (view?.KeyboardEvent ?? window.KeyboardEvent) as typeof window.KeyboardEvent
    element.dispatchEvent(new Keyboard('keydown', { key, bubbles: true, cancelable: true }))
    element.dispatchEvent(new Keyboard('keyup', { key, bubbles: true, cancelable: true }))
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
      const tag = element.tagName.toLowerCase()
      if (element.isContentEditable) {
        element.textContent = action.text ?? ''
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.text ?? '' }))
      } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        setNativeValue(element, action.text ?? '')
      } else {
        throw new Error(`Element ${action.ref} does not accept text`)
      }
      if (action.submit === true) {
        const form = tag === 'input' || tag === 'textarea' || tag === 'select'
          ? (element as HTMLInputElement).form
          : element.closest('form')
        form?.requestSubmit()
      }
      continue
    }
    if (action.type === 'select') {
      if (element === null || element.tagName.toLowerCase() !== 'select') {
        throw new Error(`Element ${action.ref ?? '(missing)'} is not a select`)
      }
      element.focus()
      setNativeValue(element, action.value ?? '')
      continue
    }
    if (action.type === 'hover') {
      if (element === null) throw new Error(`Unknown element ref: ${action.ref ?? '(missing)'}`)
      const Mouse = element.ownerDocument.defaultView?.MouseEvent ?? MouseEvent
      element.dispatchEvent(new Mouse('mouseover', { bubbles: true }))
      element.dispatchEvent(new Mouse('mouseenter', { bubbles: true }))
      continue
    }
    if (action.type === 'press') {
      const target = element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : document.body)
      dispatchKey(target, action.key ?? 'Enter')
      if (action.key === 'Enter' && target.tagName.toLowerCase() === 'input') {
        ;(target as HTMLInputElement).form?.requestSubmit()
      }
      continue
    }
    if (action.type === 'scroll') {
      const amount = action.amount ?? 600
      const direction = action.direction ?? 'down'
      window.scrollBy({
        left: direction === 'left' ? -amount : direction === 'right' ? amount : 0,
        top: direction === 'up' ? -amount : direction === 'down' ? amount : 0,
        behavior: 'auto',
      })
      continue
    }
    if (action.type === 'wait') {
      await new Promise<void>((resolve) => setTimeout(resolve, action.ms ?? 250))
      continue
    }
    throw new Error(`Unsupported action: ${(action as { type: string }).type}`)
  }

  return { performed: actions.length, url: location.href, title: document.title }
}

export function classifyPageActions(actions: PageAction[]): {
  consequential: boolean
  summary: string
  details: string
} {
  const roots: Array<Document | ShadowRoot> = []
  const seen = new Set<Document | ShadowRoot>()
  const addRoot = (root: Document | ShadowRoot): void => {
    if (seen.has(root)) return
    seen.add(root)
    roots.push(root)
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.shadowRoot !== null) addRoot(element.shadowRoot)
      if (element.tagName.toLowerCase() === 'iframe') {
        try {
          const document = (element as HTMLIFrameElement).contentDocument
          if (document !== null) addRoot(document)
        } catch {
          // Cross-origin frames are intentionally skipped.
        }
      }
    }
  }
  addRoot(document)

  const elementFor = (ref: string | undefined): HTMLElement | null => {
    if (ref === undefined) return null
    const selector = `[data-barn-ref="${ref.replace(/[^a-zA-Z0-9_-]/g, '')}"]`
    for (const root of roots) {
      const element = root.querySelector<HTMLElement>(selector)
      if (element !== null) return element
    }
    return null
  }
  const formFor = (element: HTMLElement | null): HTMLFormElement | null => {
    if (element === null) return null
    const tag = element.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return (element as HTMLInputElement).form
    return element.closest('form')
  }

  let submitForm: HTMLFormElement | null = null
  let download = false
  for (const action of actions) {
    const element = elementFor(action.ref)
    if (action.type === 'type' && action.submit === true) submitForm = formFor(element)
    if (action.type === 'click' && element !== null) {
      const tag = element.tagName.toLowerCase()
      if (tag === 'button' && ((element as HTMLButtonElement).type === 'submit' || (element as HTMLButtonElement).form !== null)) {
        submitForm = (element as HTMLButtonElement).form
      }
      if (tag === 'input' && ['submit', 'image'].includes((element as HTMLInputElement).type)) {
        submitForm = (element as HTMLInputElement).form
      }
      if (tag === 'a' && element.hasAttribute('download')) download = true
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
