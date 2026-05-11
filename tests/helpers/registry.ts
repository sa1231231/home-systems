import { reviewAppliers, type Applier } from "../../src/needs-review/appliers.js";
import { registry as reverserRegistry, type Reverser } from "../../src/changelog/reversers.js";

/**
 * The applier registry and reverser registry are process-wide singletons. Tests
 * that register fakes need to clear them between cases so prior runs don't
 * leak. These helpers wipe + re-register in one call.
 */

export function clearAppliers(): void {
  // ApplierRegistry doesn't expose a clear, so reach in and wipe the map.
  const internal = reviewAppliers as unknown as { appliers: Map<string, Applier> };
  internal.appliers.clear();
}

export function setApplier(subjectKind: string, fn: Applier): void {
  clearAppliers();
  reviewAppliers.register(subjectKind, fn);
}

export function clearReversers(): void {
  const internal = reverserRegistry as unknown as { reversers: Map<string, Reverser> };
  internal.reversers.clear();
}

export function setReverser(operation: string, fn: Reverser): void {
  // Don't blanket-clear because some tests want to register multiple ops.
  const internal = reverserRegistry as unknown as { reversers: Map<string, Reverser> };
  internal.reversers.set(operation, fn);
}
