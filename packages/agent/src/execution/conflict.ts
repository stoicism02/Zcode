import type { CodeArtifact } from "./artifact.ts"

/* eslint-disable one-var -- Git checks are intentionally sequenced around early returns. */
import { Spawn } from "@zaly/shared/process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "pathe"

export type ArtifactConflictStatus = "blocked" | "clean" | "conflict"

export type ArtifactConflictReason =
  | "base-not-ancestor"
  | "dirty-target"
  | "git-command-failed"
  | "repository-mismatch"
  | "untracked-files-not-captured"

export interface ArtifactConflictCheck {
  status: ArtifactConflictStatus
  baseCommit: string
  targetCommit?: string
  conflictingFiles: readonly string[]
  reason?: ArtifactConflictReason
  message?: string
  checkedAt: number
}

export interface CheckArtifactConflictOptions {
  artifact: CodeArtifact
  /** Clean repository Worktree whose current HEAD would receive the Artifact. */
  cwd?: string
}

interface ConflictResultDetails {
  targetCommit: string
  conflictingFiles?: readonly string[]
  message?: string
}

/**
 * Checks whether a CodeArtifact can be mechanically applied to a target HEAD.
 *
 * The target Worktree is never modified. The patch is applied only inside a
 * disposable detached Worktree, and this class does not perform the real merge.
 */
export class ArtifactConflictChecker {
  async check(options: CheckArtifactConflictOptions): Promise<ArtifactConflictCheck> {
    const { artifact } = options
    const cwd = resolve(options.cwd ?? artifact.repositoryRoot)
    const repositoryRoot = await this.#gitText(cwd, ["rev-parse", "--show-toplevel"])
    if (!repositoryRoot.ok)
      return this.#blocked(artifact, "git-command-failed", repositoryRoot.error)

    if (resolve(repositoryRoot.stdout.trim()) !== resolve(artifact.repositoryRoot)) {
      return this.#blocked(
        artifact,
        "repository-mismatch",
        "The target Worktree does not belong to the Artifact repository."
      )
    }

    const [targetCommitResult, statusResult] = await Promise.all([
      this.#gitText(cwd, ["rev-parse", "HEAD"]),
      this.#git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
    ])
    if (!targetCommitResult.ok)
      return this.#blocked(artifact, "git-command-failed", targetCommitResult.error)
    const targetCommit = targetCommitResult.stdout.trim()
    if (!statusResult.ok)
      return this.#blocked(artifact, "git-command-failed", statusResult.error, targetCommit)
    if (statusResult.stdout.length > 0) {
      return this.#blocked(
        artifact,
        "dirty-target",
        "Conflict checking requires a clean target Worktree.",
        targetCommit
      )
    }

    if (artifact.untrackedFiles.length > 0) {
      return this.#blocked(
        artifact,
        "untracked-files-not-captured",
        "The Artifact reports untracked files whose contents were not captured.",
        targetCommit
      )
    }

    const ancestry = await this.#git(cwd, [
      "merge-base",
      "--is-ancestor",
      artifact.baseCommit,
      targetCommit,
    ])
    if (!ancestry.ok) {
      return this.#blocked(
        artifact,
        ancestry.code === 1 ? "base-not-ancestor" : "git-command-failed",
        ancestry.code === 1
          ? "The Artifact base commit is not an ancestor of the target HEAD."
          : ancestry.error,
        targetCommit
      )
    }

    if (artifact.patch.length === 0) return this.#result(artifact, "clean", { targetCommit })

    const temporaryRoot = await mkdtemp(join(tmpdir(), "zaly-conflict-check-"))
    const temporaryWorktree = join(temporaryRoot, "worktree")
    let worktreeAdded = false
    try {
      const add = await this.#git(artifact.repositoryRoot, [
        "worktree",
        "add",
        "--detach",
        temporaryWorktree,
        targetCommit,
      ])
      if (!add.ok) return this.#blocked(artifact, "git-command-failed", add.error, targetCommit)
      worktreeAdded = true

      const apply = await this.#git(
        temporaryWorktree,
        ["apply", "--3way", "--index", "--whitespace=nowarn", "-"],
        artifact.patch
      )
      if (apply.ok) return this.#result(artifact, "clean", { targetCommit })

      const unmerged = await this.#git(temporaryWorktree, [
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
      ])
      const conflictingFiles = unmerged.ok
        ? splitNullDelimited(unmerged.stdout)
        : [...artifact.filesChanged]
      return this.#result(artifact, "conflict", {
        conflictingFiles:
          conflictingFiles.length > 0 ? conflictingFiles : [...artifact.filesChanged],
        message: apply.error,
        targetCommit,
      })
    } finally {
      if (worktreeAdded) {
        await this.#git(artifact.repositoryRoot, [
          "worktree",
          "remove",
          "--force",
          temporaryWorktree,
        ])
      }
      await rm(temporaryRoot, { force: true, recursive: true })
    }
  }

  #blocked(
    artifact: CodeArtifact,
    reason: ArtifactConflictReason,
    message: string,
    targetCommit?: string
  ): ArtifactConflictCheck {
    return {
      baseCommit: artifact.baseCommit,
      checkedAt: Date.now(),
      conflictingFiles: [],
      message,
      reason,
      status: "blocked",
      targetCommit,
    }
  }

  #result(
    artifact: CodeArtifact,
    status: "clean" | "conflict",
    details: ConflictResultDetails
  ): ArtifactConflictCheck {
    return {
      baseCommit: artifact.baseCommit,
      checkedAt: Date.now(),
      conflictingFiles: details.conflictingFiles ?? [],
      message: details.message,
      status,
      targetCommit: details.targetCommit,
    }
  }

  async #git(
    cwd: string,
    args: readonly string[],
    stdin?: string
  ): Promise<
    | { ok: true; code: number; stdout: Buffer }
    | { ok: false; code: number; error: string; stdout: Buffer }
  > {
    try {
      const result = await new Spawn("git", args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        stdin,
      }).result
      if (result.code === 0) return { code: result.code, ok: true, stdout: result.stdout }
      return {
        code: result.code,
        error: result.stderr.toString("utf8").trim() || `git ${args.join(" ")} failed.`,
        ok: false,
        stdout: result.stdout,
      }
    } catch (error) {
      return {
        code: -1,
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        stdout: Buffer.alloc(0),
      }
    }
  }

  async #gitText(
    cwd: string,
    args: readonly string[]
  ): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    const result = await this.#git(cwd, args)
    return result.ok
      ? { ok: true, stdout: result.stdout.toString("utf8") }
      : { error: result.error, ok: false }
  }
}

function splitNullDelimited(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
}
