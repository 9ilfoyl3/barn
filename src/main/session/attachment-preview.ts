import { unzipSync, strFromU8 } from 'fflate'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extname } from 'node:path'

export type OfficePreviewVariant = 'plain' | 'pdf' | 'document' | 'presentation' | 'spreadsheet'

export interface TextAttachmentPreview {
  kind: 'text'
  text: string
  variant: OfficePreviewVariant
}

const MAX_PREVIEW_CHARS = 1_200

export async function documentPreview(path: string, data: Uint8Array): Promise<TextAttachmentPreview | undefined> {
  const extension = extname(path).toLowerCase()
  if (extension === '.pdf') {
    const text = await pdfText(data)
    return text === undefined ? undefined : { kind: 'text', text, variant: 'pdf' }
  }
  if (extension === '.docx') {
    const text = officeText(data, 'word/document.xml', 'document')
    return text === undefined ? undefined : { kind: 'text', text, variant: 'document' }
  }
  if (extension === '.pptx') {
    const text = presentationText(data)
    return text === undefined ? undefined : { kind: 'text', text, variant: 'presentation' }
  }
  if (extension === '.xlsx') {
    const text = spreadsheetText(data)
    return text === undefined ? undefined : { kind: 'text', text, variant: 'spreadsheet' }
  }
  return undefined
}

async function pdfText(data: Uint8Array): Promise<string | undefined> {
  const task = getDocument({
    data,
    useWorkerFetch: false,
    verbosity: 0,
  })
  const document = await task.promise
  try {
    const page = await document.getPage(1)
    const content = await page.getTextContent()
    const text = content.items
      .flatMap((item) => 'str' in item ? [item.str] : [])
      .join(' ')
    return normalizeText(text)
  } finally {
    await task.destroy()
  }
}

function officeText(data: Uint8Array, path: string, variant: OfficePreviewVariant): string | undefined {
  const files = unzipSync(data)
  const xml = files[path]
  if (xml === undefined) return undefined
  if (variant === 'document') {
    const paragraphs = strFromU8(xml)
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
    return normalizeText(stripXml(paragraphs))
  }
  return normalizeText(tagText(xml, 'a:t'))
}

function presentationText(data: Uint8Array): string | undefined {
  const files = unzipSync(data)
  const slides = Object.keys(files)
    .map((path) => ({ path, match: path.match(/^ppt\/slides\/slide(\d+)\.xml$/) }))
    .filter((item): item is { path: string; match: RegExpMatchArray } => item.match !== null)
    .toSorted((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .slice(0, 2)
  if (slides.length === 0) return undefined
  const text = slides.map((slide) => tagText(files[slide.path]!, 'a:t')).filter(Boolean).join('\n\n')
  return normalizeText(text)
}

function spreadsheetText(data: Uint8Array): string | undefined {
  const files = unzipSync(data)
  const sharedXml = files['xl/sharedStrings.xml']
  const shared = sharedXml === undefined
    ? []
    : [...strFromU8(sharedXml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
        .map((match) => stripXml(match[1] ?? ''))
  const sheetPath = Object.keys(files).find((path) => /^xl\/worksheets\/sheet1\.xml$/.test(path))
  if (sheetPath === undefined) return undefined
  const sheetData = files[sheetPath]
  if (sheetData === undefined) return undefined
  const sheet = strFromU8(sheetData)
  const rows = [...sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 8)
  const lines = rows.map((row) => {
    const cells = [...(row[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
    return cells.map((cell) => {
      const type = cell[1]?.match(/\bt="([^"]+)"/)?.[1]
      const value = stripXml(cell[2] ?? '').trim()
      if (type === 's') return shared[Number(value)] ?? ''
      return value
    }).join('\t')
  }).filter((line) => line.trim().length > 0)
  return normalizeText(lines.map((line) => line.split('\t').map((cell) => cell.trim()).join('\t')).join('\n'))
}

function tagText(xml: Uint8Array | string, tag: string): string {
  const value = typeof xml === 'string' ? xml : strFromU8(xml)
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g')
  return [...value.matchAll(pattern)].map((match) => stripXml(match[1] ?? '')).join(' ')
}

function stripXml(value: string): string {
  return decodeXml(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function normalizeText(value: string): string | undefined {
  const text = value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.length === 0 ? undefined : text.slice(0, MAX_PREVIEW_CHARS)
}
