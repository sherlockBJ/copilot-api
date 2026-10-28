import { expect, test } from "bun:test"
import path from "node:path"

const python = Bun.which("python3") ?? Bun.which("python")
const supported =
  python !== null
  && Bun.spawnSync([
    python,
    "-c",
    "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)",
  ]).exitCode === 0

test.skipIf(!supported)(
  "Codex provider model synchronization regressions",
  async () => {
    const child = Bun.spawn(
      [
        python!,
        "-m",
        "unittest",
        "discover",
        "-s",
        "tests",
        "-p",
        "test_codex_model_sync.py",
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(stdout + stderr)
    expect(exitCode).toBe(0)
  },
  15000,
)
