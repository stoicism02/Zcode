# ADR 0002: Preserve a workspace until its code delivery is handled

## Status

Accepted for V1.

## Decision

Worktrees are preserved by default when a Run completes, fails, or is
cancelled. They may be removed only through an explicit release operation.

Before automatic cleanup is introduced, the Run must have a durable Artifact
with at least its `baseCommit`, changed files, patch, and validation result.

## Why

A child Worktree is evidence of the Run's result. Deleting it before its
Artifact is persisted makes failed validation, merge conflicts, and cancelled
work difficult to inspect or recover.

## Consequences

V1 trades disk space for debuggability. A later retention policy can remove
only verified Artifact-backed workspaces, with an explicit TTL and user-facing
inspection/recovery commands.
