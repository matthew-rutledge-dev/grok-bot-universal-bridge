// Cross-platform test runner: finds every *.test.ts and runs node's test runner with tsx.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["core", "adapters", "test", "scripts"];
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p);
    } else if (name.endsWith(".test.ts")) files.push(p);
  }
}
for (const r of roots) {
  try {
    walk(r);
  } catch {
    /* missing root */
  }
}
files.sort();
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "--test-timeout=60000", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
