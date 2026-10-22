// Regenerates examples/expected/ with the built CLI (run `npm run build` first).
// These files illustrate the output for the README; the tests check hand-computed values independently.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const cli = (args) => spawnSync(process.execPath, ["dist/cli/main.js", ...args], { stdio: "inherit" });
rmSync("examples/expected", { recursive: true, force: true });
mkdirSync("examples/expected", { recursive: true });
cli(["convert", "examples/valid-fills.csv", "--out", "examples/expected/valid"]);
cli(["convert", "examples/broken-fills.csv", "--out", "examples/expected/broken"]);
cli(["convert", "examples/custom/broker-fills.csv", "--mapping", "examples/custom/broker-mapping.json", "--out", "examples/expected/custom"]);
cli(["convert", "examples/okx/okx-unified-bill-sample.csv", "--out", "examples/expected/okx"]);
