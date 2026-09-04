export interface DisposableResource {
  dispose: () => void | Promise<void>
}

export type ResourceCleanup = DisposableResource | (() => void | Promise<void>)

/**
 * Owns cleanup callbacks for resources created exclusively by one scope.
 * Cleanup is LIFO, idempotent, and best-effort across all registered resources.
 */
export class ResourceBag implements DisposableResource {
  #resources: ResourceCleanup[] = []
  #disposed = false
  #disposing?: Promise<void>

  get disposed(): boolean {
    return this.#disposed
  }

  add<T extends ResourceCleanup>(resource: T): T {
    if (this.#disposed || this.#disposing) {
      throw new Error("cannot add a resource to a disposed ResourceBag")
    }
    this.#resources.push(resource)
    return resource
  }

  dispose(): Promise<void> {
    if (this.#disposing) return this.#disposing
    if (this.#disposed) return Promise.resolve()
    this.#disposing = this.#disposeAll()
    return this.#disposing
  }

  async #disposeAll(): Promise<void> {
    const errors: unknown[] = []
    this.#disposed = true

    for (const resource of this.#resources.splice(0).toReversed()) {
      try {
        const cleanup = typeof resource === "function" ? resource : () => resource.dispose()
        // Cleanup is deliberately sequential so reverse ownership order is preserved.
        // oxlint-disable-next-line no-await-in-loop
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }

    if (errors.length > 0) throw new AggregateError(errors, "failed to dispose scope resources")
  }
}
