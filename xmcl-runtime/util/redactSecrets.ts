export const REDACTED = '[redacted]'

/** Minecraft and launcher arguments whose next value is a credential. */
const SECRET_FLAGS = new Set(['--accessToken', '--session', '--xuid', '--clientId', '--userProperties', '--password'])

/** Names of settings and variables that hold credentials. */
const SENSITIVE_NAME = /(token|secret|passw(or)?d|credential|api[-_]?key|private[-_]?key|cookie|session|authorization)/i

/** Redact credential values from a command line, keeping its shape. */
export function redactArguments(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (SECRET_FLAGS.has(arg) && i + 1 < args.length) {
      out.push(arg, REDACTED)
      i++
      continue
    }
    const eq = arg.indexOf('=')
    if (eq > 0 && SENSITIVE_NAME.test(arg.slice(0, eq).replace(/^-+D?/, ''))) {
      out.push(`${arg.slice(0, eq)}=${REDACTED}`)
      continue
    }
    out.push(arg)
  }
  return out
}

/** Redact the values of environment variables whose names suggest credentials. */
export function redactEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    out[key] = SENSITIVE_NAME.test(key) ? REDACTED : value
  }
  return out
}

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  // Minecraft command-line credentials, in launcher output and process dumps.
  [/(--(?:accessToken|session|xuid|clientId|userProperties|password)(?:\s+|=))("[^"]*"|\S+)/g, `$1${REDACTED}`],
  // JSON or properties style: "accessToken": "…", refresh_token=…
  [/((?:["']?)(?:access|refresh|id|client|session)[-_]?token(?:["']?)\s*[:=]\s*["']?)([^"'\s,}&]+)/gi, `$1${REDACTED}`],
  // Signed tokens (JWT), such as Xbox and Minecraft services tokens.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  [/(\bAuthorization\s*[:=]\s*["']?)[^"'\r\n]+/gi, `$1${REDACTED}`],
  // Older Minecraft versions log the session.
  [/(Session ID is token:)[^:\s]+/g, `$1${REDACTED}`],
  // Environment dumps: GITHUB_TOKEN=…, DB_PASSWORD=…
  [/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=(\S+)/g, `$1=${REDACTED}`],
]

export interface RedactionResult {
  text: string
  /** How many values were replaced. */
  count: number
}

/**
 * Remove credentials from text meant to be shared: exact secret values the
 * caller knows, plus common token shapes. Optionally replaces the home
 * folder with `~` so paths do not reveal the account name.
 */
export function redactText(text: string, options: { secrets?: readonly string[]; home?: string } = {}): RedactionResult {
  let count = 0
  let out = text
  for (const secret of options.secrets ?? []) {
    if (!secret || secret.length < 8) continue
    const parts = out.split(secret)
    count += parts.length - 1
    out = parts.join(REDACTED)
  }
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    out = out.replace(pattern, (...match) => {
      count++
      return replacement.replace(/\$(\d)/g, (_, n: string) => String(match[Number(n)] ?? ''))
    })
  }
  if (options.home && options.home.length > 1) {
    out = out.split(options.home).join('~')
  }
  return { text: out, count }
}
