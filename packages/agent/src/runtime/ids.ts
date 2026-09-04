import { uuidv7 } from "../utils/uuid.ts"

declare const runtimeIdBrand: unique symbol

/** Nominal identifier used to prevent mixing runtime entity ids. */
export type RuntimeId<T extends string> = string & { readonly [runtimeIdBrand]: T }

export type AgentActivationId = RuntimeId<"agent-activation">
export type AgentDefinitionId = RuntimeId<"agent-definition">
export type ArtifactId = RuntimeId<"artifact">
export type ProjectTaskId = RuntimeId<"project-task">
export type RunId = RuntimeId<"run">
export type WorkspaceId = RuntimeId<"workspace">

export const createAgentActivationId = (): AgentActivationId => uuidv7() as AgentActivationId
export const createAgentDefinitionId = (): AgentDefinitionId => uuidv7() as AgentDefinitionId
export const createArtifactId = (): ArtifactId => uuidv7() as ArtifactId
export const createProjectTaskId = (): ProjectTaskId => uuidv7() as ProjectTaskId
export const createRunId = (): RunId => uuidv7() as RunId
export const createWorkspaceId = (): WorkspaceId => uuidv7() as WorkspaceId
