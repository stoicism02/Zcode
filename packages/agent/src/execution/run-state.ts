import type { RunStatus, RunTerminalStatus } from "./types.ts"

const transitions = {
  cancelled: [],
  created: ["queued", "cancelled"],
  failed: [],
  interrupted: [],
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled", "interrupted"],
  succeeded: [],
} as const satisfies Record<RunStatus, readonly RunStatus[]>

export class InvalidRunTransitionError extends Error {
  readonly from: RunStatus
  readonly to: RunStatus

  constructor(from: RunStatus, to: RunStatus) {
    super(`invalid run status transition: ${from} -> ${to}`)
    this.name = "InvalidRunTransitionError"
    this.from = from
    this.to = to
  }
}

export function isRunTerminal(status: RunStatus): status is RunTerminalStatus {
  return transitions[status].length === 0
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return (transitions[from] as readonly RunStatus[]).includes(to)
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new InvalidRunTransitionError(from, to)
}
