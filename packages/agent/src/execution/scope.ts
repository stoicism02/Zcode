import type { PermissionManager } from "../permissions/manager.ts"
import type { AgentActivationId, RunId } from "./ids.ts"
import type { WorkspaceRef } from "./types.ts"

import { normPath } from "@zaly/shared"
import { createAgentActivationId, createWorkspaceId } from "./ids.ts"
import { ResourceBag } from "./resources.ts"

export interface AgentScopeOptions {
  id?: AgentActivationId
  runId?: RunId
  workspace: WorkspaceRef | (() => WorkspaceRef)
  permissions: () => PermissionManager | Promise<PermissionManager>
  resources?: ResourceBag
  abortController?: AbortController
}

/** Execution boundary carried by one AgentActivation. */
export class AgentScope {
  readonly id: AgentActivationId
  readonly runId?: RunId
  readonly resources: ResourceBag
  readonly #abortController: AbortController
  readonly #permissions: AgentScopeOptions["permissions"]
  readonly #workspace: AgentScopeOptions["workspace"]

  constructor(opts: AgentScopeOptions) {
    this.id = opts.id ?? createAgentActivationId()
    this.runId = opts.runId
    this.resources = opts.resources ?? new ResourceBag()
    this.#abortController = opts.abortController ?? new AbortController()
    this.#permissions = opts.permissions
    this.#workspace = opts.workspace
  }

  get signal(): AbortSignal {
    return this.#abortController.signal
  }

  get workspace(): WorkspaceRef {
    const workspace = typeof this.#workspace === "function" ? this.#workspace() : this.#workspace
    return { ...workspace, path: normPath(workspace.path) }
  }

  permissions(): Promise<PermissionManager> {
    return Promise.resolve(this.#permissions())
  }

  abort(reason?: unknown): void {
    if (!this.signal.aborted) this.#abortController.abort(reason)
  }

  async dispose(reason?: unknown): Promise<void> {
    this.abort(reason)
    await this.resources.dispose()
  }
}

export function createLegacyAgentScope(opts: {
  cwd: () => string
  permissions: () => PermissionManager | Promise<PermissionManager>
}): AgentScope {
  const workspaceId = createWorkspaceId()
  return new AgentScope({
    permissions: opts.permissions,
    workspace: () => ({
      access: "write",
      id: workspaceId,
      kind: "shared",
      path: opts.cwd(),
    }),
  })
}
