import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const mainRoot = join(root, 'src', 'main')

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

export async function verifyIpcSecurity(): Promise<string[]> {
  const errors: string[] = []
  for (const path of await sourceFiles(mainRoot)) {
    const lines = (await readFile(path, 'utf8')).split('\n')
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index]?.includes('ipcMain.handle(')) continue
      const block = lines.slice(index, index + 18).join('\n')
      if (!/requireTrusted\(|guard\(|isTrustedSender/.test(block)) {
        errors.push(`${relative(root, path)}:${index + 1}: IPC handler has no visible trusted-sender guard`)
      }
    }
  }
  return errors
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const errors = await verifyIpcSecurity()
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Every IPC handler has a trusted-sender guard.')
  }
}
