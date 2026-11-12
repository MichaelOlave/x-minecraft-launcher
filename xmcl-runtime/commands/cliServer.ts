import { formatCommandHelp, formatHelp, parseCli } from '@xmcl/runtime-api'
import type { CommandOutput } from '@xmcl/runtime-api'
import { chmod, unlink } from 'fs/promises'
import { createServer, Server, Socket } from 'net'
import { Logger } from '../infra'
import { BackendCommandHost } from './BackendCommandHost'
import {
  CLI_PROTOCOL_VERSION,
  ClientFrame,
  FrameDecoder,
  ServerFrame,
  createNonce,
  createProof,
  encodeFrame,
  getErrorExitCode,
  toErrorPayload,
  toJsonValue,
  verifyProof,
} from './cliProtocol'

export interface CliServerOptions {
  host: BackendCommandHost
  token: string
  launcherVersion: string
  logger?: Logger
  /** Same hook as the in-process CLI driver: fills host-only input such as the mod count. */
  enrichInput?: (commandId: string, input: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>
  programName?: string
  /** How long a connection may take to authenticate. */
  authTimeoutMs?: number
}

export interface CliServer {
  readonly server: Server
  listen(socketPath: string): Promise<void>
  close(): Promise<void>
}

/**
 * Serves commands typed in other terminals while this launcher runs. Each
 * connection authenticates once, then may run several commands concurrently.
 * Output, progress and events stream back as frames; closing the connection
 * cancels whatever it started.
 */
export function createCliServer(opts: CliServerOptions): CliServer {
  const { host, token, logger } = opts
  const programName = opts.programName ?? 'vardrynn'
  const sockets = new Set<Socket>()

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    const serverNonce = createNonce()
    const running = new Map<number, AbortController>()
    let authenticated = false

    const send = (frame: ServerFrame) => {
      if (!socket.destroyed && socket.writable) socket.write(encodeFrame(frame))
    }
    const fail = (code: string, message: string) => {
      send({ type: 'fatal', code, message })
      socket.end()
    }
    const authTimer = setTimeout(() => fail('AuthenticationTimeout', 'The client did not authenticate in time'), opts.authTimeoutMs ?? 10_000)

    const createOutput = (id: number): CommandOutput => ({
      log: (message) => send({ type: 'log', id, message: String(message) }),
      json: (payload) => send({ type: 'json', id, payload: toJsonValue(payload) }),
      table: (rows) => send({ type: 'table', id, rows: toJsonValue(rows) as Record<string, unknown>[] }),
      progress: (task, progress, total, message) => send({ type: 'progress', id, task, progress, total, message }),
      event: (event, data) => send({ type: 'event', id, event, data: toJsonValue(data) }),
    })

    const execute = async (id: number, commandId: string, input: Record<string, unknown>, cwd: string) => {
      const controller = new AbortController()
      running.set(id, controller)
      try {
        const enriched = opts.enrichInput ? await opts.enrichInput(commandId, { ...input }) : input
        const data = await host.dispatch(commandId, enriched, {
          mode: 'cli',
          out: createOutput(id),
          signal: controller.signal,
          cwd,
        })
        send({ type: 'result', id, ok: true, exitCode: 0, command: commandId, data: toJsonValue(data) })
      } catch (e) {
        if (!controller.signal.aborted) logger?.warn(`Command ${commandId} failed: ${(e as Error)?.message ?? e}`)
        send({ type: 'result', id, ok: false, exitCode: getErrorExitCode(e), command: commandId, error: toErrorPayload(e) })
      } finally {
        running.delete(id)
      }
    }

    const runArgv = async (id: number, argv: string[], cwd: string) => {
      const parsed = parseCli(argv, host.registry)
      const out = createOutput(id)
      switch (parsed.kind) {
        case 'none':
          send({ type: 'result', id, ok: false, exitCode: 2, error: { code: 'UsageError', message: 'No command given' } })
          return
        case 'help':
          out.log(formatHelp(host.registry, { programName }))
          send({ type: 'result', id, ok: true, exitCode: 0 })
          return
        case 'help-command': {
          const cmd = host.registry.get(parsed.commandId)
          if (cmd) out.log(formatCommandHelp(cmd, { programName }))
          send(cmd
            ? { type: 'result', id, ok: true, exitCode: 0, command: parsed.commandId }
            : { type: 'result', id, ok: false, exitCode: 2, command: parsed.commandId, error: { code: 'CommandNotFoundError', message: `Unknown command '${parsed.commandId}'` } })
          return
        }
        case 'version':
          out.log(host.app.version)
          send({ type: 'result', id, ok: true, exitCode: 0, data: host.app.version })
          return
        case 'error':
          send({ type: 'result', id, ok: false, exitCode: 2, command: parsed.commandId, error: { code: 'UsageError', message: parsed.message } })
          return
        case 'command':
          await execute(id, parsed.commandId, parsed.input, cwd)
      }
    }

    const isValidId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0

    const onFrame = (frame: ClientFrame) => {
      if (!authenticated) {
        if (frame.type !== 'hello' || frame.version !== CLI_PROTOCOL_VERSION || typeof frame.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(frame.nonce)) {
          fail('ProtocolMismatch', `Expected a version ${CLI_PROTOCOL_VERSION} hello`)
          return
        }
        if (!verifyProof(token, 'client', serverNonce, frame.proof)) {
          fail('Unauthorized', 'The client could not prove access to this launcher')
          return
        }
        authenticated = true
        clearTimeout(authTimer)
        send({ type: 'welcome', version: CLI_PROTOCOL_VERSION, proof: createProof(token, 'server', frame.nonce), launcher: opts.launcherVersion, pid: process.pid })
        return
      }
      switch (frame.type) {
        case 'run':
          if (!isValidId(frame.id) || running.has(frame.id) || !Array.isArray(frame.argv) || !frame.argv.every((a) => typeof a === 'string')) {
            fail('ProtocolError', 'Invalid run frame')
            return
          }
          void runArgv(frame.id, frame.argv, typeof frame.cwd === 'string' ? frame.cwd : process.cwd())
          return
        case 'call':
          if (!isValidId(frame.id) || running.has(frame.id) || typeof frame.command !== 'string') {
            fail('ProtocolError', 'Invalid call frame')
            return
          }
          void execute(frame.id, frame.command, (frame.input ?? {}) as Record<string, unknown>, typeof frame.cwd === 'string' ? frame.cwd : process.cwd())
          return
        case 'cancel':
          running.get(frame.id)?.abort()
          return
        default:
          fail('ProtocolError', 'Unknown frame')
      }
    }

    const decoder = new FrameDecoder(onFrame)
    socket.on('data', (chunk: string) => {
      try {
        decoder.push(chunk)
      } catch (e) {
        fail('ProtocolError', (e as Error).message)
        socket.destroy()
      }
    })
    socket.on('close', () => {
      clearTimeout(authTimer)
      sockets.delete(socket)
      for (const controller of running.values()) controller.abort()
      running.clear()
    })
    socket.on('error', () => { /* the close handler cleans up */ })

    send({ type: 'challenge', version: CLI_PROTOCOL_VERSION, nonce: serverNonce })
  })

  return {
    server,
    async listen(socketPath: string) {
      const isPipe = socketPath.startsWith('\\\\.\\pipe\\')
      // Only the launcher holding the single-instance lock serves commands, so a
      // leftover socket file can only come from one that exited uncleanly.
      if (!isPipe) await unlink(socketPath).catch(() => undefined)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      if (!isPipe) await chmod(socketPath, 0o600).catch(() => undefined)
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
    },
  }
}
