import type { ArtifactId, RunId, WorkspaceId } from "./ids.ts"

export type ValidationStatus = "failed" | "passed" | "skipped"

export interface ValidationCheck {
  name: string
  status: ValidationStatus
  command?: readonly string[]
  durationMs?: number
  output?: string
}

export interface ValidationSummary {
  status: ValidationStatus
  checks: readonly ValidationCheck[]
}

/** Standard code delivery produced before an isolated workspace can be released. */
export interface CodeArtifact {
  id: ArtifactId
  runId: RunId
  workspaceId: WorkspaceId
  baseCommit: string
  headCommit?: string
  patch: string
  filesChanged: readonly string[]
  validation?: ValidationSummary
  createdAt: number
}
