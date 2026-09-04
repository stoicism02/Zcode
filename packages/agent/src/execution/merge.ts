import type { CodeArtifact } from "./artifact.ts"
import type { ArtifactConflictCheck } from "./conflict.ts"

/* eslint-disable one-var -- Git checks are intentionally sequenced around early returns. */
import { Spawn } from "@zaly/shared/process"
import { resolve } from "pathe"
import { ArtifactConflictChecker } from "./conflict.ts"

export type ArtifactMergeStatus = "applied" | "blocked" | "conflict"

export type ArtifactMergeReason =
  | "apply-failed"
  | "conflict-check-blocked"
  | "target-changed"
  | "validation-not-passed"

export interface ArtifactMergeResult {
  status: ArtifactMergeStatus
  artifactId: CodeArtifact["id"]
  targetCommit?: string
  reason?: ArtifactMergeReason
  message?: string
  conflict?: ArtifactConflictCheck
}

export interface ApplyArtifactOptions {
  artifact: CodeArtifact
  /** Parent Worktree that will receive the already-checked Artifact. */
  cwd?: string
}

export interface ArtifactMergerOptions {
  conflictChecker?: ArtifactConflictChecker
}

/**
 * Applies a verified CodeArtifact to a Parent Worktree without creating a
 * commit. Successful changes are staged for explicit review and commit.
 */
export class ArtifactMerger {
  readonly #conflictChecker: ArtifactConflictChecker

  constructor(options: ArtifactMergerOptions = {}) {
    this.#conflictChecker = options.conflictChecker ?? new ArtifactConflictChecker()
  }

  async apply(options: ApplyArtifactOptions): Promise<ArtifactMergeResult> {
    const { artifact } = options
    if (artifact.validation.status !== "passed") {
      return this.#blocked(
        artifact,
        "validation-not-passed",
        "An Artifact must pass validation before it can be applied."
      )
    }

    const cwd = resolve(options.cwd ?? artifact.repositoryRoot)
    const conflict = await this.#conflictChecker.check({ artifact, cwd })
    if (conflict.status !== "clean") {
      return {
        artifactId: artifact.id,
        conflict,
        message: conflict.message,
        reason: conflict.status === "blocked" ? "conflict-check-blocked" : undefined,
        status: conflict.status,
        targetCommit: conflict.targetCommit,
      }
    }

    const target = await this.#targetState(cwd)
    if (!target.ok) return this.#blocked(artifact, "apply-failed", target.error)
    if (target.commit !== conflict.targetCommit || target.dirty) {
      return this.#blocked(
        artifact,
        "target-changed",
        "The Parent Worktree changed after conflict checking; apply was not attempted.",
        target.commit
      )
    }

    // git apply is atomic unless --reject is supplied. --3way is retained so
    // this write has exactly the same semantics as the disposable pre-check.
    const applied = await this.#git(
      cwd,
      ["apply", "--3way", "--index", "--whitespace=nowarn", "-"],
      artifact.patch
    )
    if (!applied.ok) {
      return this.#blocked(
        artifact,
        "apply-failed",
        `Git did not apply the Artifact: ${applied.error}`,
        target.commit
      )
    }

    return {
      artifactId: artifact.id,
      status: "applied",
      targetCommit: target.commit,
    }
  }

  #blocked(
    artifact: CodeArtifact,
    reason: ArtifactMergeReason,
    message: string,
    targetCommit?: string
  ): ArtifactMergeResult {
    return {
      artifactId: artifact.id,
      message,
      reason,
      status: "blocked",
      targetCommit,
    }
  }

  async #targetState(
    cwd: string
  ): Promise<{ ok: true; commit: string; dirty: boolean } | { ok: false; error: string }> {
    const [head, status] = await Promise.all([
      this.#git(cwd, ["rev-parse", "HEAD"]),
      this.#git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
    ])
    if (!head.ok) return { error: head.error, ok: false }
    if (!status.ok) return { error: status.error, ok: false }
    return {
      commit: head.stdout.toString("utf8").trim(),
      dirty: status.stdout.length > 0,
      ok: true,
    }
  }

  async #git(
    cwd: string,
    args: readonly string[],
    stdin?: string
  ): Promise<{ ok: true; stdout: Buffer } | { ok: false; error: string; stdout: Buffer }> {
    try {
      const result = await new Spawn("git", args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        stdin,
      }).result
      if (result.code === 0) return { ok: true, stdout: result.stdout }
      return {
        error: result.stderr.toString("utf8").trim() || `git ${args.join(" ")} failed.`,
        ok: false,
        stdout: result.stdout,
      }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        stdout: Buffer.alloc(0),
      }
    }
  }
}
