import type { RunId, WorkspaceId } from "./ids.ts"
import type { WorkspaceRef } from "./types.ts"

import { hash } from "@zaly/shared"
import { Spawn } from "@zaly/shared/process"
import { mkdir } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "pathe"
import { createWorkspaceId } from "./ids.ts"

export type WorkspaceErrorCode =
  | "dirty-workspace"
  | "git-command-failed"
  | "not-a-git-repository"
  | "unknown-workspace"
  | "workspace-root-inside-repository"

/** A failure to allocate or release an isolated Git workspace. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    override readonly cause?: unknown
  ) {
    super(message, { cause })
    this.name = "WorkspaceError"
  }
}

export interface WorkspaceManagerOptions {
  /** Directory outside source repositories where isolated Worktrees are placed. */
  rootDir: string
}

export interface WritableWorkspaceRequest {
  /** Directory containing the Git repository used as the source. */
  cwd: string
  /** Run that owns the resulting Worktree. One writable workspace per Run in V1. */
  runId: RunId
  /** Allows a durable coordinator to restore a previously assigned id. */
  workspaceId?: WorkspaceId
}

export interface WorkspaceInspection {
  repositoryRoot: string
  headCommit: string
  dirty: boolean
}

export interface WorkspaceReleaseOptions {
  /**
   * Remove the Worktree from disk. Omitted by default so failed or
   * cancelled work remains inspectable until its Artifact is handled.
   */
  remove?: boolean
}

export interface WorkspaceReleaseResult {
  status: "preserved" | "removed"
}

/**
 * Allocates one detached Git Worktree per writable Run.
 *
 * V1 deliberately accepts only a clean repository. Capturing dirty state,
 * untracked files, and nested repositories needs an explicit snapshot format;
 * silently copying them would make a child's base revision ambiguous.
 */
export class WorkspaceManager {
  readonly #allocations = new Map<WorkspaceId, WorkspaceRef>()
  readonly #rootDir: string

  constructor(options: WorkspaceManagerOptions) {
    this.#rootDir = resolve(options.rootDir)
  }

  /** Verify that cwd is a clean Git Worktree and identify the revision to fork. */
  async inspect(cwd: string): Promise<WorkspaceInspection> {
    let repositoryRoot: string
    try {
      repositoryRoot = resolve(await this.#git(cwd, ["rev-parse", "--show-toplevel"]))
    } catch (error) {
      throw new WorkspaceError(
        "not-a-git-repository",
        `Cannot create an isolated workspace: ${cwd} is not a Git repository.`,
        error
      )
    }

    const [headCommit, status] = await Promise.all([
      this.#git(repositoryRoot, ["rev-parse", "HEAD"]),
      this.#gitBuffer(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
    ])

    return {
      dirty: status.length > 0,
      headCommit,
      repositoryRoot,
    }
  }

  /**
   * Create a detached Worktree at the current clean HEAD. The returned
   * baseCommit is later used to generate and validate a CodeArtifact.
   */
  async createWritable(request: WritableWorkspaceRequest): Promise<WorkspaceRef> {
    const inspection = await this.inspect(request.cwd)
    if (inspection.dirty) {
      throw new WorkspaceError(
        "dirty-workspace",
        "Cannot create a writable child workspace from a dirty Git working tree. Commit, stash, or use a read-only child first."
      )
    }

    const id = request.workspaceId ?? createWorkspaceId()
    if (this.#allocations.has(id)) {
      throw new WorkspaceError(
        "git-command-failed",
        `Workspace ${id} is already allocated by this manager.`
      )
    }

    const path = join(this.#rootDir, hash(inspection.repositoryRoot), request.runId)
    if (isPathWithin(inspection.repositoryRoot, path)) {
      throw new WorkspaceError(
        "workspace-root-inside-repository",
        "Workspace storage must be outside the source repository so creating a child cannot dirty its parent."
      )
    }
    await mkdir(dirname(path), { recursive: true })
    await this.#git(inspection.repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      path,
      inspection.headCommit,
    ])

    const workspace: WorkspaceRef = {
      access: "write",
      baseCommit: inspection.headCommit,
      id,
      kind: "worktree",
      ownerRunId: request.runId,
      path,
      repositoryRoot: inspection.repositoryRoot,
    }
    this.#allocations.set(id, workspace)
    return workspace
  }

  /**
   * Preserve Worktrees by default. Removal is explicit and only permitted for
   * a workspace created by this manager instance.
   */
  async release(
    workspace: WorkspaceRef,
    options: WorkspaceReleaseOptions = {}
  ): Promise<WorkspaceReleaseResult> {
    if (!options.remove) return { status: "preserved" }

    const allocation = this.#allocations.get(workspace.id)
    if (!allocation || allocation.path !== workspace.path || allocation.kind !== "worktree") {
      throw new WorkspaceError(
        "unknown-workspace",
        `Refusing to remove workspace ${workspace.id}: it was not allocated by this manager.`
      )
    }
    if (!allocation.repositoryRoot) {
      throw new WorkspaceError(
        "unknown-workspace",
        `Refusing to remove workspace ${workspace.id}: its Git repository is unknown.`
      )
    }

    await this.#git(allocation.repositoryRoot, ["worktree", "remove", "--force", allocation.path])
    this.#allocations.delete(workspace.id)
    return { status: "removed" }
  }

  async #git(cwd: string, args: readonly string[]): Promise<string> {
    const output = await this.#gitBuffer(cwd, args)
    return output.toString("utf8").trim()
  }

  async #gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
    try {
      const result = await new Spawn("git", args, { cwd, maxBuffer: 1024 * 1024 }).result
      if (result.code === 0) return result.stdout

      const stderr = result.stderr.toString("utf8").trim()
      throw new WorkspaceError(
        "git-command-failed",
        `Git command failed: git ${args.join(" ")}${stderr ? `\\n${stderr}` : ""}`
      )
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      throw new WorkspaceError(
        "git-command-failed",
        `Could not start git ${args.join(" ")}.`,
        error
      )
    }
  }
}

function isPathWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}
