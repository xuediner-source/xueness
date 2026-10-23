/** Kernel-only hooks; not exported from the package index. */

/** `ctx[KERNEL_EMIT](event, ...args)` emits `internal/*` events, which plugins cannot emit. */
export const KERNEL_EMIT: unique symbol = Symbol("xueness.kernel.emit");
