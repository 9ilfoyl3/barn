import { describe, expect, it } from 'vitest'
import { attachmentPreviewMode, attachmentVisualKind } from '../../src/renderer/AttachmentStrip'

function file(name: string, kind?: 'file' | 'directory') {
  return { name, path: `/tmp/${name}`, size: 0, ...(kind === undefined ? {} : { kind }) }
}

describe('attachmentVisualKind', () => {
  it('enables bounded previews only for image and text-like files', () => {
    expect(attachmentPreviewMode(file('photo.png'))).toBe('image')
    expect(attachmentPreviewMode(file('notes.md'))).toBe('text')
    expect(attachmentPreviewMode(file('data.csv'))).toBe('text')
    expect(attachmentPreviewMode(file('script.ts'))).toBe('text')
    expect(attachmentPreviewMode(file('document.pdf'))).toBe('office')
    expect(attachmentPreviewMode(file('brief.docx'))).toBe('office')
    expect(attachmentPreviewMode(file('deck.pptx'))).toBe('office')
    expect(attachmentPreviewMode(file('budget.xlsx'))).toBe('office')
    expect(attachmentPreviewMode(file('archive', 'directory'))).toBeUndefined()
  })

  it('distinguishes folders and common office file types', () => {
    expect(attachmentVisualKind(file('reference', 'directory'))).toBe('folder')
    expect(attachmentVisualKind(file('document.pdf'))).toBe('pdf')
    expect(attachmentVisualKind(file('brief.docx'))).toBe('document')
    expect(attachmentVisualKind(file('budget.xlsx'))).toBe('spreadsheet')
    expect(attachmentVisualKind(file('deck.pptx'))).toBe('presentation')
    expect(attachmentVisualKind(file('photo.png'))).toBe('image')
    expect(attachmentVisualKind(file('notes.md'))).toBe('text')
    expect(attachmentVisualKind(file('script.ts'))).toBe('code')
    expect(attachmentVisualKind(file('archive.zip'))).toBe('archive')
    expect(attachmentVisualKind(file('unknown.bin'))).toBe('file')
  })
})
