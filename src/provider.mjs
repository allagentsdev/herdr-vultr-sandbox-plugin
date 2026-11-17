import { setTimeout as delay } from "node:timers/promises";
import { PluginError } from "./result.mjs";
const invalid = () => {
  throw new PluginError(
    "provider_invalid",
    "Provider response does not match the pinned Vultr contract.",
  );
};
export function resourceId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(id))
    throw new PluginError(
      "invalid_resource_id",
      "Expected a Vultr string resource ID.",
    );
  return id;
}
export function tagsFor(labels) {
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`);
}
function powerState(s) {
  if (s.status !== "active" || s.server_status !== "ok") return "transitioning";
  return s.power_status === "running"
    ? "running"
    : s.power_status === "stopped"
      ? "off"
      : "transitioning";
}
export class Cloud {
  constructor(
    token,
    { fetch: fetcher = fetch, interval = 1500, attempts = 240 } = {},
  ) {
    this.token = token;
    this.fetch = fetcher;
    this.interval = interval;
    this.attempts = attempts;
  }
  async request(method, url, body) {
    if (!url.startsWith("/") || url.startsWith("//")) invalid();
    let response;
    try {
      response = await this.fetch(`https://api.vultr.com/v2${url}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new PluginError(
        "outcome_unknown",
        "Provider request outcome unknown. Reconcile the retained operation before retrying.",
      );
    }
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) {
      // A timeout/conflict response can still describe an in-flight mutation.
      const uncertain =
        response.status >= 500 || [408, 409].includes(response.status);
      const error = new PluginError(
        uncertain ? "outcome_unknown" : "provider_rejected",
        `Vultr returned HTTP ${response.status}; response body withheld.`,
      );
      error.httpStatus = response.status;
      throw error;
    }
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      throw new PluginError(
        "outcome_unknown",
        "Provider response was incomplete; reconcile before retrying.",
      );
    }
  }
  async list(type) {
    if (!["instances", "snapshots", "blocks"].includes(type)) invalid();
    const result = [],
      cursors = new Set();
    let cursor;
    do {
      const data = await this.request(
        "GET",
        `/${type}?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (!Array.isArray(data?.[type]) || !data.meta?.links) invalid();
      result.push(...data[type]);
      cursor = data.meta.links.next;
      if (cursor && (typeof cursor !== "string" || cursors.has(cursor)))
        invalid();
      cursors.add(cursor);
    } while (cursor);
    return result;
  }
  async find(type, labels) {
    const all = await this.list(type);
    if (type === "instances") {
      const tags = tagsFor(labels);
      return all.filter((x) => tags.every((t) => x.tags?.includes(t)));
    }
    if (type === "snapshots")
      return all.filter((x) => x.description === labels.description);
    invalid();
  }
  async getServer(id) {
    const data = await this.request("GET", `/instances/${resourceId(id)}`);
    if (!data) return null;
    const s = data.instance;
    if (!s || s.id !== id) invalid();
    const blocks = await this.list("blocks");
    return {
      ...s,
      powerState: powerState(s),
      volumes: blocks
        .filter((b) => b.attached_to_instance === id)
        .map((b) => b.id),
    };
  }
  async getImage(id) {
    const data = await this.request("GET", `/snapshots/${resourceId(id)}`);
    if (!data) return null;
    if (!data.snapshot || data.snapshot.id !== id) invalid();
    return data.snapshot;
  }
  async waitStatus(id, status) {
    for (let i = 0; i < this.attempts; i++) {
      const s = await this.getServer(id);
      if (status === "deleted" && !s) return null;
      if (s?.powerState === status) return s;
      if (i + 1 < this.attempts) await delay(this.interval);
    }
    throw new PluginError(
      "status_pending",
      `Vultr has not confirmed ${status}; the operation receipt is retained.`,
    );
  }
  async waitSnapshot(id) {
    for (let i = 0; i < this.attempts; i++) {
      const s = await this.getImage(id);
      if (!s || ["error", "failed"].includes(s.status))
        throw new PluginError(
          "snapshot_unusable",
          "Snapshot is missing or failed. Instance and previous snapshot retained.",
        );
      if (s.status === "complete") return s;
      if (i + 1 < this.attempts) await delay(this.interval);
    }
    throw new PluginError(
      "snapshot_pending",
      "Snapshot is incomplete; the retained receipt can be reconciled.",
    );
  }
}
