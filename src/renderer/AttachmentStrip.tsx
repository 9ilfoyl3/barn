import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  File,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  Presentation,
  X,
} from 'lucide-react'
import type { AttachmentDescriptor, AttachmentPreview } from '../shared/models'
import { attachmentDisplayName } from '../shared/attachments'
import './attachment-strip.css'

export type AttachmentVisualKind =
  | 'folder'
  | 'image'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'text'
  | 'code'
  | 'file'

export function attachmentPreviewMode(file: Pick<AttachmentDescriptor, 'name' | 'path' | 'kind'>): 'image' | 'text' | undefined {
  const kind = attachmentVisualKind(file)
  if (kind === 'image') return 'image'
  const extension = attachmentExtension(file)
  if (kind === 'text' || kind === 'code' || ['csv', 'tsv', 'json'].includes(extension)) return 'text'
  return undefined
}

export function attachmentVisualKind(file: Pick<AttachmentDescriptor, 'name' | 'path' | 'kind'>): AttachmentVisualKind {
  if (file.kind === 'directory') return 'folder'
  const extension = attachmentExtension(file)
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'heic'].includes(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  if (['doc', 'docx', 'rtf', 'odt', 'pages'].includes(extension)) return 'document'
  if (['xls', 'xlsx', 'csv', 'tsv', 'ods', 'numbers'].includes(extension)) return 'spreadsheet'
  if (['ppt', 'pptx', 'key', 'odp'].includes(extension)) return 'presentation'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(extension)) return 'archive'
  if (['md', 'txt', 'log', 'rst'].includes(extension)) return 'text'
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'json', 'yaml', 'yml', 'sh', 'sql'].includes(extension)) return 'code'
  return 'file'
}

export function AttachmentStrip({
  files,
  onRemove,
}: {
  files: AttachmentDescriptor[]
  onRemove(path: string): void
}) {
  const { t } = useTranslation()
  return (
    <div className="attachment-strip" role="list" aria-label={t('attachments.selected')}>
      {files.map((file) => (
        <AttachmentCard key={file.path} file={file} onRemove={() => onRemove(file.path)} />
      ))}
    </div>
  )
}

function AttachmentCard({ file, onRemove }: { file: AttachmentDescriptor; onRemove(): void }) {
  const { t } = useTranslation()
  const kind = attachmentVisualKind(file)
  const name = attachmentDisplayName(file)
  const extension = attachmentExtension(file).toUpperCase()
  const [preview, setPreview] = useState<AttachmentPreview>()
  const previewMode = attachmentPreviewMode(file)

  useEffect(() => {
    if (previewMode === undefined) return
    let active = true
    void window.barn.sessions.getAttachmentPreview(file.path)
      .then((value) => { if (active) setPreview(value) })
      .catch(() => undefined)
    return () => { active = false }
  }, [file.path, previewMode])

  return (
    <article className={`attachment-card attachment-${kind}`} role="listitem" title={file.path}>
      <div className="attachment-preview">
        {preview?.kind === 'image'
          ? <img src={preview.dataUrl} alt="" />
          : preview?.kind === 'text'
            ? <pre className="attachment-text-preview">{preview.text}</pre>
            : <AttachmentIcon kind={kind} />}
        {kind !== 'folder' && extension.length > 0 && <span className="attachment-extension">{extension}</span>}
      </div>
      <div className="attachment-card-copy">
        <strong>{name}</strong>
        <small>{t(`attachments.kind.${kind}`)}</small>
      </div>
      <button
        className="attachment-remove"
        type="button"
        aria-label={t('conversation.removeAttachment', { name })}
        onClick={onRemove}
      >
        <X size={12} />
      </button>
    </article>
  )
}

function AttachmentIcon({ kind }: { kind: AttachmentVisualKind }) {
  switch (kind) {
    case 'folder': return <Folder size={30} strokeWidth={1.6} />
    case 'image': return <FileImage size={30} strokeWidth={1.6} />
    case 'pdf': return <FileText size={30} strokeWidth={1.6} />
    case 'document': return <FileText size={30} strokeWidth={1.6} />
    case 'spreadsheet': return <FileSpreadsheet size={30} strokeWidth={1.6} />
    case 'presentation': return <Presentation size={30} strokeWidth={1.6} />
    case 'archive': return <FileArchive size={30} strokeWidth={1.6} />
    case 'text': return <FileText size={30} strokeWidth={1.6} />
    case 'code': return <FileCode2 size={30} strokeWidth={1.6} />
    default: return <File size={30} strokeWidth={1.6} />
  }
}

function attachmentExtension(file: Pick<AttachmentDescriptor, 'name' | 'path'>): string {
  const name = attachmentDisplayName(file)
  const extension = name.match(/\.([^.]+)$/)?.[1]
  return extension?.toLowerCase() ?? ''
}
