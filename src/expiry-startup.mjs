import { Store } from "./state.mjs";
import { ensureController } from "./expiry-service.mjs";
import { emitFailure } from "./result.mjs";
try {
  const store = new Store();
  if (store.list().some((r) => r.expiry?.approvedAt))
    await ensureController(store);
} catch (error) {
  emitFailure("automatic-hibernation-controller", error);
  process.exitCode = 1;
}
