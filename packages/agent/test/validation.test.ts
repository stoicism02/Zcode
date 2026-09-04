import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "pathe"
import { afterEach, describe, expect, test } from "vitest"
import { createRunId, createWorkspaceId, ValidationRunner } from "../src/runtime.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

async function createWorkspace() {
  const path = await mkdtemp(join(tmpdir(), "zaly-validation-test-"))
  temporaryDirectories.push(path)
  return {
    access: "write" as const,
    baseCommit: "base",
    id: createWorkspaceId(),
    kind: "worktree" as const,
    ownerRunId: createRunId(),
    path,
    repositoryRoot: path,
  }
}

describe("ValidationRunner", () => {
  test("runs every trusted check and returns a structured failure summary", async () => {
    const workspace = await createWorkspace()
    const summary = await new ValidationRunner().run(workspace, {
      checks: [
        {
          command: [process.execPath, "-e", "process.stderr.write('broken'); process.exit(1)"],
          name: "failing-check",
        },
        {
          command: [process.execPath, "-e", "console.log('still ran')"],
          name: "passing-check",
        },
      ],
    })

    expect(summary.status).toBe("failed")
    expect(summary.checks).toMatchObject([
      { exitCode: 1, name: "failing-check", status: "failed" },
      { exitCode: 0, name: "passing-check", status: "passed" },
    ])
    expect(summary.checks[0]?.output).toContain("broken")
    expect(summary.checks[1]?.output).toContain("still ran")
  })

  test("marks a timed-out command as failed", async () => {
    const workspace = await createWorkspace()
    const summary = await new ValidationRunner().run(workspace, {
      checks: [
        {
          command: [process.execPath, "-e", "setTimeout(() => undefined, 1000)"],
          name: "slow-check",
          timeoutMs: 20,
        },
      ],
    })

    expect(summary).toMatchObject({
      checks: [{ name: "slow-check", status: "failed" }],
      status: "failed",
    })
  })

  test("caps oversized command output", async () => {
    const workspace = await createWorkspace()
    const summary = await new ValidationRunner().run(workspace, {
      checks: [
        {
          command: [process.execPath, "-e", "process.stdout.write('x'.repeat(100_000))"],
          name: "noisy-check",
        },
      ],
      maxOutputBytes: 32,
    })

    expect(summary).toMatchObject({
      checks: [{ name: "noisy-check", status: "failed", truncated: true }],
      status: "failed",
    })
  })

  test("returns not-run for an intentionally empty profile", async () => {
    const workspace = await createWorkspace()
    await expect(new ValidationRunner().run(workspace, { checks: [] })).resolves.toEqual({
      checks: [],
      status: "not-run",
    })
  })
})
