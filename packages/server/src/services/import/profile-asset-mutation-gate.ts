import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";

type GateMode = "mutation" | "maintenance";
type GateWaiter = {
  mode: GateMode;
  admit: (release: () => void) => void;
};

/**
 * Process-wide fair reader/writer gate for profile asset paths.
 *
 * Ordinary asset writers are "readers": they may run concurrently with each
 * other. Profile restore is the exclusive maintenance writer because its
 * rollback snapshot must remain authoritative until promotion, recovery fsync,
 * and staging cleanup have all finished.
 */
class ProfileAssetMutationGate {
  private activeMutations = 0;
  private maintenanceActive = false;
  private readonly waiters: GateWaiter[] = [];

  acquireMutation(): Promise<() => void> {
    return this.acquire("mutation");
  }

  acquireMaintenance(): Promise<() => void> {
    return this.acquire("maintenance");
  }

  private acquire(mode: GateMode): Promise<() => void> {
    return new Promise((admit) => {
      this.waiters.push({ mode, admit });
      this.drain();
    });
  }

  private drain(): void {
    if (this.maintenanceActive || this.waiters.length === 0) return;
    const next = this.waiters[0]!;
    if (next.mode === "maintenance") {
      if (this.activeMutations > 0) return;
      this.waiters.shift();
      this.maintenanceActive = true;
      next.admit(
        this.releaseOnce(() => {
          this.maintenanceActive = false;
          this.drain();
        }),
      );
      return;
    }

    // Admit only the shared entries ahead of the first queued maintenance
    // request. New mutations cannot starve an already-waiting restore.
    while (this.waiters[0]?.mode === "mutation" && !this.maintenanceActive) {
      const mutation = this.waiters.shift()!;
      this.activeMutations += 1;
      mutation.admit(
        this.releaseOnce(() => {
          this.activeMutations -= 1;
          this.drain();
        }),
      );
    }
  }

  private releaseOnce(release: () => void): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }
}

const profileAssetMutationGate = new ProfileAssetMutationGate();
type GateLease = {
  mode: GateMode;
  releaseGate: () => void;
  references: number;
  released: boolean;
  drained: Promise<void>;
  resolveDrained: () => void;
};
type GateContext = { lease: GateLease | null; active: boolean };
const profileAssetGateContext = new AsyncLocalStorage<GateContext>();
let profileAssetMaintenanceEpoch = 0;

function createGateLease(mode: GateMode, releaseGate: () => void): GateLease {
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  return { mode, releaseGate, references: 1, released: false, drained, resolveDrained };
}

function retainGateLease(lease: GateLease): void {
  if (lease.released || lease.references < 1) throw new Error("Profile state admission is no longer active");
  lease.references += 1;
}

function releaseGateLeaseReference(lease: GateLease): void {
  if (lease.released || lease.references < 1) return;
  lease.references -= 1;
  if (lease.references > 0) return;
  lease.released = true;
  lease.releaseGate();
  lease.resolveDrained();
}

export function getProfileAssetMaintenanceEpoch(): number {
  return profileAssetMaintenanceEpoch;
}

async function runWithFreshProfileAssetMutation<T>(operation: () => Promise<T>): Promise<T> {
  const lease = createGateLease("mutation", await profileAssetMutationGate.acquireMutation());
  const context: GateContext = { lease, active: true };
  return profileAssetGateContext.run(context, async () => {
    try {
      return await operation();
    } finally {
      context.active = false;
      context.lease = null;
      releaseGateLeaseReference(lease);
    }
  });
}

export async function runWithProfileAssetMutation<T>(operation: () => Promise<T>): Promise<T> {
  // A helper invoked inside a request or maintenance operation already owns the
  // relevant admission. Re-acquiring a shared slot behind a waiting restore
  // would deadlock the outer shared holder.
  if (profileAssetGateContext.getStore()?.active) return operation();
  return runWithFreshProfileAssetMutation(operation);
}

/** A fire-and-forget child must outlive, rather than borrow, its request lease. */
export function runWithDetachedProfileAssetMutation<T>(operation: () => Promise<T>): Promise<T> {
  const inherited = profileAssetGateContext.getStore();
  if (inherited?.active && inherited.lease) {
    // This child belongs to an already-admitted logical mutation. Retain that
    // exact lease synchronously, even if maintenance is already queued, so the
    // parent cannot release stale captured work onto the restored profile.
    const lease = inherited.lease;
    retainGateLease(lease);
    const context: GateContext = { lease, active: true };
    return profileAssetGateContext.run(context, async () => {
      try {
        return await operation();
      } finally {
        context.active = false;
        context.lease = null;
        releaseGateLeaseReference(lease);
      }
    });
  }
  return runWithFreshProfileAssetMutation(operation);
}

export async function runWithProfileAssetMaintenanceExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const inherited = profileAssetGateContext.getStore();
  if (inherited?.active && inherited.lease?.mode === "maintenance") return operation();
  if (inherited?.active && inherited.lease?.mode === "mutation") {
    // Upgrade an unsafe HTTP import without waiting on our own shared slot.
    // Retained detached children finish on the old side before maintenance can
    // begin. Leave the inherited route context inactive afterwards;
    // re-acquiring shared would withhold a completed response behind the next
    // queued restore.
    const mutationLease = inherited.lease;
    inherited.active = false;
    inherited.lease = null;
    releaseGateLeaseReference(mutationLease);
    await mutationLease.drained;
    const maintenanceLease = createGateLease("maintenance", await profileAssetMutationGate.acquireMaintenance());
    profileAssetMaintenanceEpoch += 1;
    inherited.lease = maintenanceLease;
    inherited.active = true;
    try {
      return await operation();
    } finally {
      inherited.active = false;
      inherited.lease = null;
      releaseGateLeaseReference(maintenanceLease);
    }
  }

  const lease = createGateLease("maintenance", await profileAssetMutationGate.acquireMaintenance());
  profileAssetMaintenanceEpoch += 1;
  const context: GateContext = { lease, active: true };
  return profileAssetGateContext.run(context, async () => {
    try {
      return await operation();
    } finally {
      context.active = false;
      context.lease = null;
      releaseGateLeaseReference(lease);
    }
  });
}

function isUnsafeRequest(request: FastifyRequest): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

/**
 * Put every HTTP mutation in the shared side of the gate. This is deliberately
 * registered above the route tree so new upload/delete/generation routes do not
 * need a fragile per-endpoint allowlist. A current-format restore upgrades its
 * request lease to exclusive after parsing/staging and before its first rollback
 * snapshot; legacy import remains an ordinary shared mutation.
 */
export function installProfileAssetMutationRequestGate(app: FastifyInstance): void {
  app.addHook("onRoute", (routeOptions) => {
    const originalHandler = routeOptions.handler;
    routeOptions.handler = async function (request, reply) {
      if (!isUnsafeRequest(request)) {
        return originalHandler.call(this, request, reply);
      }
      // Wrap the handler promise itself. Socket close/abort can happen while a
      // handler is still compensating an asset write, so response lifecycle
      // events are not a safe release boundary.
      return runWithProfileAssetMutation(() => Promise.resolve(originalHandler.call(this, request, reply)));
    };
  });
}
