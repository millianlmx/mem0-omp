// Le rapport de tests d'une étape /impl ou /impl --fix : le dernier passage `run_tests`, compté
// critère par critère. Une fonction pure : le harness le joint au run comme preuve `test_report`.
import * as path from "node:path";
import type { RepoConfig } from "./config.ts";
import { OUTPUT_TAIL, testFiles } from "./heavy.ts";
import type { HeavyResult } from "./heavy.ts";
import { tapTally } from "./tap.ts";
import type { TapCount } from "./tap.ts";

/** Les slugs des fichiers de test de `files` selon `tests.pattern` du dépôt (nom de base sans `.test.<ext>`/`.spec.<ext>`). */
export function reportSlugs(repo: RepoConfig, files: readonly string[]): string[] {
  const slugs = new Set<string>();
  for (const file of testFiles(repo, [...files])) {
    const slug = /^(.+?)\.(?:test|spec)\.[A-Za-z0-9]+$/.exec(path.basename(file))?.[1];
    if (slug !== undefined) slugs.add(slug);
  }
  return [...slugs].sort();
}

type Criterion = { id: string; slug: string | null; ac: string } & TapCount;

/**
 * Le rapport d'un passage. Une clé `<slug>/AC-n` est un critère si le slug est celui d'un fichier de
 * test du run ET si `AC-n` est dans ses specs ; une clé `AC-n` nue, si `AC-n` y est. Tout le reste
 * (autre slug, critère inconnu, test sans id) compte dans `other`. Deux clés ne s'additionnent jamais.
 */
export function testReport(
  result: HeavyResult,
  scope: "touched" | "full",
  step: "impl" | "fix",
  own: { slugs: readonly string[]; acIds: readonly string[] },
): { title: string; data: Buffer } {
  const tally = result.tap ?? tapTally(result.output);
  const criteria: Criterion[] = [];
  const other = { ...tally.other };
  for (const [key, count] of Object.entries(tally.ids)) {
    const cut = key.lastIndexOf("/");
    const slug = cut < 0 ? null : key.slice(0, cut);
    const ac = key.slice(cut + 1);
    if ((slug === null || own.slugs.includes(slug)) && own.acIds.includes(ac))
      criteria.push({ id: key, slug, ac, ...count });
    else {
      other.tests += count.tests;
      other.passed += count.passed;
      other.failed += count.failed;
    }
  }
  const num = (c: Criterion) => Number(c.ac.slice(3));
  criteria.sort(
    (a, b) =>
      Number(a.slug !== null) - Number(b.slug !== null) ||
      (a.slug ?? "").localeCompare(b.slug ?? "") ||
      num(a) - num(b),
  );
  const body = {
    step,
    scope,
    outcome: result.outcome,
    exitCode: result.exitCode,
    cached: result.cached,
    skipped: result.skipped,
    // Seul un résultat servi par le cache est compté sur la fin gardée de sa sortie.
    truncated: result.tap === null && result.output.length >= OUTPUT_TAIL,
    criteria,
    other,
  };
  return {
    title: `Rapport de tests — /${step === "fix" ? "impl --fix" : "impl"}`,
    data: Buffer.from(JSON.stringify(body), "utf8"),
  };
}
