import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const compose = readFileSync(join(root, "compose.example.yml"), "utf8");

test("Dockerfile and compose.example.yml pin uid 100:gid 101 and hardened defaults", () => {
  assert.match(dockerfile, /^USER 100:101$/m);
  assert.match(dockerfile, /chown 100:101 \/app\/data \/backup/);
  assert.match(dockerfile, /adduser -u 100\b/);
  assert.match(dockerfile, /addgroup -g 101\b/);

  assert.match(compose, /^\s*user:\s*"100:101"\s*$/m);
  assert.match(compose, /^\s*cap_drop:\s*$/m);
  assert.match(compose, /^\s*-\s*ALL\s*$/m);
  assert.match(compose, /^\s*-\s*no-new-privileges:true\s*$/m);
  assert.match(compose, /^\s*read_only:\s*true\s*$/m);
  assert.match(compose, /^\s*-\s*\/tmp(?::|$)/m);
  assert.match(compose, /"127\.0\.0\.1:18090:18090"/);
  // Writable paths only: state/logs volume and the backup bind mount (config/registry stay :ro).
  assert.match(compose, /bridge-data:\/app\/data/);
  assert.match(compose, /:\/backup:rw/);
  assert.match(compose, /:\/app\/config:ro/);
  assert.match(compose, /registry\.json:\/run\/bridge\/registry\.json:ro/);
});
