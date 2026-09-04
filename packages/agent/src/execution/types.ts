import type {
  AgentActivationId,
  AgentDefinitionId,
  ArtifactId,
  ProjectTaskId,
  RunId,
  WorkspaceId,
} from "./ids.ts"

export type ProjectTaskStatus = "blocked" | "cancelled" | "completed" | "ready"

/** A user-visible unit of work. Execution attempts are represented by Runs. */
export interface ProjectTask {
  id: ProjectTaskId
  title: string
  description?: string
  dependsOn: readonly ProjectTaskId[]
  status: ProjectTaskStatus
  createdAt: number
}

/** Reusable role/configuration identity, independent of a particular execution. */
export interface AgentDefinition {
  id: AgentDefinitionId
  name: string
  description?: string
  modelId?: string
}

/** One concrete agent instance participating in one Run. */
export interface AgentActivation {
  id: AgentActivationId
  definitionId?: AgentDefinitionId
  runId: RunId
  workspaceId: WorkspaceId
  parentId?: AgentActivationId
  createdAt: number
}

export type WorkspaceKind = "shared" | "worktree"
export type WorkspaceAccess = "read" | "write"

/** Stable description of the filesystem boundary assigned to an activation. */
export interface WorkspaceRef {
  id: WorkspaceId
  path: string
  kind: WorkspaceKind
  access: WorkspaceAccess
  ownerRunId?: RunId
  baseCommit?: string
}

export type RunStatus = "created" | "queued" | "running" | RunTerminalStatus
export type RunTerminalStatus = "cancelled" | "failed" | "interrupted" | "succeeded"

/** Durable state for one concrete execution attempt of a ProjectTask. */
export interface RunRecord {
  id: RunId
  taskId: ProjectTaskId
  status: RunStatus
  activationId?: AgentActivationId
  workspaceId?: WorkspaceId
  artifactIds: readonly ArtifactId[]
  parentRunId?: RunId
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  cancellationReason?: string
}
