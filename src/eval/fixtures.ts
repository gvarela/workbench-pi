/**
 * eval/fixtures — pure fixture parsing + expectation checking.
 *
 * A fixture points the pipeline at a REAL repo (pinned to a ref) and declares what
 * a good result looks like. The runner (src/eval/run.ts) does the clone/generate;
 * the pure logic here parses the spec and grades the produced artifact's scorecard
 * against the fixture's expectations.
 */

import type { Scorecard } from "./scorers.ts";

export interface FixtureExpect {
  minOverall?: number;
  minGrounding?: number;
  mustCite?: string[];
  mustNotCite?: string[];
}

export interface Fixture {
  name: string;
  repo: string; // git url or local path
  ref?: string; // pinned tag/sha (for url repos)
  setup: string[]; // slash-commands to run before `command`
  command: string; // e.g. "wb-research"
  args: string;
  artifact: string; // glob relative to repo root
  requiredHeadings: string[];
  bundle: boolean; // run `bundle install` before the command (implement fixtures)
  testCommand?: string; // e.g. "bundle exec rspec"
  expect: FixtureExpect;
}

export function parseFixture(json: unknown): Fixture {
  if (!json || typeof json !== "object") throw new Error("fixture must be an object");
  const o = json as Record<string, unknown>;
  const req = (k: string): string => {
    const v = o[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`fixture missing required string "${k}"`);
    return v;
  };
  return {
    name: req("name"),
    repo: req("repo"),
    ref: typeof o.ref === "string" ? o.ref : undefined,
    setup: Array.isArray(o.setup) ? (o.setup as string[]) : [],
    command: req("command"),
    args: typeof o.args === "string" ? o.args : "",
    artifact: req("artifact"),
    requiredHeadings: Array.isArray(o.requiredHeadings) ? (o.requiredHeadings as string[]) : [],
    bundle: o.bundle === true,
    testCommand: typeof o.testCommand === "string" ? o.testCommand : undefined,
    expect: (o.expect && typeof o.expect === "object" ? o.expect : {}) as FixtureExpect,
  };
}

export interface ExpectationResult {
  pass: boolean;
  failures: string[];
}

/** Grade a produced artifact's scorecard + cited paths against fixture expectations. */
export function checkExpectations(card: Scorecard, citedPaths: string[], expect: FixtureExpect): ExpectationResult {
  const failures: string[] = [];
  const cited = new Set(citedPaths);
  if (expect.minOverall != null && card.overall < expect.minOverall)
    failures.push(`overall ${card.overall} < ${expect.minOverall}`);
  if (expect.minGrounding != null && card.pathGrounding.score < expect.minGrounding)
    failures.push(`grounding ${card.pathGrounding.score} < ${expect.minGrounding}`);
  for (const p of expect.mustCite ?? []) if (!cited.has(p)) failures.push(`missing required citation: ${p}`);
  for (const p of expect.mustNotCite ?? []) if (cited.has(p)) failures.push(`forbidden citation present: ${p}`);
  return { pass: failures.length === 0, failures };
}
