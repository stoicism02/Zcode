import type { ValidationCheck, ValidationStatus, ValidationSummary } from "./artifact.ts"
import type { WorkspaceRef } from "./types.ts"

import { Spawn } from "@zaly/shared/process"

export interface ValidationCheckDefinition {
  /** Stable, user-facing label such as `typecheck`, `test`, or `lint`. */
  name: string
  /** Trusted executable plus arguments. This runner never invokes a shell. */
  command: readonly string[]
  timeoutMs?: number
}

export interface ValidationProfile {
  checks: readonly ValidationCheckDefinition[]
  maxOutputBytes?: number
  timeoutMs?: number
}

export interface ValidationRunOptions {
  signal?: AbortSignal
}

/** Runs a trusted validation profile inside one writable Worktree. */
export class ValidationRunner {
  async run(
    workspace: WorkspaceRef,
    profile: ValidationProfile,
    options: ValidationRunOptions = {}
  ): Promise<ValidationSummary> {
    if (workspace.access !== "write" || workspace.kind !== "worktree") {
      throw new Error("ValidationRunner requires a writable Worktree.")
    }
    if (profile.checks.length === 0) return { checks: [], status: "not-run" }

    const checks: ValidationCheck[] = []
    // Running checks serially keeps test, lint, and typecheck from competing
    // for the same package-manager cache and generated files.
    for (const check of profile.checks) {
      checks.push(await this.#runCheck(workspace, check, profile, options))
    }

    return {
      checks,
      status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
    }
  }

  async #runCheck(
    workspace: WorkspaceRef,
    definition: ValidationCheckDefinition,
    profile: ValidationProfile,
    options: ValidationRunOptions
  ): Promise<ValidationCheck> {
    const [command, ...args] = definition.command
    const startedAt = Date.now()
    if (!command) {
      return {
        command: definition.command,
        durationMs: Date.now() - startedAt,
        name: definition.name,
        output: "Validation command is empty.",
        status: "failed",
      }
    }

    try {
      const result = await new Spawn(command, args, {
        cwd: workspace.path,
        maxBuffer: profile.maxOutputBytes ?? 1024 * 1024,
        signal: options.signal,
        timeout: definition.timeoutMs ?? profile.timeoutMs,
      }).result
      const output = joinOutput(result.stdout, result.stderr)
      const truncated = result.killReason === "maxBuffer"
      const status: ValidationStatus = result.code === 0 && !result.killed ? "passed" : "failed"

      return {
        command: definition.command,
        durationMs: Date.now() - startedAt,
        exitCode: result.code,
        name: definition.name,
        output: output === "" ? undefined : output,
        status,
        truncated: truncated || undefined,
      }
    } catch (error) {
      return {
        command: definition.command,
        durationMs: Date.now() - startedAt,
        name: definition.name,
        output: error instanceof Error ? error.message : String(error),
        status: "failed",
      }
    }
  }
}

function joinOutput(stdout: Buffer, stderr: Buffer): string {
  const parts = [stdout.toString("utf8").trim(), stderr.toString("utf8").trim()].filter(
    (part) => part !== ""
  )
  return parts.join("\n")
}
