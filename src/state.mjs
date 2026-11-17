import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { PluginError } from "./result.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function namespace(env = process.env) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        env.HERDR_SOCKET_PATH ?? env.HERDR_SOCKET ?? "",
        env.HERDR_SESSION ??
          env.HERDR_SESSION_NAME ??
          env.HERDR_REMOTE_SESSION ??
          "default",
      ]),
    )
    .digest("hex");
}
export function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function deadOwner(file) {
  const pid = Number(fs.readFileSync(file, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}
function reclaimLock(file) {
  const recovery = `${file}.recovery`;
  let fd;
  try {
    fd = fs.openSync(recovery, "wx", 0o600);
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    if (!deadOwner(file)) return false;
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return true;
    throw e;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(recovery);
  }
}
export class Store {
  constructor(directory = process.env.HERDR_PLUGIN_STATE_DIR) {
    if (!directory || !path.isAbsolute(directory))
      throw new PluginError(
        "missing_plugin_state_dir",
        "An absolute HERDR_PLUGIN_STATE_DIR is required.",
      );
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
      throw new PluginError(
        "unsafe_state",
        "State directory must not be a symlink.",
      );
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  file(id) {
    if (!UUID.test(id))
      throw new PluginError("invalid_association", "Invalid association ID.");
    return path.join(this.directory, `${id}.json`);
  }
  artifacts(id) {
    this.file(id);
    const dir = path.join(this.directory, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  get(id) {
    const r = JSON.parse(fs.readFileSync(this.file(id), "utf8"));
    if (
      r.schemaVersion !== 2 ||
      r.id !== id ||
      !path.isAbsolute(r.localRoot ?? "") ||
      typeof r.namespace !== "string"
    )
      throw new PluginError("invalid_state", "Invalid association record.");
    return r;
  }
  list() {
    return fs
      .readdirSync(this.directory)
      .filter((p) => UUID.test(p.replace(/\.json$/, "")) && p.endsWith(".json"))
      .map((p) => this.get(p.slice(0, -5)));
  }
  async withLock(
    id,
    fn,
    { attempts = 150, interval = 20, suffix = "operation" } = {},
  ) {
    const file = `${this.file(id)}.${suffix}.lock`;
    let fd;
    for (let i = 0; i < attempts; i++) {
      try {
        fd = fs.openSync(file, "wx", 0o600);
        fs.writeFileSync(fd, String(process.pid));
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try {
          if (deadOwner(file) && reclaimLock(file)) continue;
        } catch (e) {
          if (e.code === "ENOENT") continue;
          throw e;
        }
        await delay(interval);
      }
    }
    if (fd === undefined)
      throw new PluginError(
        "association_busy",
        "Another action owns this association; retry after it finishes.",
      );
    try {
      return await fn();
    } finally {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
    }
  }
  async create(record) {
    return this.withLock(
      record.id,
      () => {
        if (fs.existsSync(this.file(record.id)))
          throw new PluginError(
            "association_exists",
            "Association already exists.",
          );
        const r = {
          ...record,
          schemaVersion: 2,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        atomicJson(this.file(r.id), r);
        return r;
      },
      { suffix: "state" },
    );
  }
  async update(id, change) {
    return this.withLock(
      id,
      () => {
        const next = change(this.get(id));
        next.updatedAt = new Date().toISOString();
        atomicJson(this.file(id), next);
        return next;
      },
      { suffix: "state" },
    );
  }
}
