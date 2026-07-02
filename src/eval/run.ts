/**
 * eval/run — fixture runner: clone a pinned real repo, drive the pipeline headlessly
 * on a target model, score the produced artifact, check expectations, optionally
 * judge with a capable model. Reuses the tested pure cores; this file is the
 * (untestable) orchestration shell.
 *
 *   node src/eval/run.ts [--only <name>] [--target small|capable] [--runs N]
 *                        [--judge] [--judge-model <id>] [--variant <agentDir>]
 */

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, globSync, cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { parseFixture, checkExpectations, type Fixture } from "./fixtures.ts";
import { scorecard, extractCitedPaths } from "./scorers.ts";
import { repoUniverse } from "./repo.ts";
import { judgePrompt, parseJudgeVerdict, type JudgeVerdict } from "./judge.ts";

const WB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = join(WB_ROOT, "src", "index.ts");
const FIXTURES_DIR = join(WB_ROOT, "evals", "fixtures");
const REPO_CACHE = join(WB_ROOT, "evals", ".repos");
const RESULTS_DIR = join(WB_ROOT, "evals", "results");

interface Flags {
  only?: string;
  target: "small" | "capable";
  runs: number;
  judge: boolean;
  judgeModel: string;
  variant?: string;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { target: "small", runs: 1, judge: false, judgeModel: "sonnet" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") f.only = argv[++i];
    else if (a === "--target") f.target = argv[++i] as Flags["target"];
    else if (a === "--runs") f.runs = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    else if (a === "--judge") f.judge = true;
    else if (a === "--judge-model") f.judgeModel = argv[++i];
    else if (a === "--variant") f.variant = argv[++i];
  }
  return f;
}

const PI_TIMEOUT_MS = (Number.parseInt(process.env.PI_RUN_TIMEOUT ?? "", 10) || 900) * 1000;

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, timeoutMs = PI_TIMEOUT_MS) {
  return spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: timeoutMs, env: { ...process.env, ...env } });
}

/** Clone (cached) the pinned repo, then copy into a fresh scratch working dir. */
function prepareRepo(fx: Fixture): string {
  let src: string;
  if (fx.repo.startsWith("http") || fx.repo.startsWith("git@")) {
    const cache = join(REPO_CACHE, `${fx.name}@${fx.ref ?? "HEAD"}`);
    if (!existsSync(cache)) {
      mkdirSync(REPO_CACHE, { recursive: true });
      const clone = run("git", ["clone", "--depth", "1", ...(fx.ref ? ["--branch", fx.ref] : []), fx.repo, cache], WB_ROOT);
      if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);
    }
    src = cache;
  } else {
    src = fx.repo.startsWith("/") ? fx.repo : join(WB_ROOT, fx.repo);
  }
  const work = mkdtempSync(join(tmpdir(), `wbeval-${fx.name}-`));
  cpSync(src, work, { recursive: true });
  // ensure a git repo for grounding + beads
  if (!existsSync(join(work, ".git"))) {
    run("git", ["init", "-q"], work);
    run("git", ["add", "-A"], work);
    run("git", ["commit", "-qm", "eval-seed", "--no-verify"], work, { GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "e@e.co", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "e@e.co" });
  }
  return work;
}

function pi(prompt: string, work: string, flags: Flags): void {
  const env: NodeJS.ProcessEnv = { WORKBENCH_TIER: flags.target };
  if (flags.variant) env.PI_CODING_AGENT_DIR = flags.variant;
  // --approve: the scratch repo is freshly cloned and untrusted; without this Pi
  // runs in a restricted mode that skips extensions/packages (no subagent manager).
  run("pi", ["-e", EXT, "--approve", "-nc", "--no-session", "-p", prompt], work, env);
}

function judge(fx: Fixture, content: string, flags: Flags): JudgeVerdict | null {
  const type = basename(fx.artifact, ".md");
  const res = run(
    "pi",
    ["--provider", "anthropic", "--model", flags.judgeModel, "-nt", "--no-session", "-p", judgePrompt(type, content)],
    WB_ROOT,
    undefined,
    180_000,
  );
  return parseJudgeVerdict(res.stdout ?? "");
}

function findArtifact(work: string, pattern: string): string | undefined {
  const hits = globSync(pattern, { cwd: work }).sort();
  return hits.length ? join(work, hits[hits.length - 1]) : undefined;
}

function main() {
  const flags = parseFlags(process.argv.slice(2));
  const fixtures = existsSync(FIXTURES_DIR)
    ? readdirSync(FIXTURES_DIR)
        .filter((d) => existsSync(join(FIXTURES_DIR, d, "fixture.json")))
        .filter((d) => !flags.only || d === flags.only)
    : [];
  if (fixtures.length === 0) {
    console.error(`No fixtures in ${FIXTURES_DIR}${flags.only ? ` matching "${flags.only}"` : ""}.`);
    process.exit(2);
  }

  const results: unknown[] = [];
  for (const name of fixtures) {
    const fx = parseFixture(JSON.parse(readFileSync(join(FIXTURES_DIR, name, "fixture.json"), "utf-8")));
    for (let r = 1; r <= flags.runs; r++) {
      const label = `${fx.name} [${flags.target}] run ${r}/${flags.runs}`;
      try {
        const work = prepareRepo(fx);
        console.log(`  ${label}: work=${work}`);
        if (fx.bundle) run("bundle", ["install", "--quiet"], work, undefined, 900_000);
        if (["wb-execution", "wb-implement"].includes(fx.command)) run("bd", ["init"], work);
        for (const s of fx.setup) pi(s, work, flags);
        pi(`/${fx.command} ${fx.args}`.trim(), work, flags);

        const artifactPath = findArtifact(work, fx.artifact);
        if (!artifactPath) {
          console.log(`✗ ${label}: artifact not produced (${fx.artifact})`);
          results.push({ fixture: fx.name, target: flags.target, run: r, error: "no artifact" });
          continue;
        }
        const md = readFileSync(artifactPath, "utf-8");
        const card = scorecard(md, { universe: repoUniverse(dirname(artifactPath), extractCitedPaths(md)), requiredHeadings: fx.requiredHeadings });
        const cited = extractCitedPaths(md);
        const exp = checkExpectations(card, cited, fx.expect);
        const verdict = flags.judge ? judge(fx, md, flags) : null;

        const j = verdict ? `  judge ${Math.round(verdict.average * 100)}%` : "";
        console.log(
          `${exp.pass ? "✓" : "✗"} ${label}: overall ${Math.round(card.overall * 100)}%  grounding ${Math.round(card.pathGrounding.score * 100)}% (${card.pathGrounding.grounded}/${card.pathGrounding.cited})${j}` +
            (exp.failures.length ? `\n    ${exp.failures.join("; ")}` : ""),
        );
        results.push({ fixture: fx.name, target: flags.target, run: r, overall: card.overall, card, expectations: exp, judge: verdict });
      } catch (e) {
        console.log(`✗ ${label}: ${e instanceof Error ? e.message : String(e)}`);
        results.push({ fixture: fx.name, target: flags.target, run: r, error: String(e) });
      }
    }
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = join(RESULTS_DIR, `${flags.target}-latest.json`);
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nResults → ${out}`);
}

main();
