import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

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

  const nodeArgs = ["--test"];
  if (wantCoverage) {
    // Works on Node 20+ (and still accepted on newer versions).
    nodeArgs.push("--experimental-test-coverage");

    // CI robustness: restrict reporting to our compiled sources only.
    // The Node coverage reporter can crash when it tries to summarize certain
    // non-project files (e.g., generated artifacts or runtime internals).
    const distRoot = path.resolve(root, "..");
    const compiledSrc = path.join(distRoot, "src", "**", "*.js");
    nodeArgs.push(`--test-coverage-include=${compiledSrc}`);
    nodeArgs.push("--test-coverage-exclude=**/node_modules/**");
    nodeArgs.push("--test-coverage-exclude=**/proto/**");
  }
  nodeArgs.push(...testFiles);

  const child = spawn(process.execPath, nodeArgs, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
}

await main();
