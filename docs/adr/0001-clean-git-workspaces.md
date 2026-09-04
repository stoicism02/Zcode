# ADR 0001: Writable Runs start from a clean Git commit

## Status

Accepted for V1.

## Decision

A writable Run receives its own detached Git Worktree. It can be created only
when the parent repository has no staged, unstaged, or untracked changes. The
child records the current `HEAD` as `baseCommit`.

Read-only children may continue to use the parent's directory. A writable
child is rejected while the parent directory is dirty; the caller can commit,
stash, select a clean revision, or use a read-only child instead.

## Why

The base revision must unambiguously describe what the child saw. Automatically
copying a dirty tree, stashing it, or creating a hidden commit makes both the
future patch and the user's local state harder to reason about.

## Consequences

This first version does not support dirty snapshots, untracked-file transfer,
or nested-repository transfer. Those need an explicit snapshot format and will
be added only with matching Artifact and recovery semantics.
