const deniedPattern = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|SESSION|AUTH)/i

const allowedKeys = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
])

export function scrubbedShellEnvironment(
  source: NodeJS.ProcessEnv,
  privateTempRoot: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NO_COLOR: '1',
    TERM: 'dumb',
    TMPDIR: privateTempRoot,
    TEMP: privateTempRoot,
  }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !allowedKeys.has(key) || deniedPattern.test(key)) continue
    environment[key] = value
  }
  return environment
}
