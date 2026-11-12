import { CliExitCode, CommandRegistry, ParsedCli, formatCommandHelp, formatHelp } from '@xmcl/runtime-api'
import { connect, Socket } from 'net'
import { setTimeout as delay } from 'timers/promises'
import {
  CLI_PROTOCOL_VERSION,
  CliErrorPayload,
  CliResultFrame,
  ClientFrame,
  FrameDecoder,
  ServerFrame,
  createNonce,
  createProof,
  encodeFrame,
  readCliToken,
  verifyProof,
} from './cliProtocol'

export interface CliRequestHandlers {
  onLog?(message: string): void
  onJson?(payload: unknown): void
  onTable?(rows: Record<string, unknown>[]): void
  onProgress?(task: string, progress: number, total?: number, message?: string): void
  onEvent?(event: string, data: unknown): void
}

export class CliConnectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CliConnectionError'
  }
}

interface Pending {
  handlers: CliRequestHandlers
  resolve(frame: CliResultFrame): void
  reject(error: Error): void
}

/**
 * An authenticated connection to the running launcher. Several requests may
 * be in flight at once; each gets its own output stream and result.
 */
export class CliConnection {
  #nextId = 1
  #pending = new Map<number, Pending>()
  #closed = false

  private constructor(private readonly socket: Socket, readonly launcherVersion: string, readonly launcherPid: number) {}

  /**
   * Connect and run the handshake. Rejects with `CliConnectionError` code
   * `Unavailable` when nothing is listening, so callers can start a launcher.
   */
  static connect(socketPath: string, token: string, timeoutMs = 10_000): Promise<CliConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath)
      socket.setEncoding('utf8')
      const clientNonce = createNonce()
      let connection: CliConnection | undefined
      let settled = false
      const settle = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          socket.destroy()
          reject(error)
        } else {
          resolve(connection!)
        }
      }
      const timer = setTimeout(() => settle(new CliConnectionError('Timeout', 'Vardrynn did not answer the command connection in time')), timeoutMs)

      const decoder = new FrameDecoder((frame: ServerFrame) => {
        if (connection) {
          connection.#onFrame(frame)
          return
        }
        if (frame.type === 'challenge') {
          if (frame.version !== CLI_PROTOCOL_VERSION) {
            settle(new CliConnectionError('ProtocolMismatch', `This command line speaks protocol ${CLI_PROTOCOL_VERSION}, but the running Vardrynn speaks ${frame.version}. Update or restart Vardrynn.`))
            return
          }
          const hello: ClientFrame = { type: 'hello', version: CLI_PROTOCOL_VERSION, nonce: clientNonce, proof: createProof(token, 'client', frame.nonce) }
          socket.write(encodeFrame(hello))
        } else if (frame.type === 'welcome') {
          if (!verifyProof(token, 'server', clientNonce, frame.proof)) {
            settle(new CliConnectionError('Unauthorized', 'The process answering on the Vardrynn command socket could not prove it is Vardrynn'))
            return
          }
          connection = new CliConnection(socket, frame.launcher, frame.pid)
          settle()
        } else if (frame.type === 'fatal') {
          settle(new CliConnectionError(frame.code, frame.message))
        }
      })
      socket.on('data', (chunk: string) => {
        try {
          decoder.push(chunk)
        } catch (e) {
          if (connection) connection.#fail(new CliConnectionError('ProtocolError', (e as Error).message))
          else settle(new CliConnectionError('ProtocolError', (e as Error).message))
        }
      })
      socket.on('error', (e: NodeJS.ErrnoException) => {
        const unavailable = e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'EPIPE' || e.code === 'ECONNRESET'
        const error = new CliConnectionError(unavailable ? 'Unavailable' : 'ConnectionError', e.message)
        if (connection) connection.#fail(error)
        else settle(error)
      })
      socket.on('close', () => {
        if (connection) connection.#fail(new CliConnectionError('Disconnected', 'Vardrynn closed the command connection'))
        else settle(new CliConnectionError('Unavailable', 'Vardrynn closed the command connection'))
      })
    })
  }

  #onFrame(frame: ServerFrame) {
    if (frame.type === 'fatal') {
      this.#fail(new CliConnectionError(frame.code, frame.message))
      return
    }
    if (!('id' in frame)) return
    const pending = this.#pending.get(frame.id)
    if (!pending) return
    const h = pending.handlers
    switch (frame.type) {
      case 'log': h.onLog?.(frame.message); break
      case 'json': h.onJson?.(frame.payload); break
      case 'table': h.onTable?.(frame.rows); break
      case 'progress': h.onProgress?.(frame.task, frame.progress, frame.total, frame.message); break
      case 'event': h.onEvent?.(frame.event, frame.data); break
      case 'result':
        this.#pending.delete(frame.id)
        pending.resolve(frame)
        break
    }
  }

  #fail(error: Error) {
    if (this.#closed) return
    this.#closed = true
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.socket.destroy()
  }

  #request(make: (id: number) => ClientFrame, handlers: CliRequestHandlers, signal?: AbortSignal): Promise<CliResultFrame> {
    if (this.#closed) return Promise.reject(new CliConnectionError('Disconnected', 'The command connection is closed'))
    const id = this.#nextId++
    return new Promise<CliResultFrame>((resolve, reject) => {
      const onAbort = () => this.cancel(id)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, {
        handlers,
        resolve: (frame) => { signal?.removeEventListener('abort', onAbort); resolve(frame) },
        reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error) },
      })
      this.socket.write(encodeFrame(make(id)))
      if (signal?.aborted) onAbort()
    })
  }

  /** Run a command line as typed; the launcher parses it. */
  run(argv: string[], cwd: string, handlers: CliRequestHandlers = {}, signal?: AbortSignal) {
    return this.#request((id) => ({ type: 'run', id, argv, cwd }), handlers, signal)
  }

  /** Run a command by id with structured input. */
  call(command: string, input: unknown, cwd: string, handlers: CliRequestHandlers = {}, signal?: AbortSignal) {
    return this.#request((id) => ({ type: 'call', id, command, input, cwd }), handlers, signal)
  }

  cancel(id: number) {
    if (!this.#closed && this.#pending.has(id)) this.socket.write(encodeFrame({ type: 'cancel', id }))
  }

  get activeRequests() {
    return this.#pending.size
  }

  /** Close the connection. The launcher cancels anything still running; pending calls reject. */
  close() {
    if (this.#closed) return
    this.#closed = true
    const error = new CliConnectionError('Disconnected', 'The command connection was closed')
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.socket.end()
  }
}

/** Throws a `CommandExitError`-shaped error for a failed call, so callers can rethrow it. */
export function unwrapResult<T = unknown>(frame: CliResultFrame): T {
  if (frame.ok) return frame.data as T
  const error = new Error(frame.error.message ?? frame.error.code) as Error & { exitCode: number; code: string; issues?: unknown[] }
  error.name = frame.error.code
  error.code = frame.error.code
  error.exitCode = frame.exitCode
  error.issues = frame.error.issues
  throw error
}

export interface TextSink {
  write(text: string): unknown
}

export interface TerminalRenderer extends CliRequestHandlers {
  /** Print the final status of a request, in the format the user asked for. */
  result(frame: CliResultFrame): void
  /** Print an error raised in the terminal process itself. */
  error(command: string | undefined, error: CliErrorPayload): void
  /** Clear any in-place progress line. */
  flush(): void
}

/**
 * Human mode prints logs and tables on stdout and progress on stderr.
 * `--json` mode keeps stdout machine-readable: one JSON object per line
 * (the command's own envelopes, plus `type: "progress"` and `type: "event"`
 * lines), with human logs moved to stderr.
 */
export function createTerminalRenderer(opts: { json: boolean; command?: string; stdout: TextSink; stderr: TextSink; isTTY: boolean }): TerminalRenderer {
  const { json, stdout, stderr, isTTY } = opts
  let progressLine = false
  let lastProgress = ''
  const clearProgress = () => {
    if (progressLine) {
      stderr.write('\r\x1b[2K')
      progressLine = false
    }
  }
  const printError = (command: string | undefined, error: CliErrorPayload) => {
    clearProgress()
    if (json) {
      stdout.write(`${JSON.stringify({ ok: false, command, error })}\n`)
      return
    }
    if (error.issues?.length) {
      stderr.write(`Invalid input for '${command}':\n`)
      for (const issue of error.issues as Array<{ path?: unknown[]; message?: string }>) {
        stderr.write(`  ${issue.path?.join('.') || '(root)'}: ${issue.message}\n`)
      }
      return
    }
    stderr.write(`${error.code}: ${error.message ?? ''}\n`)
  }
  return {
    onLog(message) {
      clearProgress()
      ;(json ? stderr : stdout).write(`${message}\n`)
    },
    onJson(payload) {
      if (!json) return
      clearProgress()
      stdout.write(`${JSON.stringify(payload)}\n`)
    },
    onTable(rows) {
      if (rows.length === 0) return
      clearProgress()
      const sink = json ? stderr : stdout
      const cols = Object.keys(rows[0])
      sink.write(`${cols.join('\t')}\n`)
      for (const r of rows) sink.write(`${cols.map((c) => String(r[c] ?? '')).join('\t')}\n`)
    },
    onProgress(task, progress, total, message) {
      if (json) {
        stdout.write(`${JSON.stringify({ type: 'progress', command: opts.command, task, progress, total, message })}\n`)
        return
      }
      const text = `[${task}] ${total ? `${progress}/${total}` : progress}${message ? ` ${message}` : ''}`
      if (isTTY) {
        stderr.write(`\r\x1b[2K${text}`)
        progressLine = true
      } else if (text !== lastProgress && (message !== undefined || progress === total)) {
        stderr.write(`${text}\n`)
      }
      lastProgress = text
    },
    onEvent(event, data) {
      if (!json) return
      clearProgress()
      stdout.write(`${JSON.stringify({ type: 'event', command: opts.command, event, data })}\n`)
    },
    result(frame) {
      clearProgress()
      if (!frame.ok) printError(frame.command ?? opts.command, frame.error)
    },
    error: printError,
    flush: clearProgress,
  }
}

export interface LauncherProcess {
  /** Resolves with the exit code if the started process exits on its own. */
  exited: Promise<number | null>
}

export interface ConnectOptions {
  socketPath: string
  tokenPath: string
  /** Start a launcher in the background. Called at most once, only when none answers. */
  startLauncher?: () => LauncherProcess
  /** Total time to wait for a started launcher. */
  startTimeoutMs?: number
  /** Called once when a launcher is being started, to tell the user. */
  onStarting?: () => void
}

/**
 * Connect to the running launcher, starting one in the background when none
 * answers. A started process that exits straight away lost the single-instance
 * lock to a launcher that is still booting, or to an older version without the
 * command server; wait briefly for the former, then report the latter.
 */
export async function connectToLauncher(opts: ConnectOptions): Promise<CliConnection> {
  const attempt = async () => {
    const token = await readCliToken(opts.tokenPath)
    if (!token) throw new CliConnectionError('Unavailable', 'No command token yet')
    return CliConnection.connect(opts.socketPath, token)
  }
  try {
    return await attempt()
  } catch (e) {
    if (!(e instanceof CliConnectionError) || e.code !== 'Unavailable' || !opts.startLauncher) throw e
  }

  opts.onStarting?.()
  const launcher = opts.startLauncher()
  let exitedAt: number | undefined
  void launcher.exited.then(() => { exitedAt = Date.now() })
  const deadline = Date.now() + (opts.startTimeoutMs ?? 120_000)
  while (Date.now() < deadline) {
    await delay(250)
    try {
      return await attempt()
    } catch (e) {
      if (!(e instanceof CliConnectionError) || e.code !== 'Unavailable') throw e
    }
    if (exitedAt !== undefined && Date.now() - exitedAt > 20_000) {
      throw new CliConnectionError('Unavailable', 'Another Vardrynn is open but does not accept terminal commands. It may be an older version: quit it and run the command again.')
    }
  }
  throw new CliConnectionError('Unavailable', 'Vardrynn did not start its command server in time. See its logs for details.')
}

export interface ClientCommandContext {
  connection: CliConnection
  parsed: Extract<ParsedCli, { kind: 'command' }>
  cwd: string
  renderer: TerminalRenderer
  stdout: TextSink
  stderr: TextSink
  signal: AbortSignal
}

/** A command that runs in the terminal process and calls the launcher for its parts. Returns the exit code. */
export type ClientCommand = (ctx: ClientCommandContext) => Promise<number>

export interface RunCliClientOptions extends Omit<ConnectOptions, 'onStarting'> {
  argv: string[]
  /** Result of parsing `argv` with this build's command list. */
  parsed: ParsedCli
  /** This build's command list, for help text answered without a launcher. */
  registry: CommandRegistry
  /** This build's version. */
  version: string
  programName?: string
  cwd: string
  stdout: TextSink
  stderr: TextSink
  isTTY: boolean
  signal: AbortSignal
  clientCommands?: Record<string, ClientCommand>
}

/**
 * Entry point for a `vardrynn <command>` typed in a terminal. Returns the
 * process exit code; never throws.
 */
export async function runCliClient(opts: RunCliClientOptions): Promise<number> {
  const { parsed } = opts
  const json = parsed.globals.json
  const commandId = parsed.kind === 'command' || parsed.kind === 'help-command' || parsed.kind === 'error' ? parsed.commandId : undefined
  const renderer = createTerminalRenderer({ json, command: commandId, stdout: opts.stdout, stderr: opts.stderr, isTTY: opts.isTTY })
  const programName = opts.programName ?? 'vardrynn'

  // Help, version and usage errors need no launcher, so they never start one.
  switch (parsed.kind) {
    case 'none':
    case 'help':
      opts.stdout.write(`${formatHelp(opts.registry, { programName })}\n`)
      return parsed.kind === 'none' ? CliExitCode.Usage : CliExitCode.Ok
    case 'help-command': {
      const cmd = opts.registry.get(parsed.commandId)
      if (!cmd) {
        renderer.error(parsed.commandId, { code: 'CommandNotFoundError', message: `Unknown command '${parsed.commandId}'` })
        return CliExitCode.Usage
      }
      opts.stdout.write(`${formatCommandHelp(cmd, { programName })}\n`)
      return CliExitCode.Ok
    }
    case 'version':
      opts.stdout.write(`${opts.version}\n`)
      return CliExitCode.Ok
    case 'error':
      renderer.error(parsed.commandId, { code: 'UsageError', message: parsed.message })
      return CliExitCode.Usage
  }

  let connection: CliConnection
  try {
    connection = await connectToLauncher({
      ...opts,
      onStarting: () => { if (!json) opts.stderr.write('Starting Vardrynn...\n') },
    })
  } catch (e) {
    renderer.error(commandId, { code: e instanceof CliConnectionError ? `Launcher${e.code}` : 'LauncherUnavailable', message: (e as Error).message })
    return CliExitCode.LauncherUnavailable
  }

  try {
    const local = opts.clientCommands?.[parsed.commandId]
    if (local) {
      return await local({ connection, parsed, cwd: opts.cwd, renderer, stdout: opts.stdout, stderr: opts.stderr, signal: opts.signal })
    }
    const frame = await connection.run(opts.argv, opts.cwd, renderer, opts.signal)
    renderer.result(frame)
    if (!frame.ok && opts.signal.aborted) return CliExitCode.Cancelled
    return frame.exitCode
  } catch (e) {
    if (opts.signal.aborted) {
      renderer.flush()
      return CliExitCode.Cancelled
    }
    renderer.error(commandId, { code: (e as Error).name || 'Error', message: (e as Error).message })
    return (e as { exitCode?: number }).exitCode ?? CliExitCode.Failure
  } finally {
    connection.close()
  }
}
