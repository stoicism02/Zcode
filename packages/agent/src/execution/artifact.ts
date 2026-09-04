import type { ArtifactId, RunId, WorkspaceId } from "./ids.ts"
import type { WorkspaceRef } from "./types.ts"

import { Spawn } from "@zaly/shared/process"
import { resolve } from "pathe"
import { createArtifactId } from "./ids.ts"

export type ValidationStatus = "failed" | "not-run" | "passed"

export interface ValidationCheck {
  name: string
  status: ValidationStatus
  command: readonly string[]
  durationMs?: number
  exitCode?: number
  output?: string
  truncated?: boolean
}

export interface ValidationSummary {
  status: ValidationStatus
  checks: readonly ValidationCheck[]
}

/** Standard code delivery captured before an isolated workspace can be released. */
export interface CodeArtifact {
  id: ArtifactId
  runId: RunId
  workspaceId: WorkspaceId
  repositoryRoot: string
  workspacePath: string
  baseCommit: string
  headCommit?: string
  patch: string
  filesChanged: readonly string[]
  /** Untracked relative paths are reported, but their contents are not captured in V1. */
  untrackedFiles: readonly string[]
  validation: ValidationSummary
  createdAt: number
}

/** Compact delivery information safe to surface in a parent Agent's context. */
export interface CodeArtifactSummary {
  id: ArtifactId
  baseCommit: string
  headCommit?: string
  filesChanged: readonly string[]
  untrackedFiles: readonly string[]
  validationStatus: ValidationStatus
}

export function summarizeCodeArtifact(artifact: CodeArtifact): CodeArtifactSummary {
  return {
    baseCommit: artifact.baseCommit,
    filesChanged: artifact.filesChanged,
    headCommit: artifact.headCommit,
    id: artifact.id,
    untrackedFiles: artifact.untrackedFiles,
    validationStatus: artifact.validation.status,
  }
}

export type ArtifactErrorCode = "git-command-failed" | "invalid-workspace"

/** A failure to turn a Worktree into a reviewable code delivery. */
export class ArtifactError extends Error {
  constructor(
    readonly code: ArtifactErrorCode,
    message: string,
    override readonly cause?: unknown
  ) {
    super(message, { cause })
    this.name = "ArtifactError"
  }
}

export interface ArtifactCollectorOptions {
  /** Maximum buffered Git patch size. Larger artifacts need explicit storage semantics. */
  maxPatchBytes?: number
}

export interface CollectCodeArtifactOptions {
  runId: RunId
  workspace: WorkspaceRef
  /** Validation is supplied by the future RunCoordinator; collection does not run commands. */
  validation?: ValidationSummary
}

/**
 * Captures the Git-visible delivery from a writable Worktree before it can be
 * released. It is intentionally in-memory for now; durable storage belongs to
 * the later RunStore stage.
 */
export class ArtifactCollector {
  readonly #maxPatchBytes: number

  constructor(options: ArtifactCollectorOptions = {}) {
    this.#maxPatchBytes = options.maxPatchBytes ?? 10 * 1024 * 1024
  }

  async collect(options: CollectCodeArtifactOptions): Promise<CodeArtifact> {
    const { workspace } = options
    if (
      workspace.access !== "write" ||
      workspace.kind !== "worktree" ||
      !workspace.baseCommit ||
      !workspace.repositoryRoot
    ) {
      throw new ArtifactError(
        "invalid-workspace",
        "A CodeArtifact requires a writable Git Worktree with a baseCommit and repositoryRoot."
      )
    }

    const workspacePath = resolve(workspace.path)
    const reportedWorktreeRoot = await this.#git(workspacePath, ["rev-parse", "--show-toplevel"])
    const worktreeRoot = resolve(reportedWorktreeRoot.trim())
    if (worktreeRoot !== workspacePath) {
      throw new ArtifactError(
        "invalid-workspace",
        "A CodeArtifact must be collected from the root of its assigned Worktree."
      )
    }

    const [headCommit, patch, changed, untracked] = await Promise.all([
      this.#git(workspacePath, ["rev-parse", "HEAD"]),
      this.#git(workspacePath, ["diff", "--binary", "--no-ext-diff", workspace.baseCommit, "--"]),
      this.#gitBuffer(workspacePath, ["diff", "--name-only", "-z", workspace.baseCommit, "--"]),
      this.#gitBuffer(workspacePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ])

    return {
      baseCommit: workspace.baseCommit,
      createdAt: Date.now(),
      filesChanged: splitNullDelimited(changed),
      headCommit: headCommit.trim(),
      id: createArtifactId(),
      patch,
      repositoryRoot: workspace.repositoryRoot,
      runId: options.runId,
      untrackedFiles: splitNullDelimited(untracked),
      validation: options.validation ?? { checks: [], status: "not-run" },
      workspaceId: workspace.id,
      workspacePath,
    }
  }

  async #git(cwd: string, args: readonly string[]): Promise<string> {
    const output = await this.#gitBuffer(cwd, args)
    return output.toString("utf8")
  }

  async #gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
    try {
      const result = await new Spawn("git", args, {
        cwd,
        maxBuffer: this.#maxPatchBytes,
      }).result
      if (result.code === 0) return result.stdout

      const stderr = result.stderr.toString("utf8").trim()
      throw new ArtifactError(
        "git-command-failed",
        `Git command failed: git ${args.join(" ")}${stderr ? `\\n${stderr}` : ""}`
      )
    } catch (error) {
      if (error instanceof ArtifactError) throw error
      throw new ArtifactError("git-command-failed", `Could not start git ${args.join(" ")}.`, error)
    }
  }
}

function splitNullDelimited(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
}
