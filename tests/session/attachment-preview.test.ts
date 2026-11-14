import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { documentPreview } from '../../src/main/session/attachment-preview'

describe('documentPreview', () => {
  it('extracts text from a PDF first page', async () => {
    const preview = await documentPreview('sample.pdf', makePdf('Hello PDF preview'))
    expect(preview).toEqual({
      kind: 'text',
      variant: 'pdf',
      text: 'Hello PDF preview',
    })
  })

  it('extracts DOCX paragraphs', async () => {
    const preview = await documentPreview('sample.docx', zip({
      'word/document.xml': `<w:document><w:body>
        <w:p><w:r><w:t>Project brief</w:t></w:r></w:p>
        <w:p><w:r><w:t>First decision</w:t></w:r></w:p>
      </w:body></w:document>`,
    }))
    expect(preview).toMatchObject({ kind: 'text', variant: 'document' })
    expect(preview?.text).toContain('Project brief')
    expect(preview?.text).toContain('First decision')
  })

  it('extracts PPTX slide text', async () => {
    const preview = await documentPreview('sample.pptx', zip({
      'ppt/slides/slide1.xml': '<p:sld><a:t>Quarterly review</a:t><a:t>Revenue grew</a:t></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:t>Next steps</a:t></p:sld>',
    }))
    expect(preview).toMatchObject({ kind: 'text', variant: 'presentation' })
    expect(preview?.text).toContain('Quarterly review')
    expect(preview?.text).toContain('Next steps')
  })

  it('extracts spreadsheet rows from shared strings', async () => {
    const preview = await documentPreview('sample.xlsx', zip({
      'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Alice</t></si><si><t>Status</t></si><si><t>Ready</t></si></sst>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
        <row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>
        <row><c t="s"><v>2</v></c><c t="s"><v>3</v></c></row>
      </sheetData></worksheet>`,
    }))
    expect(preview).toEqual({
      kind: 'text',
      variant: 'spreadsheet',
      text: 'Name\tAlice\nStatus\tReady',
    })
  })

  it('returns no preview for legacy binary Office formats', async () => {
    expect(await documentPreview('sample.doc', new Uint8Array([1, 2, 3]))).toBeUndefined()
  })
})

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])))
}

function makePdf(text: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(`BT /F1 14 Tf 30 150 Td (${text}) Tj ET`)} >>\nstream\nBT /F1 14 Tf 30 150 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return strToU8(output)
}
