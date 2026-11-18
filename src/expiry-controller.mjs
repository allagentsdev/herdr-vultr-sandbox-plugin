import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store, atomicJson } from "./state.mjs";
import { Lifecycle } from "./lifecycle.mjs";
import { Cloud } from "./provider.mjs";
import { readPrivate } from "./config.mjs";
import { SSH } from "./ssh.mjs";
import { Remote } from "./remote.mjs";
import { PluginError } from "./result.mjs";
const entrypoint = fileURLToPath(import.meta.url);
const controllerId = "00000000-0000-4000-8000-000000000000";
export function monitoredWorkers(store) {
  return store
    .list()
    .filter(
      (r) =>
        r.expiry?.approvedAt &&
        r.expiry.session &&
        r.expiry.session.state !== "released" &&
        (r.vm || r.pending?.kind === "create"),
    );
}
export async function runExpiryJob(directory, id, session) {
  const store = new Store(directory),
    r = store.get(id);
  const api = new Cloud(readPrivate(r.config.tokenFile));
  const ssh = new SSH(store, r.config, { commandTimeout: 120000 });
  const life = new Lifecycle(store, api, new Remote(ssh));
  await life.expire(id, session);
}
export async function runController(directory) {
  const store = new Store(directory);
  await store.withLock(
    controllerId,
    async () => {
      const jobs = new Map(),
        retry = new Map();
      const receipt = path.join(directory, "expiry-controller.json");
      while (true) {
        const runtime = JSON.parse(
          fs.readFileSync(path.join(directory, "expiry-runtime.json"), "utf8"),
        );
        if (runtime.entrypoint !== entrypoint && jobs.size === 0) return;
        atomicJson(receipt, {
          instance: randomUUID(),
          pid: process.pid,
          heartbeat: new Date().toISOString(),
          guarantee:
            "host-user-service; requires online host and active user service",
        });
        for (const [id, nextAttempt] of retry) {
          if (nextAttempt <= Date.now()) retry.delete(id);
        }
        for (const r of monitoredWorkers(store)) {
          if (jobs.has(r.id) || (retry.get(r.id) ?? 0) > Date.now()) continue;
          const child = spawn(
            process.execPath,
            [entrypoint, "job", directory, r.id, r.expiry.session.id],
            {
              detached: false,
              stdio: "ignore",
              env: { PATH: process.env.PATH, HOME: process.env.HOME },
            },
          );
          jobs.set(r.id, child);
          const startedAt = Date.now();
          const timer = setTimeout(() => child.kill("SIGKILL"), 20 * 60000);
          const finish = async (code) => {
            clearTimeout(timer);
            jobs.delete(r.id);
            retry.set(r.id, Date.now() + 60000);
            if (code !== 0)
              await store.update(r.id, (v) =>
                v.expiry?.session?.id !== r.expiry.session.id ||
                Date.parse(v.expiry.lastControllerError?.at) >= startedAt
                  ? v
                  : {
                      ...v,
                      expiry: {
                        ...v.expiry,
                        lastControllerError: {
                          code: "expiry_job_failed",
                          at: new Date().toISOString(),
                        },
                      },
                    },
              );
          };
          child.once("error", () => {
            void finish(1).catch(() => {});
          });
          child.once("exit", (code) => {
            void finish(code).catch(() => {});
          });
        }
        await delay(5000);
      }
    },
    { suffix: "controller", attempts: 3 },
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === entrypoint) {
  const [mode, directory, id, session] = process.argv.slice(2);
  try {
    if (mode === "job") await runExpiryJob(directory, id, session);
    else if (mode === "run") await runController(directory);
    else throw new PluginError("invalid_controller_mode", "Use run or job.");
  } catch (error) {
    if (mode === "job") {
      try {
        const store = new Store(directory);
        await store.update(id, (r) =>
          r.expiry?.session?.id !== session
            ? r
            : {
                ...r,
                expiry: {
                  ...r.expiry,
                  lastControllerError: {
                    code:
                      error instanceof PluginError
                        ? error.code
                        : "expiry_job_failed",
                    at: new Date().toISOString(),
                  },
                },
              },
        );
      } catch {
        /* Resource state remains authoritative after a process failure. */
      }
    }
    process.exitCode = 1;
  }
}
