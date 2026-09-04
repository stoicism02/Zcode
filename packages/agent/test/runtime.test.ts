import { defineTool } from "@zaly/ai"
import { Type } from "typebox"
import { describe, expect, test, vi } from "vitest"
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
} from "../src/runtime.ts"
import { loadAgent, mockModel, runAgent } from "./helpers.ts"

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
