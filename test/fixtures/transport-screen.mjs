// Synthetic TUI for Herdr transport-contract tests; never a real agent receipt.
import { createInterface } from "node:readline";
const render = (title, body) =>
  process.stdout.write(
    `\x1b[2J\x1b[H\x1b]0;${title}\x07${body}\n› Ask Codex to do anything\n`,
  );
render(
  "Transport fixture ready " + process.pid,
  "Synthetic Codex-shaped transport fixture",
);
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "exit-fixture") break;
  render("⠋ Working", "Working (1s • esc to interrupt)");
  await new Promise((resolve) => setTimeout(resolve, 900));
  render(
    "Transport fixture ready " + process.pid,
    "Synthetic fixture handled input",
  );
}
process.exit(0);
