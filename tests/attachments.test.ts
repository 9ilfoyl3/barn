import { describe, expect, it } from 'vitest'
import { attachmentDisplayName, storedAttachmentFileName } from '../src/shared/attachments'

const ID = '9591d5dd-cd5d-497f-ab9a-255f015cbd2d'

describe('attachment presentation', () => {
  it('uses the original filename supplied by the attachment descriptor', () => {
    expect(attachmentDisplayName({
      name: '劳动合同.pdf',
      path: `/tmp/${ID}-劳动合同.pdf`,
    })).toBe('劳动合同.pdf')
  })

  it('recovers the original filename from internal storage paths', () => {
    expect(attachmentDisplayName({
      name: `${ID}.pdf`,
      path: `/tmp/${ID}-劳动合同.pdf`,
    })).toBe('劳动合同.pdf')
  })

  it('never exposes an opaque identifier as a filename', () => {
    expect(attachmentDisplayName({
      name: `${ID}.pdf`,
      path: `/tmp/${ID}.pdf`,
    })).toBe('Attachment.pdf')
  })

  it('keeps the original filename in the internal storage path', () => {
    expect(storedAttachmentFileName(ID, '../劳动合同.pdf')).toBe(`${ID}-劳动合同.pdf`)
  })
})
