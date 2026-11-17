import { Store } from "../../src/state.mjs";
import { serveWorker } from "../../src/control.mjs";
const store = new Store(process.argv[2]),
  id = process.argv[3];
await serveWorker(store, id, () => ({ status: "alive" }));
process.send("ready");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
