import type { WorkspaceError } from "../src/runtime.ts"

import { defineTool } from "@zaly/ai"
import { Spawn } from "@zaly/shared/process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "pathe"
import { Type } from "typebox"
import { afterEach, describe, expect, test, vi } from "vitest"
import { PermissionManager } from "../src/permissions/manager.ts"
import {
  AgentScope,
  InvalidRunTransitionError,
  ResourceBag,
  assertRunTransition,
  canTransitionRun,
  createRunId,
  createWorkspaceId,
  isRunTerminal,
  WorkspaceManager,
} from "../src/runtime.ts"
import { loadAgent, mockModel, runAgent } from "./helpers.ts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

async function createGitRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zaly-workspace-test-"))
  temporaryDirectories.push(root)
  await runGit(root, ["init"])
  await runGit(root, ["config", "user.email", "workspace-test@example.com"])
  await runGit(root, ["config", "user.name", "Workspace Test"])
  await writeFile(
    join(root, "tracked.txt"),
    `base
`
  )
  await runGit(root, ["add", "tracked.txt"])
  await runGit(root, ["commit", "-m", "initial"])
  return root
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  const result = await new Spawn("git", args, { cwd }).result
  if (result.code !== 0) throw new Error(result.stderr.toString("utf8"))
}

describe("runtime ids and run state", () => {
  test("creates distinct run ids", () => {
    expect(createRunId()).not.toBe(createRunId())
  })

  test("accepts the declared execution path", () => {
    expect(canTransitionRun("created", "queued")).toBe(true)
    expect(canTransitionRun("queued", "running")).toBe(true)
    expect(canTransitionRun("running", "succeeded")).toBe(true)
  })

  test("rejects retries and transitions out of terminal states", () => {
    expect(canTransitionRun("failed", "queued")).toBe(false)
    expect(isRunTerminal("interrupted")).toBe(true)
    expect(() => assertRunTransition("succeeded", "running")).toThrow(InvalidRunTransitionError)
  })
})

describe("ResourceBag", () => {
  test("disposes resources once in reverse ownership order", async () => {
    const disposed: number[] = []
    const bag = new ResourceBag()
    bag.add(() => {
      disposed.push(1)
    })
    bag.add({
      dispose: () => {
        disposed.push(2)
      },
    })

    await Promise.all([bag.dispose(), bag.dispose()])
    await bag.dispose()

    expect(disposed).toEqual([2, 1])
    expect(bag.disposed).toBe(true)
    expect(() => bag.add(() => undefined)).toThrow(/disposed ResourceBag/)
  })

  test("attempts every cleanup before reporting failures", async () => {
    const cleanup = vi.fn()
    const bag = new ResourceBag()
    bag.add(cleanup)
    bag.add(() => {
      throw new Error("broken cleanup")
    })

    await expect(bag.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(cleanup).toHaveBeenCalledOnce()
  })
})

describe("AgentScope", () => {
  test("owns an abort signal and delegates permission resolution", async () => {
    const permissions = { validate: vi.fn() }
    const scope = new AgentScope({
      permissions: () => permissions as never,
      workspace: {
        access: "read",
        id: createWorkspaceId(),
        kind: "shared",
        path: ".",
      },
    })

    expect(await scope.permissions()).toBe(permissions)
    expect(scope.signal.aborted).toBe(false)
    scope.abort("test")
    expect(scope.signal.aborted).toBe(true)
    expect(scope.signal.reason).toBe("test")
  })

  test("is injected into tool context without legacy cwd or permission options", async () => {
    let received: AgentScope | undefined
    const permissions = new PermissionManager({ cwd: "." })
    const scope = new AgentScope({
      permissions: () => permissions,
      workspace: {
        access: "read",
        id: createWorkspaceId(),
        kind: "shared",
        path: ".",
      },
    })
    const inspectScope = defineTool({
      call: (_params, ctx) => {
        received = ctx.scope
        return "ok"
      },
      name: "inspect_scope",
      params: Type.Object({}),
    })

    await runAgent({
      messages: [{ content: "inspect", role: "user" }],
      model: mockModel([
        [
          { id: "scope-1", name: "inspect_scope", params: {}, type: "tool-call" },
          { finishReason: "tool-calls", type: "finish", usage: { input: 1, output: 1 } },
        ],
        [{ finishReason: "stop", type: "finish", usage: { input: 1, output: 1 } }],
      ]),
      scope,
      tools: [inspectScope],
    })

    expect(received).toBe(scope)
  })

  test("creates a legacy scope for existing Agent callers", async () => {
    const agent = await loadAgent({
      cwd: ".",
      model: mockModel([]),
    })

    expect(agent.scope.workspace).toMatchObject({ access: "write", kind: "shared" })
    expect(agent.scope.workspace.path).toBe(agent.cwd)
    expect(await agent.scope.permissions()).toBe(await agent.ctx.permissions())

    await agent.dispose()
    expect(agent.scope.signal.aborted).toBe(true)
  })
})

describe("WorkspaceManager", () => {
  test("creates an isolated detached Worktree from a clean commit", async () => {
    const repositoryRoot = await createGitRepository()
    const storageRoot = await mkdtemp(join(tmpdir(), "zaly-workspace-storage-"))
    temporaryDirectories.push(storageRoot)
    const manager = new WorkspaceManager({ rootDir: storageRoot })
    const workspace = await manager.createWritable({ cwd: repositoryRoot, runId: createRunId() })

    expect(workspace).toMatchObject({
      access: "write",
      baseCommit: expect.any(String),
      kind: "worktree",
      repositoryRoot,
    })
    expect(workspace.path).not.toBe(repositoryRoot)

    await writeFile(
      join(workspace.path, "tracked.txt"),
      `child change
`
    )
    expect(await readFile(join(repositoryRoot, "tracked.txt"), "utf8")).toBe(`base
`)
  })

  test("rejects dirty or non-Git source directories", async () => {
    const repositoryRoot = await createGitRepository()
    const storageRoot = await mkdtemp(join(tmpdir(), "zaly-workspace-storage-"))
    const nonGitRoot = await mkdtemp(join(tmpdir(), "zaly-workspace-non-git-"))
    temporaryDirectories.push(storageRoot, nonGitRoot)
    const manager = new WorkspaceManager({ rootDir: storageRoot })

    await writeFile(
      join(repositoryRoot, "tracked.txt"),
      `uncommitted
`
    )
    await expect(
      manager.createWritable({ cwd: repositoryRoot, runId: createRunId() })
    ).rejects.toMatchObject({
      code: "dirty-workspace",
    } satisfies Partial<WorkspaceError>)
    await expect(
      manager.createWritable({ cwd: nonGitRoot, runId: createRunId() })
    ).rejects.toMatchObject({
      code: "not-a-git-repository",
    } satisfies Partial<WorkspaceError>)
  })

  test("rejects workspace storage inside the source repository", async () => {
    const repositoryRoot = await createGitRepository()
    const manager = new WorkspaceManager({ rootDir: join(repositoryRoot, ".zcode", "worktrees") })

    await expect(
      manager.createWritable({ cwd: repositoryRoot, runId: createRunId() })
    ).rejects.toMatchObject({
      code: "workspace-root-inside-repository",
    } satisfies Partial<WorkspaceError>)
  })

  test("preserves a Worktree by default and removes only explicit allocations", async () => {
    const repositoryRoot = await createGitRepository()
    const storageRoot = await mkdtemp(join(tmpdir(), "zaly-workspace-storage-"))
    temporaryDirectories.push(storageRoot)
    const manager = new WorkspaceManager({ rootDir: storageRoot })
    const workspace = await manager.createWritable({ cwd: repositoryRoot, runId: createRunId() })

    await expect(manager.release(workspace)).resolves.toEqual({ status: "preserved" })
    expect(existsSync(workspace.path)).toBe(true)
    await expect(manager.release(workspace, { remove: true })).resolves.toEqual({
      status: "removed",
    })
    expect(existsSync(workspace.path)).toBe(false)
  })
})
