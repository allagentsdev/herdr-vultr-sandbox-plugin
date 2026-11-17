import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runSync } from "./process.mjs";
import { readPrivate } from "./config.mjs";
import { PluginError } from "./result.mjs";
export class HostIdentities {
  constructor(store) {
    this.store = store;
  }
  directory(workerId, operation) {
    this.store.file(operation);
    return path.join(
      this.store.artifacts(workerId),
      "host-identities",
      operation,
    );
  }
  prepare(workerId, operation) {
    const directory = this.directory(workerId, operation);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const privateKeyFile = path.join(directory, "ed25519");
    if (!fs.existsSync(privateKeyFile))
      runSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "herdr-vm-server-host-key",
        "-f",
        privateKeyFile,
      ]);
    readPrivate(privateKeyFile);
    const publicKey = runSync("ssh-keygen", [
      "-y",
      "-f",
      privateKeyFile,
    ]).stdout.trim();
    const fingerprint =
      "SHA256:" +
      createHash("sha256")
        .update(Buffer.from(publicKey.split(" ")[1], "base64"))
        .digest("base64")
        .replace(/=+$/, "");
    return {
      purpose: "vm-server-host-identity",
      workerId,
      operation,
      privateKeyFile,
      publicKey,
      fingerprint,
    };
  }
  cloudConfig(identity, publicKey) {
    const expected = path.join(
      this.directory(identity.workerId, identity.operation),
      "ed25519",
    );
    if (
      identity.purpose !== "vm-server-host-identity" ||
      identity.privateKeyFile !== expected
    )
      throw new PluginError(
        "invalid_host_identity",
        "VM server host identity provenance is invalid.",
      );
    return (
      "#cloud-config\n" +
      JSON.stringify(
        {
          ssh_deletekeys: true,
          disable_root: false,
          ssh_pwauth: false,
          ...(publicKey
            ? {
                users: [
                  {
                    name: "root",
                    lock_passwd: true,
                    ssh_authorized_keys: [publicKey],
                  },
                ],
              }
            : {}),
          ssh_keys: {
            ed25519_private: readPrivate(expected) + "\n",
            ed25519_public: identity.publicKey + "\n",
          },
          ssh_quiet_keygen: true,
          ssh_publish_hostkeys: { enabled: false },
        },
        null,
        2,
      ) +
      "\n"
    );
  }
}
