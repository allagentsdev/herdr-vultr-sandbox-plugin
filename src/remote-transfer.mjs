import fs from "node:fs";
import path from "node:path";
import {
  captureSnapshot,
  readSnapshot,
  readRegular,
  saveSnapshot,
} from "./manifest.mjs";
const [mode, root, temporary, raw] = process.argv.slice(2),
  c = JSON.parse(raw);
let text = "";
for await (const chunk of process.stdin) text += chunk;
if (mode === "upload") {
  const input = JSON.parse(text);
  if (fs.existsSync(root))
    throw Error("Source already exists; upload is not replayed.");
  const snap = saveSnapshot(
    temporary,
    input.files.map((f) => ({ ...f, bytes: Buffer.from(f.bytes, "base64") })),
  );
  if (snap.digest !== input.digest) throw Error("Upload digest mismatch");
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
  fs.renameSync(path.join(temporary, "files"), root);
  for (const f of snap.files)
    fs.chmodSync(path.join(root, f.path), f.mode === "100755" ? 0o755 : 0o644);
  console.log(JSON.stringify({ digest: snap.digest }));
} else if (mode === "checkpoint" || mode === "verify") {
  try {
    const snapshot = captureSnapshot(root, c, temporary);
    console.log(JSON.stringify({ digest: snapshot.digest }));
  } finally {
    if (mode === "verify")
      fs.rmSync(temporary, { recursive: true, force: true });
  }
} else if (mode === "export") {
  try {
    const snapshot = captureSnapshot(root, c, temporary);
    console.log(
      JSON.stringify({
        files: snapshot.files.map((f) => ({
          ...f,
          bytes: readRegular(
            path.join(snapshot.directory, "files"),
            f.path,
            c.maxFileBytes,
          ).bytes.toString("base64"),
        })),
        excluded: snapshot.excluded,
        digest: readSnapshot(temporary).digest,
      }),
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} else throw Error("Invalid transfer operation");
