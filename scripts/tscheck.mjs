// Syntax gate for TS files that matches how Pi/node actually load them.
// `node --check` alone does NOT reliably strip TS (it trips on generic var
// annotations and some casts), so we strip types with node's own
// stripTypeScriptTypes (the same transform the runtime uses), then --check the
// resulting plain-JS module. Usage: node scripts/tscheck.mjs <file.ts>...
import { stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "tscheck-"));
let failed = 0;

for (const f of process.argv.slice(2)) {
  try {
    const js = stripTypeScriptTypes(readFileSync(f, "utf8"), { mode: "strip" });
    const tmp = join(dir, "m.mjs");
    writeFileSync(tmp, js);
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (e) {
    failed++;
    const detail = e?.stderr?.toString?.() ?? e?.message ?? String(e);
    console.error(`✗ ${f}\n${detail}`);
  }
}

process.exit(failed ? 1 : 0);
