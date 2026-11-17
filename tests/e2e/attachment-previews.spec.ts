import { strToU8, zipSync } from 'fflate'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'

test('renders loading placeholders and office document previews', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'barn-desktop-office-preview-e2e-'))
  const files = await createOfficeFixtures(userData)
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...inheritedEnv,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      BARN_USER_DATA_DIR: userData,
      BARN_UI_LANGUAGE: 'en',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog
    }, files)

    await page.getByRole('button', { name: 'Attach', exact: true }).click()
    await page.getByRole('button', { name: /Files and folders/ }).click()
    const strip = page.locator('.attachment-strip')
    await expect(strip).toBeVisible()
    await expect(page.locator('.attachment-card')).toHaveCount(4)
    await expect.poll(() => strip.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto')

    const pdf = page.locator('.attachment-card.attachment-pdf')
    const word = page.locator('.attachment-card.attachment-document')
    const slides = page.locator('.attachment-card.attachment-presentation')
    const sheet = page.locator('.attachment-card.attachment-spreadsheet')
    await expect(pdf.locator('.attachment-text-preview-pdf')).toContainText('PDF preview')
    await expect(word.locator('.attachment-text-preview-document')).toContainText('Word preview')
    await expect(slides.locator('.attachment-text-preview-presentation')).toContainText('Deck preview')
    await expect(sheet.locator('.attachment-text-preview-spreadsheet')).toContainText('Name')
    await expect.poll(() => page.locator('.attachment-text-preview').evaluateAll((previews) => previews.map((preview) => getComputedStyle(preview).borderTopWidth))).toEqual(['0px', '0px', '0px', '0px'])
    await expect(page.locator('.attachment-preview-loading')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/barn-office-attachment-previews.png', fullPage: true })
  } finally {
    await app.close()
  }
})

async function createOfficeFixtures(directory: string): Promise<string[]> {
  const pdf = join(directory, 'preview.pdf')
  const docx = join(directory, 'preview.docx')
  const pptx = join(directory, 'preview.pptx')
  const xlsx = join(directory, 'preview.xlsx')
  await Promise.all([
    writeFile(pdf, makePdf('PDF preview')),
    writeFile(docx, zip({
      'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Word preview</w:t></w:r></w:p></w:body></w:document>',
    })),
    writeFile(pptx, zip({
      'ppt/slides/slide1.xml': '<p:sld><a:t>Deck preview</a:t></p:sld>',
    })),
    writeFile(xlsx, zip({
      'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>',
    })),
  ])
  return [pdf, docx, pptx, xlsx]
}

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
