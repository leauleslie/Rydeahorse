// Run the database suites one file at a time.
//
// `node --test test/*.test.js` runs FILES concurrently, and `--test-concurrency=1` did not
// reliably stop it here. Every suite truncates and reseeds the one shared database, so they
// cannot overlap — which is what the advisory lock in db.js enforces. But a lock only makes
// overlap safe, not fast: the suites end up queued on it, and a long one behind several others
// can sit long enough to look like a hang rather than a wait. `--test-isolation=none` is worse
// again, because every file's `before` hook then runs in one process and they deadlock on the
// same lock.
//
// So: one child process per file, in order, and the lock is never contended at all. It stays in
// db.js regardless — it is the thing that makes a stray `node --test test/writes.test.js` in
// another terminal safe, and this runner is only the fast path.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir).filter((f) => f.endsWith(".test.js")).sort();

let failed = 0;
const started = Date.now();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--test", join("test", file)], {
    cwd: join(testDir, ".."),
    stdio: "inherit",
    env: { NODE_NO_WARNINGS: "1", ...process.env },
  });
  if (result.status !== 0) failed++;
}

console.log(
  `\n${files.length} suite${files.length === 1 ? "" : "s"}, ` +
    `${failed === 0 ? "all passing" : `${failed} failing`}, ` +
    `${Math.round((Date.now() - started) / 1000)}s`,
);
process.exit(failed === 0 ? 0 : 1);
