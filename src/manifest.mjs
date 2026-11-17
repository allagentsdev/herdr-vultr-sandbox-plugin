import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runSync } from "./process.mjs";
import { safeRelative } from "./config.mjs";
import { PluginError } from "./result.mjs";
import { atomicJson } from "./state.mjs";

const BLOCKED = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aws",
  ".ssh",
  ".gnupg",
  ".docker",
  ".kube",
  ".terraform",
  ".vercel",
  ".daytona",
  ".vultr",
  ".hcloud",
  ".herdr",
  ".codex",
  ".claude",
  ".allagents",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "target",
  "coverage",
]);
const CREDENTIALS = new Set([
  ".npmrc",
  ".git-credentials",
  ".pypirc",
  ".netrc",
  ".yarnrc",
  ".yarnrc.yml",
  "credentials",
  "credentials.json",
  "service-account.json",
  "application_default_credentials.json",
  "auth.json",
  ".credentials.json",
]);
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function gitEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
export function git(root, args, options = {}) {
  return runSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd: root, env: gitEnvironment(), ...options },
  );
}
export function pathExclusionReason(p, c) {
  if (!safeRelative(p))
    throw new PluginError(
      "unsafe_path",
      "An unsafe repository-relative path was rejected.",
    );
  const parts = p.toLowerCase().split("/"),
    base = parts.at(-1);
  if (parts.some((v) => BLOCKED.has(v))) return "blocked-directory";
  if (base.startsWith(".env")) return "environment-file";
  if (
    CREDENTIALS.has(base) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore|kubeconfig|tfvars)|.*\.tfstate(?:\.backup)?)$/.test(
      base,
    )
  )
    return "credential-file";
  if (
    parts.includes("gcloud") ||
    parts.includes("hcloud") ||
    [
      ".pi/agent",
      ".codex/sessions",
      ".claude/projects",
      ".local/share/opencode",
    ].some((prefix) => `/${p.toLowerCase()}/`.includes(`/${prefix}/`))
  )
    return "agent-credentials";
  if (
    c.excludedPaths.some((pattern) => {
      if (pattern.startsWith("*."))
        return p.split("/").at(-1).endsWith(pattern.slice(1));
      const prefix = pattern.endsWith("/**")
        ? pattern.slice(0, -3)
        : pattern.replace(/\/$/, "");
      return p === prefix || p.startsWith(`${prefix}/`);
    })
  )
    return "configured-exclusion";
  return null;
}
export function contentExclusionReason(bytes) {
  const text = bytes.toString("utf8");
  try {
    const value = JSON.parse(text);
    if (
      (value?.type === "service_account" && value.private_key) ||
      (value?.auths &&
        Object.values(value.auths).some((a) => a?.auth || a?.identitytoken))
    )
      return "detected-secret";
  } catch {
    // Ordinary source is usually not JSON.
  }
  return /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|\bgh[opsu]_[A-Za-z0-9]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bsk_live_[A-Za-z0-9]{16,}\b|\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b|(?:^|\n)\s*machine\s+\S+[\s\S]{0,300}\bpassword\s+\S+|:_authToken\s*=\s*\S+/.test(
    text,
  )
    ? "detected-secret"
    : null;
}
export function assertSafeParents(root, p, { allowMissing = false } = {}) {
  if (!safeRelative(p)) throw new PluginError("unsafe_path", "Unsafe path.");
  let current = root;
  for (const part of p.split("/")) {
    current = path.join(current, part);
    let s;
    try {
      s = fs.lstatSync(current);
    } catch (e) {
      if (allowMissing && e.code === "ENOENT") return;
      throw e;
    }
    if (s.isSymbolicLink())
      throw new PluginError("symlink_path", "A path traverses a symlink.");
  }
}
function sameFile(a, b) {
  return ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode"].every(
    (k) => a[k] === b[k],
  );
}
export function readRegular(root, p, maxBytes) {
  assertSafeParents(root, p);
  const file = path.join(root, p),
    before = fs.lstatSync(file);
  if (!before.isFile())
    throw new PluginError(
      "not_regular_file",
      "Only regular files are supported.",
    );
  if (before.size > maxBytes)
    throw new PluginError("snapshot_limit", "File exceeds maxFileBytes.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!sameFile(before, fs.fstatSync(fd)))
      throw new PluginError("snapshot_race", "A file changed during capture.");
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const n = fs.readSync(
        fd,
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (!n) break;
      position += n;
    }
    assertSafeParents(root, p);
    if (
      position !== before.size ||
      !sameFile(before, fs.fstatSync(fd)) ||
      !sameFile(before, fs.lstatSync(file))
    )
      throw new PluginError("snapshot_race", "A file changed during capture.");
    return { bytes, mode: before.mode & 0o111 ? "100755" : "100644" };
  } finally {
    fs.closeSync(fd);
  }
}
function nestedRepository(root, p) {
  const parts = p.split("/");
  parts.pop();
  let dir = root;
  for (const component of parts) {
    dir = path.join(dir, component);
    if (fs.existsSync(path.join(dir, ".git"))) return true;
  }
  return false;
}
export function saveSnapshot(directory, entries, excluded = []) {
  fs.mkdirSync(path.join(directory, "files"), { recursive: true, mode: 0o700 });
  const files = entries
    .map(({ path: p, bytes, mode }) => {
      if (!safeRelative(p) || !["100644", "100755"].includes(mode))
        throw new PluginError("unsafe_path", "Unsafe snapshot entry.");
      const dest = path.join(directory, "files", p);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, bytes, { mode: 0o600, flag: "wx" });
      return { path: p, size: bytes.length, sha256: digest(bytes), mode };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(files.map((f) => f.path)).size !== files.length)
    throw new PluginError("unsafe_path", "Duplicate snapshot path.");
  const manifest = {
    schemaVersion: 1,
    files,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    excluded,
    digest: digest(JSON.stringify(files)),
  };
  atomicJson(path.join(directory, "manifest.json"), manifest);
  return { ...manifest, directory };
}
export function readSnapshot(directory) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    digest(JSON.stringify(manifest.files)) !== manifest.digest
  )
    throw new PluginError(
      "snapshot_corrupt",
      "Snapshot manifest integrity check failed.",
    );
  for (const f of manifest.files) {
    const { bytes } = readRegular(
      path.join(directory, "files"),
      f.path,
      f.size,
    );
    if (
      digest(bytes) !== f.sha256 ||
      bytes.length !== f.size ||
      !["100644", "100755"].includes(f.mode)
    )
      throw new PluginError(
        "snapshot_corrupt",
        "Snapshot content integrity check failed.",
      );
  }
  return { ...manifest, directory };
}
export function captureSnapshot(root, c, directory) {
  const raw = git(root, ["ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: null,
    maxBuffer: Math.max(32 * 1024 * 1024, c.maxFiles * 1024),
  }).stdout;
  if (!Buffer.from(raw.toString("utf8")).equals(raw))
    throw new PluginError(
      "unsafe_path",
      "Non-UTF-8 filenames are unsupported.",
    );
  const candidates = [
    ...new Set(
      raw
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .map((p) => p.replace(/\/$/, "")),
    ),
  ].sort();
  const ignored = candidates.length
    ? git(root, ["check-ignore", "--no-index", "-z", "--stdin"], {
        input: `${candidates.join("\0")}\0`,
        check: false,
      })
    : { status: 1, stdout: "" };
  if (![0, 1].includes(ignored.status))
    throw new PluginError(
      "snapshot_inventory",
      "Could not evaluate ignored files.",
    );
  const ignoreSet = new Set(ignored.stdout.split("\0"));
  const entries = [],
    excluded = [];
  let bytes = 0;
  for (const p of candidates) {
    const reason =
      pathExclusionReason(p, c) || (ignoreSet.has(p) ? "git-ignored" : null);
    if (reason) {
      excluded.push({ path: p, reason });
      continue;
    }
    try {
      if (nestedRepository(root, p)) {
        excluded.push({ path: p, reason: "nested-repository" });
        continue;
      }
      const entry = readRegular(root, p, c.maxFileBytes);
      const secret = contentExclusionReason(entry.bytes);
      if (secret) {
        excluded.push({ path: p, reason: secret });
        continue;
      }
      bytes += entry.bytes.length;
      if (entries.length >= c.maxFiles || bytes > c.maxUploadBytes)
        throw new PluginError(
          "snapshot_limit",
          "Snapshot exceeds configured file or byte limits.",
        );
      entries.push({ path: p, ...entry });
    } catch (e) {
      if (
        ["ENOENT", "ENOTDIR", "not_regular_file", "symlink_path"].includes(
          e.code,
        )
      ) {
        excluded.push({ path: p, reason: e.code });
        continue;
      }
      throw e;
    }
  }
  return saveSnapshot(directory, entries, excluded);
}
