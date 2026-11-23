import { useEffect } from 'react'
import { Toaster, toast } from 'sonner'
import './notifications.css'

export function AppToaster() {
  return (
    <Toaster
      gap={8}
      mobileOffset={16}
      offset={64}
      position="top-center"
      theme="system"
      toastOptions={{
        duration: 4_200,
        classNames: {
          toast: 'barn-toast',
          title: 'barn-toast-title',
          description: 'barn-toast-description',
          actionButton: 'barn-toast-action',
          cancelButton: 'barn-toast-cancel',
        },
      }}
      visibleToasts={3}
    />
  )
}

export function notifySuccess(message: string): void {
  toast.success(message)
}

export function notifyError(message: string): void {
  toast.error(message, { duration: 7_000 })
}

export function notifyInfo(message: string): void {
  toast(message)
}

export function useErrorToast(error: string | undefined): void {
  useEffect(() => {
    if (error !== undefined && error.trim().length > 0) notifyError(error)
  }, [error])
}
