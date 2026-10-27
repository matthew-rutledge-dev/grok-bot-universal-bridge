// Leak check: this repo goes public, so the tracked tree must stay generic.
// Scans every tracked file (plus optional commit messages / PR body files given as args) for:
//   - secrets (token-looking strings, private keys)
//   - URLs whose host is not an example/loopback/well-known docs host
//   - IPv4 addresses outside 127.0.0.0/8 and the documentation ranges
//   - Discord-style snowflakes and VIN-like strings that are not obvious placeholders
//   - email addresses outside example.com / users.noreply.github.com
//   - any word from LEAK_DENYLIST_FILE (one per line; keep that file OUT of the repo)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => !/package-lock\.json$/.test(f));
const extra = process.argv.slice(2);

const ALLOWED_HOSTS = [
  /(^|\.)example\.(com|org|net)$/, /\.(test|invalid)$/, /^127\.0\.0\.1$/, /^localhost$/, /^\[::1\]$/,
  /^github\.com$/, /^docs\.github\.com$/, /^nodejs\.org$/, /^discord\.com$/, /^developer\.tesla\.com$/,
];
const placeholderNum = (n) => /^(\d)\1+$/.test(n) || /^[1-9]0+\d{0,2}$/.test(n);
const checks = [
  { name: "secret", re: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,})\b/g },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "url", re: /\bhttps?:\/\/([A-Za-z0-9.\-\[\]:]+)/g, ok: (m) => ALLOWED_HOSTS.some((h) => h.test(m[1].replace(/:\d*$/, ""))) },
  { name: "ipv4", re: /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, ok: (m) => m[1] === "127" || m[0] === "0.0.0.0" || /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(m[0]) || /^\d+\.\d+\.\d+$/.test(m[0]) },
  { name: "snowflake", re: /\b\d{17,20}\b/g, ok: (m) => placeholderNum(m[0]) },
  { name: "vin", re: /\b[A-HJ-NPR-Z0-9]{17}\b/g, ok: (m) => !/\d/.test(m[0]) || !/[A-Z]/.test(m[0]) || /^(EXAMPLE|OTHER)/.test(m[0]) },
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, ok: (m) => /(^|\.)example\.(com|org)$|users\.noreply\.github\.com$/.test(m[1]) },
];
let deny = [];
const denyFile = process.env.LEAK_DENYLIST_FILE;
if (denyFile && existsSync(denyFile)) {
  deny = readFileSync(denyFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

const findings = [];
function scan(label, text) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const c of checks) {
      for (const m of line.matchAll(c.re)) if (!c.ok || !c.ok(m)) findings.push(`${label}:${i + 1}: ${c.name}: ${m[0].slice(0, 60)}`);
    }
    for (const w of deny) if (line.toLowerCase().includes(w.toLowerCase())) findings.push(`${label}:${i + 1}: denylisted word (#${deny.indexOf(w) + 1})`);
  });
}
for (const f of files) {
  if (!existsSync(f)) continue;
  const buf = readFileSync(f);
  if (buf.includes(0)) continue; // binary
  scan(f, buf.toString("utf8"));
}
for (const f of extra) scan(f, readFileSync(f, "utf8"));
const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
scan("branch-name", branch);
scan("commit-messages", execFileSync("git", ["log", "--format=%an <%ae>%n%B"], { encoding: "utf8" }));

if (findings.length) {
  console.error(`leak-check: ${findings.length} finding(s)`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`leak-check: clean (${files.length} tracked files, branch, commit messages${extra.length ? `, ${extra.join(", ")}` : ""}${deny.length ? `, ${deny.length} private denylist words` : ""})`);
