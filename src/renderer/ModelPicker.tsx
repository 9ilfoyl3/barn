import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Settings2,
} from 'lucide-react'
import {
  resolveReasoningEffort,
  type ModelConfigSnapshot,
  type ModelDescriptor,
  type ReasoningEffort,
} from '../shared/models'
import { SecondaryMenu } from './components/SecondaryMenu'
import { AnimatedStatusIcon } from './components/AnimatedStatusIcon'
import type { FloatingMenuSide } from './floating-menu'
import { useErrorToast } from './notifications'
import { Button } from './components/Button'

interface ModelPickerProps {
  snapshot: ModelConfigSnapshot | undefined
  onSnapshot(value: ModelConfigSnapshot): void
  onConfigure(): void
  onOpenChange?(open: boolean): void
  onBusyChange?(busy: boolean): void
}

interface OptimisticEffort {
  providerId: string
  modelId: string
  effort: ReasoningEffort
}

type PickerSection = 'model' | 'effort'

const SLIDER_THUMB_SIZE = 32
const SLIDER_TRACK_INSET = 4
const SLIDER_DOT_SIZE = 5
const SLIDER_DOT_PADDING = 4

export function ModelPicker({
  snapshot,
  onSnapshot,
  onConfigure,
  onOpenChange,
  onBusyChange,
}: ModelPickerProps) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<PickerSection>()
  const [submenuSide, setSubmenuSide] = useState<FloatingMenuSide>('right')
  const [models, setModels] = useState<ModelDescriptor[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [busyKey, setBusyKey] = useState<string>()
  const [optimisticEffort, setOptimisticEffort] = useState<OptimisticEffort>()
  const [previewEffort, setPreviewEffort] = useState<ReasoningEffort>()

  useErrorToast(error)

  const providerNames = useMemo(
    () => new Map((snapshot?.providers ?? []).map((provider) => [provider.id, provider.name])),
    [snapshot?.providers],
  )
  const activeModel = models.find((model) => (
    model.providerId === snapshot?.defaultModel?.providerId
    && model.id === snapshot?.defaultModel?.modelId
  ))
  const resolvedEffort = resolveReasoningEffort(
    snapshot?.defaultReasoningEffort,
    activeModel?.reasoningEfforts ?? [],
  )
  const selectedEffort = optimisticEffort !== undefined
    && optimisticEffort.providerId === snapshot?.defaultModel?.providerId
    && optimisticEffort.modelId === snapshot?.defaultModel?.modelId
    ? optimisticEffort.effort
    : activeModel === undefined
      ? snapshot?.defaultReasoningEffort
      : resolvedEffort
  const activeEffort = previewEffort ?? selectedEffort
  const activeProviderName = snapshot?.defaultModel === undefined
    ? undefined
    : providerNames.get(snapshot.defaultModel.providerId)
  const modelLabel = activeModel?.name
    ?? snapshot?.defaultModel?.modelId
    ?? t('settings.chooseModel')
  const hasEffortChoices = activeModel !== undefined && activeModel.reasoningEfforts.length > 0
  const defaultEffort = activeModel === undefined
    ? undefined
    : resolveReasoningEffort(undefined, activeModel.reasoningEfforts)
  const effortLabel = activeEffort === undefined
    ? hasEffortChoices
      ? t('modelPicker.notSelected')
      : t('modelPicker.notSupported')
    : t(`settings.efforts.${activeEffort}`)
  const closePicker = useCallback((): void => {
    setOpen(false)
    setSection(undefined)
    setPreviewEffort(undefined)
    onOpenChange?.(false)
  }, [onOpenChange])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)
    void window.barn.models.getConfiguredModels()
      .then((value) => {
        if (!active) return
        setModels(sortModels(value, providerNames))
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, t))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open, providerNames, snapshot])

  useEffect(() => {
    if (section === 'effort' && !hasEffortChoices) setSection(undefined)
  }, [hasEffortChoices, section])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: globalThis.PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (submenuRef.current?.contains(event.target as Node) === true) return
      closePicker()
    }
    const closeOnOutsideFocus = (event: globalThis.FocusEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (submenuRef.current?.contains(event.target as Node) === true) return
      closePicker()
    }
    const closeOnWindowBlur = (): void => {
      closePicker()
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      closePicker()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('focusin', closeOnOutsideFocus)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('blur', closeOnWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('focusin', closeOnOutsideFocus)
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('blur', closeOnWindowBlur)
    }
  }, [closePicker, open])

  useEffect(() => {
    if (optimisticEffort === undefined) return
    if (snapshot?.defaultReasoningEffort === optimisticEffort.effort) setOptimisticEffort(undefined)
  }, [optimisticEffort, snapshot?.defaultReasoningEffort])

  useEffect(() => {
    onBusyChange?.(busyKey !== undefined)
  }, [busyKey, onBusyChange])

  function toggleOpen(): void {
    const next = !open
    setOpen(next)
    setSection(undefined)
    setSubmenuSide('right')
    setPreviewEffort(undefined)
    onOpenChange?.(next)
  }

  function chooseSection(next: PickerSection): void {
    if (next === 'effort' && !hasEffortChoices) return
    setSection(next)
  }

  async function selectModel(model: ModelDescriptor): Promise<void> {
    if (busyKey !== undefined) return
    const sameModel = snapshot?.defaultModel?.providerId === model.providerId
      && snapshot.defaultModel.modelId === model.id
    const preferred = sameModel ? snapshot.defaultReasoningEffort : undefined
    const effort = resolveReasoningEffort(preferred, model.reasoningEfforts)
    if (sameModel && effort === activeEffort) return
    if (effort !== undefined) {
      setOptimisticEffort({
        providerId: model.providerId,
        modelId: model.id,
        effort,
      })
    }
    const key = modelKey(model)
    setBusyKey(key)
    setError(undefined)
    try {
      onSnapshot(await window.barn.models.setDefault({
        providerId: model.providerId,
        modelId: model.id,
        reasoningEffort: effort,
      }))
    } catch (reason) {
      setOptimisticEffort(undefined)
      setError(errorMessage(reason, t))
    } finally {
      setBusyKey(undefined)
    }
  }

  async function selectEffort(effort: ReasoningEffort): Promise<void> {
    const model = activeModel
    if (model === undefined || busyKey !== undefined || effort === resolvedEffort) {
      setPreviewEffort(undefined)
      return
    }
    setOptimisticEffort({
      providerId: model.providerId,
      modelId: model.id,
      effort,
    })
    const key = `effort:${modelKey(model)}:${effort}`
    setBusyKey(key)
    setError(undefined)
    try {
      onSnapshot(await window.barn.models.setDefault({
        providerId: model.providerId,
        modelId: model.id,
        reasoningEffort: effort,
      }))
    } catch (reason) {
      setOptimisticEffort(undefined)
      setError(errorMessage(reason, t))
    } finally {
      setBusyKey(undefined)
      setPreviewEffort(undefined)
    }
  }

  return (
    <div className="model-picker" ref={rootRef}>
      <Button
        className={open ? 'composer-model active' : 'composer-model'}
        type="button"
        aria-haspopup="dialog"
        aria-controls="composer-model-picker"
        aria-expanded={open}
        title={activeProviderName === undefined ? modelLabel : `${activeProviderName} · ${modelLabel}`}
        onClick={toggleOpen}
      >
        <strong>{modelLabel}</strong>
        {activeEffort !== undefined && <em>{t(`settings.efforts.${activeEffort}`)}</em>}
        <ChevronDown className="composer-model-chevron" size={12} />
      </Button>

      <div
        id="composer-model-picker"
        className={`model-popover${open ? ' open' : ''}${section === undefined ? '' : ` show-${section}`}`}
        role="dialog"
        aria-label={t('modelPicker.title')}
        aria-hidden={!open}
        inert={!open}
      >
        <div ref={menuRef} className="model-picker-menu" role="menu" aria-label={t('modelPicker.title')}>
          <Button
            className={section === 'model' ? 'model-picker-menu-row active' : 'model-picker-menu-row'}
            type="button"
            role="menuitem"
            aria-expanded={section === 'model'}
            onMouseEnter={() => chooseSection('model')}
            onFocus={() => chooseSection('model')}
            onClick={() => chooseSection('model')}
          >
            <span>{t('modelPicker.model')}</span>
            <strong>{modelLabel}</strong>
            {submenuSide === 'right' ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </Button>
          <Button
            className={section === 'effort' ? 'model-picker-menu-row active' : 'model-picker-menu-row'}
            type="button"
            role="menuitem"
            aria-expanded={section === 'effort'}
            disabled={!hasEffortChoices}
            onMouseEnter={() => chooseSection('effort')}
            onFocus={() => chooseSection('effort')}
            onClick={() => chooseSection('effort')}
          >
            <span>{t('modelPicker.effort')}</span>
            <strong>{effortLabel}</strong>
            {submenuSide === 'right' ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </Button>
        </div>

        <SecondaryMenu
          ref={submenuRef}
          open={open && section !== undefined}
          anchor={menuRef}
          className={`model-picker-submenu ${section}`}
          key={section}
          role="dialog"
          ariaLabel={section === 'effort' ? t('modelPicker.effort') : t('modelPicker.title')}
          onSideChange={setSubmenuSide}
        >
          {section === 'model' ? (
            <>
              <div className="model-picker-list-heading">{t('modelPicker.chooseModel')}</div>

              <div className="model-options" role="listbox" aria-label={t('modelPicker.title')}>
                {loading && models.length === 0 ? (
                  <div className="model-picker-message">
                    <AnimatedStatusIcon name="loading" size={14} />
                    {t('modelPicker.loading')}
                  </div>
                ) : models.length === 0 ? (
                  <div className="model-picker-empty">
                    <strong>{t('modelPicker.noConfiguredModels')}</strong>
                    <Button type="button" onClick={onConfigure}>
                      <Settings2 size={13} />
                      {t('modelPicker.configure')}
                    </Button>
                  </div>
                ) : (
                  models.map((model) => {
                    const active = snapshot?.defaultModel?.providerId === model.providerId
                      && snapshot.defaultModel.modelId === model.id
                    const busy = busyKey === modelKey(model)
                    return (
                      <Button
                        className={active ? 'model-option active' : 'model-option'}
                        type="button"
                        role="option"
                        aria-selected={active}
                        key={modelKey(model)}
                        disabled={busyKey !== undefined}
                        {...(busy ? { state: 'loading' as const, loadingText: model.name } : {})}
                        onClick={() => void selectModel(model)}
                      >
                        <span>{model.name}</span>
                        {active ? <Check size={15} /> : null}
                      </Button>
                    )
                  })
                )}
              </div>

            </>
          ) : (
            <div className="effort-card">
              <div className="effort-card-header">
                <div className="effort-card-title">
                  <strong>
                    {effortLabel}
                    {busyKey?.startsWith('effort:') === true && <AnimatedStatusIcon name="loading" size={13} />}
                  </strong>
                </div>
                <Button
                  className="effort-reset"
                  type="button"
                  aria-label={t('modelPicker.resetEffort')}
                  title={t('modelPicker.resetEffort')}
                  disabled={busyKey !== undefined || defaultEffort === undefined || defaultEffort === activeEffort}
                  state={busyKey?.startsWith('effort:') === true ? 'loading' : 'idle'}
                  loadingText=""
                  onClick={() => defaultEffort !== undefined && void selectEffort(defaultEffort)}
                >
                  <RotateCcw size={17} />
                </Button>
              </div>
              <p className="effort-card-model" title={modelLabel}>{modelLabel}</p>

              {activeModel !== undefined && activeModel.reasoningEfforts.length > 0 ? (
                <EffortSlider
                  efforts={activeModel.reasoningEfforts}
                  value={selectedEffort}
                  disabled={busyKey !== undefined}
                  onPreview={setPreviewEffort}
                  onChange={(effort) => void selectEffort(effort)}
                />
              ) : (
                <div className="effort-card-empty">{t('modelPicker.notSupported')}</div>
              )}
            </div>
          )}
        </SecondaryMenu>
      </div>
    </div>
  )
}

interface EffortSliderProps {
  efforts: ReasoningEffort[]
  value: ReasoningEffort | undefined
  disabled: boolean
  onPreview(effort: ReasoningEffort | undefined): void
  onChange(effort: ReasoningEffort): void
}

function EffortSlider({
  efforts,
  value,
  disabled,
  onPreview,
  onChange,
}: EffortSliderProps) {
  const { t } = useTranslation()
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const [dragIndex, setDragIndex] = useState<number>()
  const selectedIndex = Math.max(0, value === undefined ? 0 : efforts.indexOf(value))
  const displayIndex = dragIndex ?? selectedIndex
  const fraction = efforts.length <= 1 ? 0.5 : displayIndex / (efforts.length - 1)
  const thumbOffset = SLIDER_THUMB_SIZE / 2 + SLIDER_TRACK_INSET
    - fraction * (SLIDER_THUMB_SIZE + SLIDER_TRACK_INSET * 2)
  const fillWidth = fraction <= 0
    ? '0px'
    : fraction >= 1
      ? '100%'
      : `calc(${fraction * 100}% + ${thumbOffset + SLIDER_DOT_SIZE / 2 + SLIDER_DOT_PADDING}px)`

  function indexFromPointer(clientX: number): number {
    const bounds = trackRef.current?.getBoundingClientRect()
    if (bounds === undefined || bounds.width <= 0) return displayIndex
    const edgeInset = SLIDER_THUMB_SIZE / 2 + SLIDER_TRACK_INSET
    const usableWidth = Math.max(1, bounds.width - edgeInset * 2)
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left - edgeInset) / usableWidth))
    return Math.round(ratio * Math.max(0, efforts.length - 1))
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>): void {
    if (disabled || efforts.length === 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    draggingRef.current = true
    const index = indexFromPointer(event.clientX)
    setDragging(true)
    setDragIndex(index)
    onPreview(efforts[index])
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return
    const index = indexFromPointer(event.clientX)
    if (index === dragIndex) return
    setDragIndex(index)
    onPreview(efforts[index])
  }

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    if (!draggingRef.current) return
    draggingRef.current = false
    const index = indexFromPointer(event.clientX)
    const effort = efforts[index]
    setDragging(false)
    setDragIndex(undefined)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onPreview(undefined)
    if (effort !== undefined && effort !== value) onChange(effort)
  }

  function cancelDrag(event: PointerEvent<HTMLDivElement>): void {
    draggingRef.current = false
    setDragging(false)
    setDragIndex(undefined)
    onPreview(undefined)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled || efforts.length === 0) return
    let nextIndex: number | undefined
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      nextIndex = Math.max(0, selectedIndex - 1)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      nextIndex = Math.min(efforts.length - 1, selectedIndex + 1)
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = efforts.length - 1
    }
    if (nextIndex === undefined) return
    event.preventDefault()
    const effort = efforts[nextIndex]
    if (effort !== undefined) onChange(effort)
  }

  return (
    <div
      ref={trackRef}
      className={dragging ? 'effort-slider dragging' : 'effort-slider'}
      role="slider"
      aria-label={t('modelPicker.effort')}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, efforts.length - 1)}
      aria-valuenow={displayIndex}
      aria-valuetext={efforts[displayIndex] === undefined ? '' : t(`settings.efforts.${efforts[displayIndex]}`)}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={cancelDrag}
      onKeyDown={handleKeyDown}
    >
      <span
        className="effort-slider-fill"
        style={{ width: fillWidth }}
        aria-hidden="true"
      />
      {efforts.map((effort, index) => {
        const pointFraction = efforts.length <= 1 ? 0.5 : index / (efforts.length - 1)
        const pointOffset = SLIDER_THUMB_SIZE / 2 + SLIDER_TRACK_INSET
          - pointFraction * (SLIDER_THUMB_SIZE + SLIDER_TRACK_INSET * 2)
        return (
          <span
            className={index <= displayIndex ? 'effort-slider-dot passed' : 'effort-slider-dot'}
            style={{ left: `calc(${pointFraction * 100}% + ${pointOffset}px)` }}
            title={t(`settings.efforts.${effort}`)}
            key={effort}
            aria-hidden="true"
          />
        )
      })}
      <span
        className="effort-slider-thumb"
        style={{ left: `calc(${fraction * 100}% + ${thumbOffset}px)` }}
        aria-hidden="true"
      />
    </div>
  )
}

function sortModels(
  models: ModelDescriptor[],
  providerNames: Map<string, string>,
): ModelDescriptor[] {
  return models.toSorted((left, right) => {
    const providerOrder = (providerNames.get(left.providerId) ?? left.providerId)
      .localeCompare(providerNames.get(right.providerId) ?? right.providerId)
    return providerOrder === 0 ? left.name.localeCompare(right.name) : providerOrder
  })
}

function modelKey(model: Pick<ModelDescriptor, 'providerId' | 'id'>): string {
  return `${model.providerId}:${model.id}`
}

function errorMessage(
  reason: unknown,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const translate = t as (key: string) => string
  return reason instanceof Error ? reason.message : translate('modelPicker.loadFailed')
}
