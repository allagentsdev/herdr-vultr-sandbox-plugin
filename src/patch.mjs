import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  git,
  digest,
  readSnapshot,
  pathExclusionReason,
  assertSafeParents,
  readRegular,
  contentExclusionReason,
  saveSnapshot,
} from "./manifest.mjs";
import { atomicJson } from "./state.mjs";
import { PluginError, safeText } from "./result.mjs";

function validateSnapshot(snapshot, c) {
  if (
    snapshot.files.length > c.maxFiles ||
    snapshot.totalBytes > c.maxUploadBytes
  )
    throw new PluginError(
      "snapshot_limit",
      "Returned snapshot exceeds configured limits.",
    );
  for (const f of snapshot.files) {
    if (pathExclusionReason(f.path, c))
      throw new PluginError(
        "excluded_patch_path",
        "Returned content includes an excluded path.",
      );
    if (
      f.size > c.maxFileBytes ||
      contentExclusionReason(
        readRegular(
          path.join(snapshot.directory, "files"),
          f.path,
          c.maxFileBytes,
        ).bytes,
      )
    )
      throw new PluginError(
        "excluded_patch_path",
        "Returned content exceeds file limits or contains a detected secret.",
      );
  }
}
function compareSnapshots(before, after) {
  const a = new Map(before.files.map((f) => [f.path, f])),
    b = new Map(after.files.map((f) => [f.path, f]));
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter(
      (p) =>
        a.get(p)?.sha256 !== b.get(p)?.sha256 ||
        a.get(p)?.mode !== b.get(p)?.mode,
    )
    .sort();
}
function buildPatch(before, after) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-vultr-diff-"));
  try {
    git(dir, ["init", "--bare", "-q"]);
    const tree = (snapshot) => {
      git(dir, ["read-tree", "--empty"]);
      const entries = snapshot.files
        .map((f) => {
          const bytes = readRegular(
            path.join(snapshot.directory, "files"),
            f.path,
            f.size,
          ).bytes;
          const oid = git(
            dir,
            ["hash-object", "--no-filters", "-w", "--stdin"],
            { input: bytes },
          ).stdout.trim();
          return `${f.mode} ${oid}\t${f.path}\0`;
        })
        .join("");
      if (entries)
        git(dir, ["update-index", "-z", "--index-info"], { input: entries });
      return git(dir, ["write-tree"]).stdout.trim();
    };
    const old = tree(before),
      next = tree(after);
    return git(
      dir,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        "--no-renames",
        old,
        next,
        "--",
      ],
      {
        encoding: null,
        maxBuffer: Math.max(
          32 * 1024 * 1024,
          5 * (before.totalBytes + after.totalBytes),
        ),
      },
    ).stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function reviewDirectory(store, id, artifact) {
  store.file(artifact);
  return path.join(store.artifacts(id), "reviews", artifact);
}
function destination(record) {
  let stat;
  try {
    stat = fs.lstatSync(record.localRoot);
  } catch {
    throw new PluginError(
      "destination_changed",
      "The destination worktree is missing.",
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== record.rootIdentity.dev ||
    stat.ino !== record.rootIdentity.ino ||
    fs.realpathSync(record.localRoot) !== record.localRoot
  )
    throw new PluginError(
      "destination_changed",
      "The destination worktree was replaced or moved.",
    );
  const actual = git(record.localRoot, ["rev-parse", "--show-toplevel"], {
    check: false,
  });
  if (actual.status !== 0 || actual.stdout.trim() !== record.localRoot)
    throw new PluginError(
      "destination_changed",
      "The destination no longer resolves to the captured Git worktree.",
    );
}
function verifiedCandidate(store, record, artifact, expectedDigest) {
  const dir = reviewDirectory(store, record.id, artifact);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(dir, "review.json"), "utf8"),
  );
  if (
    metadata.artifact !== artifact ||
    metadata.association !== record.id ||
    metadata.destination !== record.localRoot ||
    metadata.fromDigest !== record.checkpointDigest
  )
    throw new PluginError(
      "stale_artifact",
      "This review artifact no longer matches the association checkpoint.",
    );
  const patch = readRegular(
    dir,
    "changes.patch",
    record.config.maxUploadBytes * 10,
  ).bytes;
  if (digest(patch) !== expectedDigest || metadata.digest !== expectedDigest)
    throw new PluginError(
      "artifact_changed",
      "The reviewed patch bytes or digest changed.",
    );
  const before = readSnapshot(record.checkpoint),
    after = readSnapshot(path.join(dir, "next"));
  validateSnapshot(before, record.config);
  validateSnapshot(after, record.config);
  if (
    before.digest !== record.checkpointDigest ||
    after.digest !== metadata.nextDigest ||
    !patch.equals(buildPatch(before, after))
  )
    throw new PluginError(
      "artifact_changed",
      "The patch no longer matches the trusted content comparison.",
    );
  const changedPaths = compareSnapshots(before, after);
  return { metadata, patch, after, changedPaths };
}
function localMatches(record, snapshot, paths) {
  const files = new Map(snapshot.files.map((f) => [f.path, f]));
  return paths.every((p) => {
    assertSafeParents(record.localRoot, p, { allowMissing: true });
    const f = files.get(p);
    if (!f) return !fs.existsSync(path.join(record.localRoot, p));
    try {
      const entry = readRegular(
        record.localRoot,
        p,
        record.config.maxFileBytes,
      );
      return digest(entry.bytes) === f.sha256 && entry.mode === f.mode;
    } catch {
      return false;
    }
  });
}
function captureLocalPaths(root, paths, config, directory) {
  const entries = [];
  let total = 0;
  for (const p of paths) {
    assertSafeParents(root, p, { allowMissing: true });
    let entry;
    try {
      entry = readRegular(root, p, config.maxFileBytes);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    total += entry.bytes.length;
    if (total > config.maxUploadBytes * 2)
      throw new PluginError(
        "snapshot_limit",
        "Local approval receipt exceeds its byte limit.",
      );
    entries.push({ path: p, ...entry });
  }
  return saveSnapshot(directory, entries);
}
function approvalReceipt(store, record, artifact, candidate) {
  const id = randomUUID(),
    directory = path.join(
      reviewDirectory(store, record.id, artifact),
      "approvals",
      id,
    );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const before = captureLocalPaths(
    record.localRoot,
    candidate.changedPaths,
    record.config,
    path.join(directory, "before"),
  );
  const work = fs.mkdtempSync(path.join(directory, "work-"));
  try {
    git(work, ["init", "-q"]);
    for (const f of before.files) {
      const target = path.join(work, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(before.directory, "files", f.path), target);
      fs.chmodSync(target, f.mode === "100755" ? 0o755 : 0o644);
    }
    const applied = git(
      work,
      ["apply", "--binary", "--whitespace=nowarn", "-"],
      { input: candidate.patch, check: false },
    );
    if (applied.status !== 0)
      throw new PluginError(
        "patch_conflict",
        "The patch no longer applies to the captured local files. Nothing was changed in the destination.",
      );
    const after = captureLocalPaths(
      work,
      candidate.changedPaths,
      record.config,
      path.join(directory, "after"),
    );
    return {
      id,
      beforeDigest: before.digest,
      afterDigest: after.digest,
      before,
      after,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
function readApprovalReceipt(store, record, pending) {
  const receipt = pending.receipt;
  if (!receipt)
    throw new PluginError(
      "apply_recovery_required",
      "The retained approval receipt is incomplete. Inspect its artifact before recovery.",
    );
  store.file(receipt.id);
  const directory = path.join(
    reviewDirectory(store, record.id, pending.artifact),
    "approvals",
    receipt.id,
  );
  const before = readSnapshot(path.join(directory, "before")),
    after = readSnapshot(path.join(directory, "after"));
  if (
    before.digest !== receipt.beforeDigest ||
    after.digest !== receipt.afterDigest
  )
    throw new PluginError(
      "snapshot_corrupt",
      "Approval receipt integrity check failed.",
    );
  return { before, after };
}
async function recoverApply(store, record) {
  if (!record.pendingApply) return record;
  destination(record);
  const p = record.pendingApply,
    candidate = verifiedCandidate(store, record, p.artifact, p.digest);
  const receipt = readApprovalReceipt(store, record, p);
  if (!localMatches(record, receipt.after, candidate.changedPaths)) {
    if (localMatches(record, receipt.before, candidate.changedPaths))
      return store.update(record.id, (v) => ({ ...v, pendingApply: null }));
    throw new PluginError(
      "apply_recovery_required",
      "An approved apply was interrupted. Compare local files with the retained review artifact before retrying; checkpoint unchanged.",
    );
  }
  return store.update(record.id, (v) => ({
    ...v,
    checkpoint: candidate.after.directory,
    checkpointDigest: candidate.after.digest,
    pendingApply: null,
    lastAppliedArtifact: p.artifact,
  }));
}
export async function preparePatch(store, id, provider) {
  return store.withLock(id, async () => {
    const r = await recoverApply(store, store.get(id));
    destination(r);
    const before = readSnapshot(r.checkpoint);
    if (before.digest !== r.checkpointDigest)
      throw new PluginError(
        "snapshot_corrupt",
        "Checkpoint digest differs from the association.",
      );
    const artifact = randomUUID(),
      dir = reviewDirectory(store, id, artifact);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const after = readSnapshot(
      (await provider.exportSnapshot(r, path.join(dir, "next"))).directory,
    );
    validateSnapshot(before, r.config);
    validateSnapshot(after, r.config);
    const excluded = new Set(
      (after.excluded ?? [])
        .filter((e) => typeof e?.path === "string")
        .map((e) => e.path),
    );
    if (
      before.files.some((f) => {
        let current = f.path;
        while (current) {
          if (excluded.has(current)) return true;
          const slash = current.lastIndexOf("/");
          if (slash < 0) break;
          current = current.slice(0, slash);
        }
        return false;
      })
    )
      throw new PluginError(
        "incomplete_export",
        "A checkpoint path was filtered from the remote export. No deletion patch was generated; inspect excluded files or symlinks.",
      );
    const changedPaths = compareSnapshots(before, after),
      patch = buildPatch(before, after);
    if (patch.length > r.config.maxUploadBytes * 10)
      throw new PluginError(
        "patch_limit",
        "Patch exceeds the bounded review limit.",
      );
    if (!patch.length) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { status: "no_change", association: id };
    }
    const patchPath = path.join(dir, "changes.patch"),
      metadataPath = path.join(dir, "review.json");
    fs.writeFileSync(patchPath, patch, { mode: 0o600, flag: "wx" });
    const metadata = {
      schemaVersion: 1,
      artifact,
      association: id,
      destination: r.localRoot,
      fromDigest: before.digest,
      nextDigest: after.digest,
      digest: digest(patch),
      changedPaths,
      createdAt: new Date().toISOString(),
    };
    atomicJson(metadataPath, metadata);
    return {
      ...metadata,
      status: "review_required",
      patchPath,
      metadataPath,
      bytes: patch.length,
    };
  });
}
export function reviewText(candidate) {
  const bytes = fs.readFileSync(candidate.patchPath);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = Array.from(bytes, (b) =>
      b >= 128
        ? `\\x${b.toString(16).padStart(2, "0")}`
        : String.fromCharCode(b),
    ).join("");
  }
  const escaped = text.replace(
    // eslint-disable-next-line no-control-regex -- Display untrusted bytes visibly rather than executing or hiding them.
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    (c) =>
      `${c.charCodeAt(0) <= 255 ? "\\x" : "\\u"}${c
        .charCodeAt(0)
        .toString(16)
        .padStart(c.charCodeAt(0) <= 255 ? 2 : 4, "0")}`,
  );
  return `Destination: ${JSON.stringify(candidate.destination)}\nAssociation: ${candidate.association}\nArtifact: ${candidate.artifact}\nSHA-256: ${candidate.digest}\nChanged paths:\n${candidate.changedPaths.map((p) => JSON.stringify(p)).join("\n")}\n\n${safeText(escaped)}`;
}
export async function applyReviewedPatch(store, id, artifact, expectedDigest) {
  return store.withLock(id, async () => {
    let r = store.get(id);
    if (r.pendingApply) {
      r = await recoverApply(store, r);
      if (r.lastAppliedArtifact === artifact)
        return {
          status: "applied",
          association: id,
          artifact,
          recovered: true,
        };
    }
    destination(r);
    const candidate = verifiedCandidate(store, r, artifact, expectedDigest);
    for (const p of candidate.changedPaths)
      assertSafeParents(r.localRoot, p, { allowMissing: true });
    const args = ["apply", "--binary", "--whitespace=nowarn", "-"];
    const checked = git(r.localRoot, [...args.slice(0, -1), "--check", "-"], {
      input: candidate.patch,
      check: false,
    });
    if (checked.status !== 0)
      throw new PluginError(
        "patch_conflict",
        "git apply --check rejected this patch. Local files and checkpoint are unchanged.",
      );
    const receipt = approvalReceipt(store, r, artifact, candidate);
    await store.update(id, (v) => ({
      ...v,
      pendingApply: {
        artifact,
        digest: expectedDigest,
        receipt: {
          id: receipt.id,
          beforeDigest: receipt.beforeDigest,
          afterDigest: receipt.afterDigest,
        },
      },
    }));
    destination(r);
    for (const p of candidate.changedPaths)
      assertSafeParents(r.localRoot, p, { allowMissing: true });
    if (!localMatches(r, receipt.before, candidate.changedPaths))
      throw new PluginError(
        "patch_conflict",
        "Local files changed while preparing approval. No patch was applied; inspect the retained approval receipt.",
      );
    const applied = git(r.localRoot, args, {
      input: candidate.patch,
      check: false,
    });
    if (applied.status !== 0) {
      throw new PluginError(
        "patch_conflict",
        "git apply failed. Check the destination and retained review; checkpoint unchanged.",
      );
    }
    if (!localMatches(r, receipt.after, candidate.changedPaths))
      throw new PluginError(
        "apply_recovery_required",
        "Applied files do not match the reviewed result. Checkpoint unchanged; retained approval can be reconciled.",
      );
    await store.update(id, (v) => ({
      ...v,
      checkpoint: candidate.after.directory,
      checkpointDigest: candidate.after.digest,
      pendingApply: null,
      lastAppliedArtifact: artifact,
    }));
    return { status: "applied", association: id, artifact };
  });
}
