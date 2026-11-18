import fs from "node:fs";
import { Cloud } from "../../src/provider.mjs";
import { SSH } from "../../src/ssh.mjs";

const fixture = JSON.parse(
  fs.readFileSync(process.env.VULTR_OBSERVATION_FIXTURE, "utf8"),
);
globalThis.fetch = () => {
  throw Error("Network is forbidden in the synthetic observation fixture.");
};
Cloud.prototype.getServer = async (id) => {
  if (id !== fixture.server.id) throw Error("Unexpected synthetic server ID.");
  return fixture.server;
};
SSH.prototype.exec = function (record, command) {
  if (command.startsWith("test -d "))
    return { status: 0, stdout: fixture.probeOutput };
  if (command.includes("guest-herdr.mjs") && command.includes("'inspect'"))
    return { status: 0, stdout: JSON.stringify(fixture.session) };
  if (command.startsWith("tmux display-message "))
    return { status: 0, stdout: fixture.legacyOutput };
  throw Error("Unexpected command in the synthetic observation fixture.");
};
