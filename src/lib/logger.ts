import consola, { type ConsolaInstance } from "consola"
import fs from "node:fs"
import path from "node:path"
import util from "node:util"

import { PATHS } from "./paths"
import { getCachedLoggingConfig, type DebugPayloadMode } from "./config-store"
import { registerProcessCleanup } from "./process-cleanup"
import { requestContext } from "./request-context"
import { state } from "./state"

export type { DebugPayloadMode } from "./config-store"

const LOG_RETENTION_DAYS = 7
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const LOG_MAX_TOTAL_BYTES_ENV = "COPILOT_API_LOG_MAX_TOTAL_BYTES"
const DEBUG_PAYLOAD_MODE_ENV = "COPILOT_API_DEBUG_PAYLOAD_MODE"
const DEBUG_PAYLOAD_MAX_CHARS_ENV = "COPILOT_API_DEBUG_PAYLOAD_MAX_CHARS"
const DEFAULT_LOG_DIR = path.join(PATHS.APP_DIR, "logs")
export const DEFAULT_LOG_MAX_TOTAL_BYTES = 512 * 1024 * 1024
export const DEFAULT_DEBUG_PAYLOAD_MODE: DebugPayloadMode = "summary"
export const DEFAULT_DEBUG_PAYLOAD_MAX_CHARS = 8_192
const DEFAULT_DEBUG_MAX_STRING_LENGTH = 512
const DEFAULT_DEBUG_MAX_ARRAY_ITEMS = 10
const DEFAULT_DEBUG_MAX_OBJECT_KEYS = 40
const DEFAULT_DEBUG_MAX_DEPTH = 6
const FLUSH_INTERVAL_MS = 1000
const MAX_BUFFER_SIZE = 100
const MAX_BUFFER_BYTES = 1024 * 1024
const TRIM_COPY_CHUNK_BYTES = 64 * 1024
const QUOTA_TRUNCATION_HEADER = Buffer.from(
  "[log-quota] truncated older log entries\n",
  "utf8",
)
const OPAQUE_DEBUG_FIELDS = new Set([
  "b64_json",
  "encrypted_content",
  "signature",
  "thoughtSignature",
  "thought_signature",
])
const BASE64_DATA_URL_PATTERN = /^data:([^;,]+)?(?:;[^;,=]+=[^;,]+)*;base64,/i

const getLogDir = () => process.env[LOG_DIR_ENV]?.trim() || DEFAULT_LOG_DIR

const parsePositiveInt = (raw: unknown): number | undefined => {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : undefined
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (!/^\d+$/.test(trimmed)) {
      return undefined
    }
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined
  }
  return undefined
}

const parseDebugPayloadMode = (raw: unknown): DebugPayloadMode | undefined => {
  if (typeof raw !== "string") {
    return undefined
  }
  const normalized = raw.trim().toLowerCase()
  if (
    normalized === "summary"
    || normalized === "truncate"
    || normalized === "full"
  ) {
    return normalized
  }
  return undefined
}

export const getLogMaxTotalBytes = (): number =>
  parsePositiveInt(process.env[LOG_MAX_TOTAL_BYTES_ENV])
  ?? parsePositiveInt(getCachedLoggingConfig()?.maxTotalBytes)
  ?? DEFAULT_LOG_MAX_TOTAL_BYTES

export const getDebugPayloadMode = (): DebugPayloadMode =>
  parseDebugPayloadMode(process.env[DEBUG_PAYLOAD_MODE_ENV])
  ?? parseDebugPayloadMode(getCachedLoggingConfig()?.debugPayloadMode)
  ?? DEFAULT_DEBUG_PAYLOAD_MODE

export const getDebugPayloadMaxChars = (): number =>
  parsePositiveInt(process.env[DEBUG_PAYLOAD_MAX_CHARS_ENV])
  ?? parsePositiveInt(getCachedLoggingConfig()?.debugPayloadMaxChars)
  ?? DEFAULT_DEBUG_PAYLOAD_MAX_CHARS

const logStreams = new Map<string, fs.WriteStream>()
const logBuffers = new Map<string, Array<string>>()
const logBufferBytes = new Map<string, number>()
const closingFiles = new Set<string>()

let runtimeInitialized = false
let flushInterval: ReturnType<typeof setInterval> | undefined
let cleanupInterval: ReturnType<typeof setInterval> | undefined
let currentLogDateKey: string | undefined
let activeCleanupPromise: Promise<void> | undefined
let cleanupRerunRequested = false
let estimatedDirBytes = 0
let bytesWrittenSinceCleanup = 0
let tempFileCounter = 0

const ensureLogDirectory = () => {
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
}

const formatArgs = (args: Array<unknown>) =>
  args
    .map((arg) =>
      typeof arg === "string" ? arg : (
        util.inspect(arg, { depth: null, colors: false })
      ),
    )
    .join(" ")

const sanitizeName = (name: string) => {
  const normalized = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")

  return normalized === "" ? "handler" : normalized
}

const maybeUnref = (timer: ReturnType<typeof setInterval>) => {
  timer.unref()
}

const flushBuffer = (
  filePath: string,
  options?: { allowClosing?: boolean },
) => {
  if (!options?.allowClosing && closingFiles.has(filePath)) {
    return
  }

  const buffer = logBuffers.get(filePath)
  if (!buffer) {
    return
  }

  logBuffers.delete(filePath)
  logBufferBytes.delete(filePath)
  if (buffer.length === 0) {
    return
  }

  const stream = getLogStream(filePath)
  const content = buffer.join("\n") + "\n"
  const contentBytes = Buffer.byteLength(content, "utf8")
  stream.write(content, (error) => {
    if (error) {
      console.warn("Failed to write handler log", error)
      return
    }

    estimatedDirBytes += contentBytes
    bytesWrittenSinceCleanup += contentBytes
    const maxTotalBytes = getLogMaxTotalBytes()
    const checkStepBytes = Math.min(
      4 * 1024 * 1024,
      Math.max(1024, Math.floor(maxTotalBytes * 0.1)),
    )
    if (
      estimatedDirBytes > maxTotalBytes
      || bytesWrittenSinceCleanup >= checkStepBytes
    ) {
      scheduleLogCleanup()
    }
  })
}

const flushAllBuffers = () => {
  for (const filePath of logBuffers.keys()) {
    flushBuffer(filePath)
  }
}

const closeLogFile = async (filePath: string): Promise<void> => {
  flushBuffer(filePath, { allowClosing: true })
  closingFiles.add(filePath)
  try {
    const stream = logStreams.get(filePath)
    logStreams.delete(filePath)

    if (!stream || stream.closed || stream.destroyed) {
      return
    }

    await new Promise<void>((resolve) => {
      stream.once("close", () => resolve())
      stream.end()
    })
  } finally {
    closingFiles.delete(filePath)
  }
}

const closePreviousDateLogFiles = (dateKey: string): void => {
  if (currentLogDateKey === undefined) {
    currentLogDateKey = dateKey
    return
  }
  if (currentLogDateKey === dateKey) {
    return
  }

  const filePaths = new Set([...logBuffers.keys(), ...logStreams.keys()])
  currentLogDateKey = dateKey
  for (const filePath of filePaths) {
    void closeLogFile(filePath).catch((error) => {
      console.warn("Failed to rotate handler log", error)
    })
  }
}

interface LogFileEntry {
  entry: string
  filePath: string
  isActiveToday: boolean
  mtimeMs: number
  size: number
}

const listManagedLogFiles = (logDir: string): Array<LogFileEntry> => {
  const files: Array<LogFileEntry> = []
  for (const entry of fs.readdirSync(logDir)) {
    if (!entry.endsWith(".log")) {
      continue
    }
    const filePath = path.join(logDir, entry)
    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }
    if (!stats.isFile()) {
      continue
    }
    files.push({
      entry,
      filePath,
      isActiveToday:
        currentLogDateKey !== undefined
        && entry.endsWith(`-${currentLogDateKey}.log`),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    })
  }
  return files
}

const sortOldestFirst = (files: Array<LogFileEntry>): Array<LogFileEntry> =>
  files.toSorted((left, right) =>
    left.mtimeMs !== right.mtimeMs ?
      left.mtimeMs - right.mtimeMs
    : left.entry.localeCompare(right.entry),
  )

const trimLogFileToTail = async (
  filePath: string,
  targetBytes: number,
): Promise<number> => {
  await closeLogFile(filePath)
  closingFiles.add(filePath)
  try {
    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      return 0
    }
    if (!stats.isFile() || stats.size <= targetBytes) {
      return stats.size
    }
    if (targetBytes <= 0) {
      fs.writeFileSync(filePath, "")
      return 0
    }

    const includeHeader = targetBytes > QUOTA_TRUNCATION_HEADER.length + 64
    const tailBudget =
      includeHeader ? targetBytes - QUOTA_TRUNCATION_HEADER.length : targetBytes
    const rawStartOffset = Math.max(0, stats.size - tailBudget)
    tempFileCounter += 1
    const tmpPath = `${filePath}.quota-${process.pid}-${tempFileCounter}`

    let readFd: number | undefined
    let writeFd: number | undefined
    let writtenBytes = 0
    try {
      readFd = fs.openSync(filePath, "r")
      let copyOffset = rawStartOffset
      if (rawStartOffset > 0) {
        const probeLength = Math.min(TRIM_COPY_CHUNK_BYTES, tailBudget)
        const probeBuffer = Buffer.allocUnsafe(probeLength)
        const probeRead = fs.readSync(
          readFd,
          probeBuffer,
          0,
          probeLength,
          rawStartOffset,
        )
        const newlineIndex = probeBuffer.subarray(0, probeRead).indexOf(0x0a)
        if (
          newlineIndex !== -1
          && rawStartOffset + newlineIndex + 1 < stats.size
        ) {
          copyOffset = rawStartOffset + newlineIndex + 1
        }
      }

      writeFd = fs.openSync(tmpPath, "w")
      if (includeHeader) {
        writtenBytes += fs.writeSync(writeFd, QUOTA_TRUNCATION_HEADER)
      }

      const chunkBuffer = Buffer.allocUnsafe(
        Math.min(TRIM_COPY_CHUNK_BYTES, Math.max(1, stats.size - copyOffset)),
      )
      let position = copyOffset
      while (position < stats.size) {
        const toRead = Math.min(chunkBuffer.length, stats.size - position)
        const bytesRead = fs.readSync(readFd, chunkBuffer, 0, toRead, position)
        if (bytesRead <= 0) {
          break
        }
        writtenBytes += fs.writeSync(writeFd, chunkBuffer, 0, bytesRead)
        position += bytesRead
      }
    } finally {
      if (readFd !== undefined) {
        fs.closeSync(readFd)
      }
      if (writeFd !== undefined) {
        fs.closeSync(writeFd)
      }
    }

    fs.renameSync(tmpPath, filePath)
    return writtenBytes
  } catch (error) {
    console.warn(`Failed to trim handler log to quota: ${filePath}`, error)
    try {
      return fs.statSync(filePath).size
    } catch {
      return 0
    }
  } finally {
    closingFiles.delete(filePath)
    if (runtimeInitialized && logBuffers.has(filePath)) {
      flushBuffer(filePath)
    }
  }
}

const removeManagedLogFile = async (filePath: string): Promise<boolean> => {
  try {
    await closeLogFile(filePath)
  } catch (error) {
    console.warn(`Failed to close old handler log: ${filePath}`, error)
    return false
  }

  try {
    fs.rmSync(filePath)
    return true
  } catch (error) {
    console.warn(`Failed to remove old handler log: ${filePath}`, error)
    return false
  }
}

const enforceLogDirectoryQuota = async (
  logDir: string,
  maxTotalBytes: number,
): Promise<number> => {
  const initialFiles = listManagedLogFiles(logDir)
  let totalBytes = initialFiles.reduce((sum, item) => sum + item.size, 0)
  if (totalBytes <= maxTotalBytes) {
    return totalBytes
  }

  const inactiveFiles = sortOldestFirst(
    initialFiles.filter((file) => !file.isActiveToday),
  )
  for (const file of inactiveFiles) {
    if (totalBytes <= maxTotalBytes) {
      break
    }
    if (await removeManagedLogFile(file.filePath)) {
      totalBytes -= file.size
    }
  }

  if (totalBytes <= maxTotalBytes) {
    return Math.max(0, totalBytes)
  }

  const remainingFiles = sortOldestFirst(listManagedLogFiles(logDir))
  totalBytes = remainingFiles.reduce((sum, item) => sum + item.size, 0)
  for (const [index, file] of remainingFiles.entries()) {
    if (totalBytes <= maxTotalBytes) {
      break
    }
    const otherBytes = totalBytes - file.size
    const availableBytes = maxTotalBytes - otherBytes
    if (index < remainingFiles.length - 1 && availableBytes < 256) {
      if (await removeManagedLogFile(file.filePath)) {
        totalBytes = otherBytes
      }
      continue
    }

    const targetBytes =
      availableBytes < 128 ?
        Math.max(0, availableBytes)
      : Math.max(128, Math.floor(availableBytes * 0.5))
    const trimmedSize = await trimLogFileToTail(file.filePath, targetBytes)
    totalBytes = otherBytes + trimmedSize
  }

  return Math.max(0, totalBytes)
}

const cleanupOldLogs = async (): Promise<void> => {
  const logDir = getLogDir()
  if (!fs.existsSync(logDir)) {
    return
  }

  const now = Date.now()
  for (const entry of fs.readdirSync(logDir)) {
    const filePath = path.join(logDir, entry)

    let stats: fs.Stats
    try {
      stats = fs.statSync(filePath)
    } catch {
      continue
    }

    if (!stats.isFile() || now - stats.mtimeMs <= LOG_RETENTION_MS) {
      continue
    }

    await removeManagedLogFile(filePath)
  }

  estimatedDirBytes = await enforceLogDirectoryQuota(
    logDir,
    getLogMaxTotalBytes(),
  )
  bytesWrittenSinceCleanup = 0
}

const scheduleLogCleanup = (): void => {
  if (activeCleanupPromise) {
    cleanupRerunRequested = true
    return
  }

  activeCleanupPromise = (async () => {
    do {
      cleanupRerunRequested = false
      try {
        await cleanupOldLogs()
      } catch (error) {
        console.warn("Failed to clean up handler logs", error)
      }
    } while (cleanupRerunRequested && runtimeInitialized)
  })().finally(() => {
    activeCleanupPromise = undefined
  })
}

const flushAndCloseLogStreams = () => {
  closingFiles.clear()
  flushAllBuffers()
  for (const stream of logStreams.values()) {
    stream.end()
  }

  logStreams.clear()
  logBuffers.clear()
  logBufferBytes.clear()
  closingFiles.clear()
  currentLogDateKey = undefined
  cleanupRerunRequested = false
  estimatedDirBytes = 0
  bytesWrittenSinceCleanup = 0
}

// Stops the background timers, flushes and closes all log streams, and resets
// runtime state so the logger can be initialized again. Runs on process exit
// and is also used by tests to release file handles before removing log dirs.
export const shutdownLoggerRuntime = () => {
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = undefined
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = undefined
  }

  flushAndCloseLogStreams()
  runtimeInitialized = false
}

const initializeLoggerRuntime = () => {
  if (runtimeInitialized) {
    return
  }

  runtimeInitialized = true

  ensureLogDirectory()
  scheduleLogCleanup()

  flushInterval = setInterval(flushAllBuffers, FLUSH_INTERVAL_MS)
  maybeUnref(flushInterval)

  cleanupInterval = setInterval(scheduleLogCleanup, CLEANUP_INTERVAL_MS)
  maybeUnref(cleanupInterval)

  registerProcessCleanup(shutdownLoggerRuntime)
}

const getLogStream = (filePath: string): fs.WriteStream => {
  initializeLoggerRuntime()

  let stream = logStreams.get(filePath)
  if (!stream || stream.destroyed) {
    const createdStream = fs.createWriteStream(filePath, { flags: "a" })
    stream = createdStream
    logStreams.set(filePath, createdStream)

    createdStream.on("error", (error: unknown) => {
      console.warn("Log stream error", error)
      if (logStreams.get(filePath) === createdStream) {
        logStreams.delete(filePath)
      }
    })
  }
  return stream
}

const appendLine = (filePath: string, line: string) => {
  let buffer = logBuffers.get(filePath)
  if (!buffer) {
    buffer = []
    logBuffers.set(filePath, buffer)
  }

  buffer.push(line)
  const nextBytes =
    (logBufferBytes.get(filePath) ?? 0) + Buffer.byteLength(line, "utf8") + 1
  logBufferBytes.set(filePath, nextBytes)

  if (buffer.length >= MAX_BUFFER_SIZE || nextBytes >= MAX_BUFFER_BYTES) {
    flushBuffer(filePath)
  }
}

type DebugLogger = Pick<ConsolaInstance, "debug">

type AsyncDebugValueFactory = () => Promise<unknown>

export interface DebugJsonOptions {
  mode?: DebugPayloadMode
  maxChars?: number
  maxStringLength?: number
  maxArrayItems?: number
  maxObjectKeys?: number
  maxDepth?: number
}

interface ResolvedDebugJsonOptions {
  mode: DebugPayloadMode
  maxChars: number
  maxStringLength: number
  maxArrayItems: number
  maxObjectKeys: number
  maxDepth: number
}

const resolveDebugJsonOptions = (
  options?: DebugJsonOptions,
): ResolvedDebugJsonOptions => ({
  mode: options?.mode ?? getDebugPayloadMode(),
  maxChars: parsePositiveInt(options?.maxChars) ?? getDebugPayloadMaxChars(),
  maxStringLength:
    parsePositiveInt(options?.maxStringLength)
    ?? DEFAULT_DEBUG_MAX_STRING_LENGTH,
  maxArrayItems:
    parsePositiveInt(options?.maxArrayItems) ?? DEFAULT_DEBUG_MAX_ARRAY_ITEMS,
  maxObjectKeys:
    parsePositiveInt(options?.maxObjectKeys) ?? DEFAULT_DEBUG_MAX_OBJECT_KEYS,
  maxDepth: parsePositiveInt(options?.maxDepth) ?? DEFAULT_DEBUG_MAX_DEPTH,
})

const truncateMiddle = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) {
    return text
  }
  if (maxChars <= 48) {
    return text.slice(0, maxChars)
  }

  let omitted = text.length - maxChars
  let marker = `... [truncated ${omitted} of ${text.length} chars] ...`
  for (let step = 0; step < 3; step += 1) {
    const remaining = maxChars - marker.length
    if (remaining <= 2) {
      return text.slice(0, maxChars)
    }
    const headLength = Math.ceil(remaining * 0.65)
    const tailLength = remaining - headLength
    omitted = text.length - headLength - tailLength
    marker = `... [truncated ${omitted} of ${text.length} chars] ...`
  }

  const remaining = maxChars - marker.length
  const headLength = Math.ceil(remaining * 0.65)
  const tailLength = remaining - headLength
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`
}

const safeJsonStringify = (value: unknown): string => {
  const seen = new WeakSet<object>()
  const serialized = JSON.stringify(value, (_key, currentValue: unknown) => {
    if (typeof currentValue === "bigint") {
      return currentValue.toString()
    }
    if (typeof currentValue === "object" && currentValue !== null) {
      if (seen.has(currentValue)) {
        return "[Circular]"
      }
      seen.add(currentValue)
    }
    return currentValue
  })
  return serialized ?? String(value)
}

const summarizeStringValue = (
  value: string,
  options: ResolvedDebugJsonOptions,
  keyName?: string,
): string => {
  if (
    keyName !== undefined
    && OPAQUE_DEBUG_FIELDS.has(keyName)
    && value.length > 64
  ) {
    return `[omitted ${value.length} chars]`
  }

  if (value.length > 128) {
    const dataUrlMatch = BASE64_DATA_URL_PATTERN.exec(value)
    if (dataUrlMatch) {
      const mimeType = dataUrlMatch[1] || "application/octet-stream"
      return `[data-url ${mimeType} ${value.length} chars]`
    }
  }

  return truncateMiddle(value, options.maxStringLength)
}

const summarizeDebugValue = (
  value: unknown,
  options: ResolvedDebugJsonOptions,
  depth: number,
  seen: WeakSet<object>,
  keyName?: string,
): unknown => {
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value === "string") {
    return summarizeStringValue(value, options, keyName)
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "bigint") {
    return value.toString()
  }
  if (typeof value !== "object") {
    return undefined
  }

  if (seen.has(value)) {
    return "[Circular]"
  }
  seen.add(value)
  try {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return summarizeDebugValue(
        (value as { toJSON: () => unknown }).toJSON(),
        options,
        depth,
        seen,
        keyName,
      )
    }

    if (Array.isArray(value)) {
      if (depth >= options.maxDepth) {
        return `[Array(${value.length})]`
      }
      if (value.length <= options.maxArrayItems) {
        return value.map((item) =>
          summarizeDebugValue(item, options, depth + 1, seen),
        )
      }
      const headCount = Math.ceil(options.maxArrayItems / 2)
      const tailCount = Math.floor(options.maxArrayItems / 2)
      const omittedCount = value.length - headCount - tailCount
      return [
        ...value
          .slice(0, headCount)
          .map((item) => summarizeDebugValue(item, options, depth + 1, seen)),
        `[... ${omittedCount} items omitted, total ${value.length}]`,
        ...value
          .slice(value.length - tailCount)
          .map((item) => summarizeDebugValue(item, options, depth + 1, seen)),
      ]
    }

    const entries = Object.entries(value).filter(([, entryValue]) => {
      const entryType = typeof entryValue
      return (
        entryValue !== undefined
        && entryType !== "function"
        && entryType !== "symbol"
      )
    })
    if (depth >= options.maxDepth) {
      return `[Object(${entries.length} keys)]`
    }

    const summarizedObject: Record<string, unknown> = {}
    const keptEntries = entries.slice(0, options.maxObjectKeys)
    for (const [entryKey, entryValue] of keptEntries) {
      summarizedObject[entryKey] = summarizeDebugValue(
        entryValue,
        options,
        depth + 1,
        seen,
        entryKey,
      )
    }
    if (entries.length > options.maxObjectKeys) {
      summarizedObject.__omittedKeys = entries.length - options.maxObjectKeys
    }
    return summarizedObject
  } finally {
    seen.delete(value)
  }
}

export const formatDebugJson = (
  value: unknown,
  options?: DebugJsonOptions,
): string => {
  const resolved = resolveDebugJsonOptions(options)
  if (resolved.mode === "full") {
    return safeJsonStringify(value)
  }
  if (resolved.mode === "truncate") {
    return truncateMiddle(safeJsonStringify(value), resolved.maxChars)
  }
  const summarized = summarizeDebugValue(
    value,
    resolved,
    0,
    new WeakSet<object>(),
  )
  return truncateMiddle(safeJsonStringify(summarized), resolved.maxChars)
}

export const debugLazy = (
  logger: DebugLogger,
  factory: () => [unknown, ...Array<unknown>],
): void => {
  if (!state.verbose) {
    return
  }

  logger.debug(...factory())
}

export const debugJson = (
  logger: DebugLogger,
  label: string,
  value: unknown,
  options?: DebugJsonOptions,
): void => {
  debugLazy(logger, () => [label, formatDebugJson(value, options)])
}

export const debugJsonAsync = async (
  logger: DebugLogger,
  label: string,
  factory: AsyncDebugValueFactory,
  options?: DebugJsonOptions,
): Promise<void> => {
  if (!state.verbose) {
    return
  }

  logger.debug(label, formatDebugJson(await factory(), options))
}

export const debugJsonTail = (
  logger: DebugLogger,
  label: string,
  { value, tailLength = 400 }: { value: unknown; tailLength?: number },
): void => {
  debugLazy(logger, () => [label, JSON.stringify(value).slice(-tailLength)])
}

export const createHandlerLogger = (name: string): ConsolaInstance => {
  const sanitizedName = sanitizeName(name)
  const instance = consola.withTag(name)

  if (state.verbose) {
    instance.level = 5
  }
  instance.setReporters([])

  instance.addReporter({
    log(logObj) {
      initializeLoggerRuntime()

      const context = requestContext.getStore()
      const traceId = context?.traceId
      const date = logObj.date
      const dateKey = date.toLocaleDateString("sv-SE")
      const timestamp = date.toLocaleString("sv-SE", { hour12: false })
      const filePath = path.join(getLogDir(), `${sanitizedName}-${dateKey}.log`)
      const message = formatArgs(logObj.args as Array<unknown>)
      const traceIdStr = traceId ? ` [${traceId}]` : ""
      const line = `[${timestamp}] [${logObj.type}] [${logObj.tag || name}]${traceIdStr}${
        message ? ` ${message}` : ""
      }`

      closePreviousDateLogFiles(dateKey)
      appendLine(filePath, line)
    },
  })

  return instance
}
