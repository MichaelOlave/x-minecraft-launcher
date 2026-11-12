import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { chmod, readFile, rename, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Wire protocol between a `vardrynn` command typed in a terminal and the
 * launcher that is already running.
 *
 * Frames are newline-delimited JSON. The server opens with a challenge, the
 * client proves it can read the launcher's private token file, and the server
 * proves the same back before the client sends a command. Neither side ever
 * sends the token itself, so a process squatting on the socket name learns
 * nothing it could replay.
 */
export const CLI_PROTOCOL_VERSION = 1

/** One frame may carry a whole table or diagnostics summary, but not unbounded data. */
export const MAX_FRAME_CHARS = 16 * 1024 * 1024

export interface CliErrorPayload {
  code: string
  message?: string
  issues?: unknown[]
}

export type ClientFrame =
  | { type: 'hello'; version: number; nonce: string; proof: string }
  /** Run a command line exactly as typed. The launcher parses it with its own command list. */
  | { type: 'run'; id: number; argv: string[]; cwd: string }
  /** Run a command by id with already-structured input. Used by commands that run in the terminal. */
  | { type: 'call'; id: number; command: string; input: unknown; cwd: string }
  | { type: 'cancel'; id: number }

export type CliResultFrame =
  | { type: 'result'; id: number; ok: true; exitCode: number; command?: string; data?: unknown }
  | { type: 'result'; id: number; ok: false; exitCode: number; command?: string; error: CliErrorPayload }

export type ServerFrame =
  | { type: 'challenge'; version: number; nonce: string }
  | { type: 'welcome'; version: number; proof: string; launcher: string; pid: number }
  | { type: 'fatal'; code: string; message: string }
  | { type: 'log'; id: number; message: string }
  | { type: 'json'; id: number; payload: unknown }
  | { type: 'table'; id: number; rows: Record<string, unknown>[] }
  | { type: 'progress'; id: number; task: string; progress: number; total?: number; message?: string }
  | { type: 'event'; id: number; event: string; data?: unknown }
  | CliResultFrame

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Splits a UTF-8 text stream into frames. Feed it strings from a socket with
 * `setEncoding('utf8')`, which already joins split multi-byte characters.
 */
export class FrameDecoder {
  #buffer = ''

  constructor(private readonly onFrame: (frame: any) => void, private readonly maxChars = MAX_FRAME_CHARS) {}

  /** @throws When a line is not JSON or a frame exceeds the size limit. */
  push(chunk: string) {
    this.#buffer += chunk
    let index: number
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index)
      this.#buffer = this.#buffer.slice(index + 1)
      if (!line.trim()) continue
      const frame = JSON.parse(line)
      if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
        throw new Error('Malformed frame')
      }
      this.onFrame(frame)
    }
    if (this.#buffer.length > this.maxChars) {
      throw new Error('Frame exceeds the size limit')
    }
  }
}

/**
 * The socket is per user and per launcher data folder. Unix socket paths are
 * limited to about 104 bytes, so long data paths fall back to the temp folder,
 * which is also private to the user on macOS.
 */
export function getCliSocketPath(appDataPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const hash = createHash('sha256').update(appDataPath.toLowerCase()).digest('hex').slice(0, 24)
    return `\\\\.\\pipe\\vardrynn-cli-${hash}`
  }
  const preferred = join(appDataPath, 'cli.sock')
  if (Buffer.byteLength(preferred) <= 100) return preferred
  const hash = createHash('sha256').update(appDataPath).digest('hex').slice(0, 24)
  return join(tmpdir(), `vardrynn-cli-${hash}.sock`)
}

export function getCliTokenPath(appDataPath: string) {
  return join(appDataPath, 'cli-token')
}

/** Write a fresh token readable only by the current user, replacing any earlier one atomically. */
export async function writeCliToken(tokenPath: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  const temporary = `${tokenPath}.${process.pid}.tmp`
  await writeFile(temporary, token, { mode: 0o600 })
  await chmod(temporary, 0o600).catch(() => undefined)
  await rename(temporary, tokenPath)
  return token
}

export async function readCliToken(tokenPath: string): Promise<string | undefined> {
  const token = await readFile(tokenPath, 'utf8').catch(() => '')
  return /^[0-9a-f]{64}$/.test(token.trim()) ? token.trim() : undefined
}

export function createNonce() {
  return randomBytes(16).toString('hex')
}

/** Proof that the sender knows the token, bound to the peer's nonce and the sender's role. */
export function createProof(token: string, role: 'client' | 'server', nonce: string) {
  return createHmac('sha256', token).update(`${role}:${nonce}`).digest('hex')
}

export function verifyProof(token: string, role: 'client' | 'server', nonce: string, proof: unknown) {
  if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false
  const expected = Buffer.from(createProof(token, role, nonce), 'hex')
  return timingSafeEqual(expected, Buffer.from(proof, 'hex'))
}

/** Exit status for a failed dispatch: usage problems are 2, a handler-chosen code wins, anything else is 1. */
export function getErrorExitCode(e: unknown): number {
  if (e && typeof e === 'object') {
    const exitCode = (e as { exitCode?: unknown }).exitCode
    if (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode > 0 && exitCode < 256) return exitCode
    const name = (e as { name?: unknown }).name
    if (name === 'ZodError' || name === 'CommandNotFoundError') return 2
  }
  return 1
}

export function toErrorPayload(e: unknown): CliErrorPayload {
  if (e && typeof e === 'object' && (e as { name?: unknown }).name === 'ZodError') {
    return { code: 'ValidationError', issues: (e as { issues?: unknown[] }).issues }
  }
  if (e instanceof Error) {
    return { code: e.name, message: e.message }
  }
  return { code: 'UnknownError', message: String(e) }
}

/** Command results cross the socket as JSON; anything that cannot be serialized is dropped. */
export function toJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}
