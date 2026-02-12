import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * @param {string[]} nodeArgs
 * @returns {Promise<number>}
 */
function runNode(nodeArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function collectTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTests(full)));
      continue;
    }
    if (entry.isFile() && /\.test\.js$/i.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const wantCoverage = args.includes("--coverage");
  const filtered = args.filter((a) => a !== "--coverage");

  const root = filtered[0];
  if (!root) {
    console.error("usage: node scripts/run-tests.mjs [--coverage] <dir>");
    process.exit(2);
  }

  const st = await stat(root).catch(() => null);
  if (!st || !st.isDirectory()) {
    console.error(`test directory not found: ${root}`);
    process.exit(2);
  }

  const testFiles = await collectTests(root);
  if (testFiles.length === 0) {
    console.error(`no test files found under: ${root}`);
    process.exit(1);
  }

  const baseArgs = ["--test", ...testFiles];
  if (!wantCoverage) {
    process.exit(await runNode(baseArgs));
  }

  // Coverage is best-effort: Node's built-in coverage reporter has had
  // intermittent crashes across Node 20.x patch releases.
  const coverageArgs = ["--test", "--experimental-test-coverage", ...testFiles];
  const coverageExit = await runNode(coverageArgs);
  if (coverageExit === 0) {
    process.exit(0);
  }

  console.warn(
    "Warning: coverage run failed; rerunning tests without coverage to determine pass/fail.",
  );
  process.exit(await runNode(baseArgs));
}

await main();
