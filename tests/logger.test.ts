import { afterEach, expect, mock, setSystemTime, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  invalidateConfigCache,
  mergeConfigWithDefaults,
} from "~/lib/config-store"
import {
  createHandlerLogger,
  DEFAULT_DEBUG_PAYLOAD_MAX_CHARS,
  DEFAULT_DEBUG_PAYLOAD_MODE,
  DEFAULT_LOG_MAX_TOTAL_BYTES,
  debugJson,
  debugJsonAsync,
  debugJsonTail,
  formatDebugJson,
  getDebugPayloadMaxChars,
  getDebugPayloadMode,
  getLogMaxTotalBytes,
  shutdownLoggerRuntime,
} from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

const LOG_DIR_ENV = "COPILOT_API_LOG_DIR"
const LOG_MAX_TOTAL_BYTES_ENV = "COPILOT_API_LOG_MAX_TOTAL_BYTES"
const DEBUG_PAYLOAD_MODE_ENV = "COPILOT_API_DEBUG_PAYLOAD_MODE"
const DEBUG_PAYLOAD_MAX_CHARS_ENV = "COPILOT_API_DEBUG_PAYLOAD_MAX_CHARS"
const originalLogDir = process.env[LOG_DIR_ENV]
const originalAppDir = PATHS.APP_DIR
const originalConfigPath = PATHS.CONFIG_PATH

afterEach(() => {
  shutdownLoggerRuntime()
  setSystemTime()
  state.verbose = false
  PATHS.APP_DIR = originalAppDir
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  Reflect.deleteProperty(process.env, LOG_MAX_TOTAL_BYTES_ENV)
  Reflect.deleteProperty(process.env, DEBUG_PAYLOAD_MODE_ENV)
  Reflect.deleteProperty(process.env, DEBUG_PAYLOAD_MAX_CHARS_ENV)
  if (originalLogDir === undefined) {
    Reflect.deleteProperty(process.env, LOG_DIR_ENV)
  } else {
    process.env[LOG_DIR_ENV] = originalLogDir
  }
})

const localDate = (year: number, month: number, day: number): Date =>
  new Date(year, month - 1, day, 12)

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for logger state")
}

function trackLogStreams(): {
  restore: () => void
  streams: Array<fs.WriteStream>
} {
  const originalCreateWriteStream = fs.createWriteStream
  const streams: Array<fs.WriteStream> = []
  fs.createWriteStream = new Proxy(originalCreateWriteStream, {
    apply(target, thisArg, args) {
      const stream = Reflect.apply(target, thisArg, args) as fs.WriteStream
      streams.push(stream)
      return stream
    },
  })

  return {
    restore: () => {
      fs.createWriteStream = originalCreateWriteStream
    },
    streams,
  }
}

test("debugJson skips serialization when verbose logging is disabled", () => {
  state.verbose = false

  const logger = {
    debug: mock(() => {}),
  }
  const toJSON = mock(() => ({ ok: true }))

  debugJson(logger as never, "payload", { toJSON })

  expect(toJSON).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJson logs the serialized payload when verbose logging is enabled", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { ok: true }

  debugJson(logger as never, "payload", payload)

  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonAsync skips reading when verbose logging is disabled", async () => {
  state.verbose = false

  const logger = {
    debug: mock(() => {}),
  }
  const readValue = mock(() => Promise.resolve({ body: "request body" }))

  await debugJsonAsync(logger as never, "payload", readValue)

  expect(readValue).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJsonAsync reads and logs when verbose logging is enabled", async () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { body: "response body" }
  const readValue = mock(() => Promise.resolve(payload))

  await debugJsonAsync(logger as never, "payload", readValue)

  expect(readValue).toHaveBeenCalledTimes(1)
  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonTail preserves tail truncation behavior", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { text: "abcdefghijklmnopqrstuvwxyz" }
  const expected = JSON.stringify(payload).slice(-10)

  debugJsonTail(logger as never, "payload", { value: payload, tailLength: 10 })

  expect(logger.debug).toHaveBeenCalledWith("payload", expected)
})

test("createHandlerLogger writes to COPILOT_API_LOG_DIR when set", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir

  try {
    const logger = createHandlerLogger("env-override-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`line-${index}`)
    }

    const dateKey = new Date().toLocaleDateString("sv-SE")
    const filePath = path.join(logDir, `env-override-handler-${dateKey}.log`)

    // Poll until the last line is flushed to disk: the log file is created
    // asynchronously by fs.createWriteStream, so it can exist while still
    // empty. Checking only for existence would race with the async write.
    let content = ""
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, "utf8")
        if (content.includes("line-99")) {
          break
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(fs.existsSync(filePath)).toBe(true)
    expect(content).toContain("line-0")
    expect(content).toContain("line-99")
  } finally {
    // Close the write stream before deleting: Windows cannot remove a
    // directory while a file handle is still open. Retries cover the brief
    // window until the stream's fd is released after end().
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("createHandlerLogger closes the previous stream when the date changes", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir
  const trackedStreams = trackLogStreams()

  try {
    setSystemTime(localDate(2026, 1, 1))
    const logger = createHandlerLogger("rotating-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`first-day-${index}`)
    }

    const firstFilePath = path.join(logDir, "rotating-handler-2026-01-01.log")
    await waitFor(
      () =>
        trackedStreams.streams.length === 1
        && fs.existsSync(firstFilePath)
        && fs.readFileSync(firstFilePath, "utf8").includes("first-day-99"),
    )
    const firstStream = trackedStreams.streams[0]
    expect(firstStream.closed).toBe(false)

    setSystemTime(localDate(2026, 1, 2))
    for (let index = 0; index < 100; index += 1) {
      logger.error(`second-day-${index}`)
    }

    await waitFor(() => firstStream.closed)
    expect(firstStream.closed).toBe(true)

    const secondFilePath = path.join(logDir, "rotating-handler-2026-01-02.log")
    await waitFor(
      () =>
        fs.existsSync(secondFilePath)
        && fs.readFileSync(secondFilePath, "utf8").includes("second-day-99"),
    )
    expect(fs.readFileSync(secondFilePath, "utf8")).toContain("second-day-99")
  } finally {
    shutdownLoggerRuntime()
    trackedStreams.restore()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("logger startup removes expired files", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir
  const filePath = path.join(logDir, "retention-handler-2026-01-01.log")
  const firstDate = localDate(2026, 1, 1)
  fs.writeFileSync(filePath, "expired\n", "utf8")
  fs.utimesSync(filePath, firstDate, firstDate)

  try {
    setSystemTime(localDate(2026, 1, 10))
    const logger = createHandlerLogger("retention-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`current-${index}`)
    }
    const currentFilePath = path.join(
      logDir,
      "retention-handler-2026-01-10.log",
    )

    await waitFor(
      () =>
        !fs.existsSync(filePath)
        && fs.existsSync(currentFilePath)
        && fs.readFileSync(currentFilePath, "utf8").includes("current-99"),
    )
    expect(fs.existsSync(filePath)).toBe(false)
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("summary mode redacts short opaque fields and short base64 data URLs", () => {
  const serialized = formatDebugJson({
    encrypted_content: "x",
    b64_json: "YWJjZA==",
    signature: "sig_short_123",
    thought_signature: "ts_short_456",
    thoughtSignature: "E".repeat(64),
    emptyOpaque: { encrypted_content: "" },
    shortDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    ordinaryShortField: "keep-me",
  })

  expect(serialized).not.toContain('"x"')
  expect(serialized).not.toContain("YWJjZA==")
  expect(serialized).not.toContain("sig_short_123")
  expect(serialized).not.toContain("ts_short_456")
  expect(serialized).not.toContain("iVBORw0KGgo=")
  expect(serialized).toContain('"encrypted_content":"[omitted 1 chars]"')
  expect(serialized).toContain('"b64_json":"[omitted 8 chars]"')
  expect(serialized).toContain('"signature":"[omitted 13 chars]"')
  expect(serialized).toContain('"thought_signature":"[omitted 12 chars]"')
  expect(serialized).toContain('"thoughtSignature":"[omitted 64 chars]"')
  expect(serialized).toContain('"emptyOpaque":{"encrypted_content":""}')
  expect(serialized).toContain('"shortDataUrl":"[data-url image/png 34 chars]"')
  expect(serialized).toContain('"ordinaryShortField":"keep-me"')
})

test("startup quota cleanup preserves pre-existing same-day logs and evicts prior-day logs first", async () => {
  const logDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-startup-today-"),
  )
  process.env[LOG_DIR_ENV] = logDir
  process.env[LOG_MAX_TOTAL_BYTES_ENV] = "10000"

  const todayFile = path.join(logDir, "responses-handler-2026-01-10.log")
  const yesterdayFile = path.join(logDir, "other-handler-2026-01-09.log")
  fs.writeFileSync(
    todayFile,
    `earlier-today-important-entry-${"T".repeat(3200)}\n`,
    "utf8",
  )
  fs.writeFileSync(yesterdayFile, `yesterday-log-${"Y".repeat(7200)}\n`, "utf8")
  // Give the pre-existing today file an older mtime than yesterdayFile to
  // verify active-today classification rather than mtime ordering protects it.
  fs.utimesSync(
    todayFile,
    new Date(2026, 0, 10, 8, 0),
    new Date(2026, 0, 10, 8, 0),
  )
  fs.utimesSync(
    yesterdayFile,
    new Date(2026, 0, 10, 9, 0),
    new Date(2026, 0, 10, 9, 0),
  )

  try {
    setSystemTime(localDate(2026, 1, 10))
    const logger = createHandlerLogger("responses-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`after-restart-${index}`)
    }

    await waitFor(() => {
      if (!fs.existsSync(todayFile) || fs.existsSync(yesterdayFile)) {
        return false
      }
      const content = fs.readFileSync(todayFile, "utf8")
      return content.includes("after-restart-99")
    })

    const content = fs.readFileSync(todayFile, "utf8")
    expect(fs.existsSync(yesterdayFile)).toBe(false)
    expect(content).toContain("earlier-today-important-entry-")
    expect(content).toContain("after-restart-99")
    expect(fs.statSync(todayFile).size).toBeLessThanOrEqual(10_000)
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("startup quota cleanup tail-trims an oversized pre-existing same-day log instead of deleting it", async () => {
  const logDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-startup-trim-"),
  )
  process.env[LOG_DIR_ENV] = logDir
  process.env[LOG_MAX_TOTAL_BYTES_ENV] = "16000"

  const todayFile = path.join(logDir, "responses-handler-2026-01-10.log")
  const preExistingLines = [
    `pre-restart-head-${"H".repeat(15000)}`,
    ...Array.from(
      { length: 25 },
      (_, index) => `pre-restart-tail-${index}-${"T".repeat(60)}`,
    ),
  ]
  fs.writeFileSync(todayFile, `${preExistingLines.join("\n")}\n`, "utf8")
  fs.utimesSync(
    todayFile,
    new Date(2026, 0, 10, 8, 0),
    new Date(2026, 0, 10, 8, 0),
  )

  try {
    setSystemTime(localDate(2026, 1, 10))
    const logger = createHandlerLogger("responses-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`post-restart-${index}`)
    }

    await waitFor(() => {
      if (!fs.existsSync(todayFile)) {
        return false
      }
      const content = fs.readFileSync(todayFile, "utf8")
      return (
        content.includes("post-restart-99")
        && fs.statSync(todayFile).size <= 16_000
      )
    })

    const content = fs.readFileSync(todayFile, "utf8")
    expect(content).toContain("[log-quota] truncated older log entries")
    expect(content).not.toContain("pre-restart-head-")
    expect(content).toContain("pre-restart-tail-24-")
    expect(content).toContain("post-restart-99")
    expect(fs.statSync(todayFile).size).toBeLessThanOrEqual(16_000)
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("logger maintenance warns when an expired log cannot be removed", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-logs-"))
  process.env[LOG_DIR_ENV] = logDir
  const filePath = path.join(logDir, "blocked-handler-2026-01-01.log")
  const firstDate = localDate(2026, 1, 1)
  fs.writeFileSync(filePath, "blocked\n", "utf8")
  fs.utimesSync(filePath, firstDate, firstDate)
  setSystemTime(localDate(2026, 1, 10))

  const originalRmSync = fs.rmSync
  const originalWarn = console.warn
  const warnings: Array<Array<unknown>> = []
  fs.rmSync = new Proxy(originalRmSync, {
    apply(target, thisArg, args) {
      if (args[0] === filePath) {
        throw new Error("forced remove failure")
      }
      Reflect.apply(target, thisArg, args)
    },
  })
  console.warn = (...args: Array<unknown>) => {
    warnings.push(args)
  }

  try {
    const logger = createHandlerLogger("blocked-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`current-${index}`)
    }
    const currentFilePath = path.join(logDir, "blocked-handler-2026-01-10.log")
    await waitFor(
      () =>
        warnings.some(([message]) =>
          String(message).includes("Failed to remove old handler log"),
        )
        && fs.existsSync(currentFilePath)
        && fs.readFileSync(currentFilePath, "utf8").includes("current-99"),
    )

    expect(fs.existsSync(filePath)).toBe(true)
    expect(
      warnings.some(([message]) =>
        String(message).includes("Failed to remove old handler log"),
      ),
    ).toBe(true)
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync = originalRmSync
    console.warn = originalWarn
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("debugJson summarizes large Responses payloads by default while keeping head and tail context", () => {
  state.verbose = true
  const logger = {
    debug: mock(() => {}),
  }
  const sharedMeta = { source: "codex" }
  const payload = {
    model: "gpt-6.1-sol",
    stream: true,
    firstMeta: sharedMeta,
    secondMeta: sharedMeta,
    input: Array.from({ length: 30 }, (_, index) => ({
      id: `item-${index}`,
      type: index % 2 === 0 ? "reasoning" : "custom_tool_call_output",
      encrypted_content: index % 2 === 0 ? "E".repeat(400) : undefined,
      output:
        index % 2 === 1 ? `prefix-${index}-${"O".repeat(900)}-tail` : undefined,
      image:
        index === 0 ? `data:image/png;base64,${"A".repeat(300)}` : undefined,
    })),
  }

  debugJson(logger as never, "Responses request payload:", payload)

  expect(logger.debug).toHaveBeenCalledTimes(1)
  const serialized = String(
    (logger.debug.mock.calls as Array<Array<unknown>>)[0]?.[1],
  )
  expect(serialized.length).toBeLessThanOrEqual(DEFAULT_DEBUG_PAYLOAD_MAX_CHARS)
  expect(serialized).toContain('"item-0"')
  expect(serialized).toContain('"item-29"')
  expect(serialized).toContain("[... 20 items omitted, total 30]")
  expect(serialized).toContain("[omitted 400 chars]")
  expect(serialized).toContain("[data-url image/png ")
  expect(serialized).toContain("... [truncated ")
  expect(serialized).toContain('"firstMeta":{"source":"codex"}')
  expect(serialized).toContain('"secondMeta":{"source":"codex"}')
})

test("formatDebugJson handles truncate mode, full mode, circular objects, depth, and object key caps", () => {
  const cyclic: Record<string, unknown> = {
    count: 42n,
    nested: { a: { b: { c: [1, 2, 3] } } },
  }
  cyclic.self = cyclic
  for (let index = 0; index < 12; index += 1) {
    cyclic[`k${index}`] = `v-${index}-${"x".repeat(40)}`
  }

  const summarized = formatDebugJson(cyclic, {
    mode: "summary",
    maxDepth: 2,
    maxObjectKeys: 5,
    maxChars: 600,
  })
  expect(summarized).toContain('"count":"42"')
  expect(summarized).toContain('"[Circular]"')
  expect(summarized).toContain('"[Object(1 keys)]"')
  expect(summarized).toContain('"__omittedKeys":')
  expect(summarized.length).toBeLessThanOrEqual(600)

  const truncated = formatDebugJson(
    { text: "0123456789".repeat(80) },
    { mode: "truncate", maxChars: 120 },
  )
  expect(truncated.length).toBeLessThanOrEqual(120)
  expect(truncated).toContain("... [truncated ")

  const tinyTruncated = formatDebugJson(
    { text: "0123456789".repeat(10) },
    { mode: "truncate", maxChars: 30 },
  )
  expect(tinyTruncated.length).toBe(30)

  const full = formatDebugJson(cyclic, { mode: "full", maxChars: 50 })
  expect(full).toContain('"[Circular]"')
  expect(full.length).toBeGreaterThan(200)
})

test("logging config and environment overrides resolve with expected precedence", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-cfg-"))
  PATHS.APP_DIR = tempDir
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")

  try {
    expect(getDebugPayloadMode()).toBe(DEFAULT_DEBUG_PAYLOAD_MODE)
    expect(getDebugPayloadMaxChars()).toBe(DEFAULT_DEBUG_PAYLOAD_MAX_CHARS)
    expect(getLogMaxTotalBytes()).toBe(DEFAULT_LOG_MAX_TOTAL_BYTES)

    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      JSON.stringify({
        logging: {
          debugPayloadMode: "truncate",
          debugPayloadMaxChars: 1024,
          maxTotalBytes: 262_144,
        },
      }),
      "utf8",
    )
    mergeConfigWithDefaults()

    expect(getDebugPayloadMode()).toBe("truncate")
    expect(getDebugPayloadMaxChars()).toBe(1024)
    expect(getLogMaxTotalBytes()).toBe(262_144)

    process.env[DEBUG_PAYLOAD_MODE_ENV] = "full"
    process.env[DEBUG_PAYLOAD_MAX_CHARS_ENV] = "2048"
    process.env[LOG_MAX_TOTAL_BYTES_ENV] = "524288"
    expect(getDebugPayloadMode()).toBe("full")
    expect(getDebugPayloadMaxChars()).toBe(2048)
    expect(getLogMaxTotalBytes()).toBe(524_288)

    // Invalid env values fall back to loaded config.
    process.env[DEBUG_PAYLOAD_MODE_ENV] = "invalid"
    process.env[DEBUG_PAYLOAD_MAX_CHARS_ENV] = "-5"
    process.env[LOG_MAX_TOTAL_BYTES_ENV] = "not-a-number"
    expect(getDebugPayloadMode()).toBe("truncate")
    expect(getDebugPayloadMaxChars()).toBe(1024)
    expect(getLogMaxTotalBytes()).toBe(262_144)

    state.verbose = true
    const logger = { debug: mock(() => {}) }
    await debugJsonAsync(logger as never, "async-payload", () =>
      Promise.resolve({ body: "z".repeat(3000) }),
    )
    const logged = String(
      (logger.debug.mock.calls as Array<Array<unknown>>)[0]?.[1],
    )
    expect(logged.length).toBeLessThanOrEqual(1024)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test("log directory quota evicts oldest prior-day logs before active today logs", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-quota-"))
  process.env[LOG_DIR_ENV] = logDir
  process.env[LOG_MAX_TOTAL_BYTES_ENV] = "8192"

  const day1File = path.join(logDir, "responses-handler-2026-01-08.log")
  const day2File = path.join(logDir, "responses-handler-2026-01-09.log")
  fs.writeFileSync(day1File, `${"a".repeat(4500)}\n`, "utf8")
  fs.writeFileSync(day2File, `${"b".repeat(4500)}\n`, "utf8")
  fs.utimesSync(day1File, localDate(2026, 1, 8), localDate(2026, 1, 8))
  fs.utimesSync(day2File, localDate(2026, 1, 9), localDate(2026, 1, 9))

  try {
    setSystemTime(localDate(2026, 1, 10))
    const logger = createHandlerLogger("responses-handler")
    for (let index = 0; index < 100; index += 1) {
      logger.error(`day3-${index}`)
    }

    const todayFile = path.join(logDir, "responses-handler-2026-01-10.log")
    await waitFor(() => {
      if (!fs.existsSync(todayFile)) {
        return false
      }
      const total = fs
        .readdirSync(logDir)
        .filter((entry) => entry.endsWith(".log"))
        .reduce(
          (sum, entry) => sum + fs.statSync(path.join(logDir, entry)).size,
          0,
        )
      return !fs.existsSync(day1File) && total <= 8192
    })

    expect(fs.existsSync(day1File)).toBe(false)
    expect(fs.existsSync(todayFile)).toBe(true)
    const totalAfter = fs
      .readdirSync(logDir)
      .filter((entry) => entry.endsWith(".log"))
      .reduce(
        (sum, entry) => sum + fs.statSync(path.join(logDir, entry)).size,
        0,
      )
    expect(totalAfter).toBeLessThanOrEqual(8192)
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})

test("log directory quota trims an oversized active log file while preserving newest entries", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-trim-"))
  process.env[LOG_DIR_ENV] = logDir
  process.env[LOG_MAX_TOTAL_BYTES_ENV] = "12000"

  try {
    setSystemTime(localDate(2026, 1, 10))
    const logger = createHandlerLogger("responses-handler")
    for (let batch = 0; batch < 3; batch += 1) {
      for (let index = 0; index < 100; index += 1) {
        logger.error(`entry-${batch * 100 + index}-${"x".repeat(80)}`)
      }
    }

    const todayFile = path.join(logDir, "responses-handler-2026-01-10.log")
    await waitFor(() => {
      if (!fs.existsSync(todayFile)) {
        return false
      }
      const content = fs.readFileSync(todayFile, "utf8")
      const size = fs.statSync(todayFile).size
      return (
        content.includes("entry-299-")
        && content.includes("[log-quota] truncated older log entries")
        && size <= 12_000
      )
    })

    const finalContent = fs.readFileSync(todayFile, "utf8")
    expect(fs.statSync(todayFile).size).toBeLessThanOrEqual(12_000)
    expect(finalContent).toContain("[log-quota] truncated older log entries")
    expect(finalContent).toContain("entry-299-")
    expect(finalContent).not.toContain("entry-0-")
  } finally {
    shutdownLoggerRuntime()
    fs.rmSync(logDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
})
