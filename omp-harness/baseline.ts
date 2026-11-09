// Le rouge de base : les tests que la suite complète de `main` échoue déjà, mesurés dans le même slot heavy,
// même commande, même environnement. Un échec de la suite d'un run ne bloque que s'il n'y est pas.
//
// La liste est calculée une fois par arbre de main (`main^{tree}`) : un worktree détaché temporaire, un seul
// lancement sans relance, mémorisé dans le cache heavy sous `baseline:<clé heavy>` (JSON des titres TAP). Les
// appels simultanés partagent le même calcul. Une base illisible — suite plantée sans TAP, délai, OOM, liste
// tronquée — rend `null` : l'appelant garde son comportement d'avant (rouge), jamais un vert par défaut.
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessConfig, RepoConfig } from "./config.ts";
import type { Store } from "./db.ts";
import type { Git } from "./git.ts";
import { cacheKey, heavyEnv, testCommand } from "./heavy.ts";
import type { HeavyResult, HeavyRunner } from "./heavy.ts";
import type { LogLine } from "./logger.ts";

/** Ce qu'une suite complète rouge doit à main : `failing` = `preexisting` + `new`, par titre TAP. */
export type BaselineJudgement = { failing: string[]; preexisting: string[]; new: string[] };

/** Les titres de `failing` partagés entre ceux que main échoue déjà et les autres. Un échec de main absent de `failing` n'est rien. */
export function judgeAgainst(failing: readonly string[], base: readonly string[]): BaselineJudgement {
  const known = new Set(base);
  return {
    failing: [...failing],
    preexisting: failing.filter((title) => known.has(title)),
    new: failing.filter((title) => !known.has(title)),
  };
}

/** La phrase d'un bloquant : seulement les nouveaux échecs nommés, le compte des préexistants à côté. */
export function newFailuresText(judgement: BaselineJudgement, limit = 20): string {
  const shown = judgement.new.slice(0, limit).join(" ; ");
  const more = judgement.new.length > limit ? ` ; … (+${judgement.new.length - limit})` : "";
  return `${judgement.new.length} échec(s) nouveau(x) par rapport à main (${judgement.preexisting.length} préexistant(s)) : ${shown}${more}`;
}

/** Le résumé d'une suite rouge « comme main » : pour la revue et la timeline. */
export function baselineSummary(judgement: BaselineJudgement): string {
  return judgement.new.length === 0
    ? `suite complète rouge comme main : ${judgement.preexisting.length} échec(s) préexistant(s), aucun nouveau`
    : newFailuresText(judgement);
}

export type BaselineDeps = {
  config: () => HarnessConfig;
  store: Store;
  git: Git;
  heavy: HeavyRunner;
  log?: LogLine;
  /** Le journal du run : `heavy_baseline`. */
  event: (runId: string, payload: Record<string, unknown>) => void;
};

/** Le préfixe des worktrees de base : `_` comme `_audit-<id>`, aucun run n'y prend son worktree. */
const WORKTREE_PREFIX = "_baseline-";

/** Les noms de tests nouveaux joints à l'événement, au plus. */
const EVENT_NAMES = 50;

export class Baseline {
  readonly #deps: BaselineDeps;
  readonly #flights = new Map<string, Promise<string[] | null>>();

  constructor(deps: BaselineDeps) {
    this.#deps = deps;
  }

  /**
   * Un résultat `full` rouge jugé contre main : `null` quand la base ne s'applique pas (résultat qui n'est pas un
   * rouge TAP lisible, main vert, base illisible), sinon la part préexistante et la part nouvelle.
   */
  async judge(
    run: { id: string; priority?: number },
    repo: RepoConfig,
    result: HeavyResult,
  ): Promise<BaselineJudgement | null> {
    const failing = result.tap?.failing;
    if (result.outcome !== "fail" || !failing || failing.length === 0) return null;
    const base = await this.#failingOnMain(run, repo);
    if (base === null || base.length === 0) return null;
    return judgeAgainst(failing, base);
  }

  /** Journalise ce qu'une suite rouge doit à main (`where` : la revue ou le merge) : la frise du run le relit. */
  record(runId: string, where: "review" | "merge", judgement: BaselineJudgement): void {
    this.#deps.event(runId, {
      scope: "full",
      where,
      failing: judgement.failing.length,
      preexisting: judgement.preexisting.length,
      new: judgement.new.length,
      newTests: judgement.new.slice(0, EVENT_NAMES),
    });
  }

  /** Les worktrees de base qu'un process mort a laissés derrière lui. */
  async recover(): Promise<void> {
    const { config, git } = this.#deps;
    for (const repo of config().repos) {
      const dir = path.join(config().worktreesDir, repo.name);
      const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith(WORKTREE_PREFIX)) : [];
      for (const name of left) await git.removeWorktree(repo.path, path.join(dir, name), null).catch(() => {});
    }
  }

  async #failingOnMain(run: { id: string; priority?: number }, repo: RepoConfig): Promise<string[] | null> {
    const { config, store, git } = this.#deps;
    try {
      const command = testCommand(repo, "full", []);
      if (command === null) return null;
      const main = await git.revParse(repo.path, repo.mainBranch);
      const tree = await git.run(repo.path, ["rev-parse", `${main}^{tree}`]);
      const worktree = path.join(config().worktreesDir, repo.name, `${WORKTREE_PREFIX}${tree.slice(0, 12)}`);
      const key = `baseline:${cacheKey(tree, command, heavyEnv(config(), worktree))}`;
      const hit = store.cacheGet(key);
      const known = hit ? parseTitles(hit.output) : null;
      if (known !== null) return known;
      const flying = this.#flights.get(key);
      if (flying) return await flying;
      const flight = this.#compute(run, repo, { key, tree, main, command, worktree }).finally(() => {
        this.#flights.delete(key);
      });
      this.#flights.set(key, flight);
      return await flight;
    } catch (err) {
      this.#deps.log?.(`rouge de base : ${err instanceof Error ? err.message : String(err)}`, {
        level: "warn",
        runId: run.id,
        repo: repo.name,
      });
      return null;
    }
  }

  /** La suite complète sur l'arbre de main, dans un worktree détaché rendu ensuite. */
  async #compute(
    run: { id: string; priority?: number },
    repo: RepoConfig,
    at: { key: string; tree: string; main: string; command: string; worktree: string },
  ): Promise<string[] | null> {
    const { store, git, heavy } = this.#deps;
    try {
      await git.addWorktree(repo.path, at.worktree, null, at.main);
      const result = await heavy.run({
        runId: run.id,
        stepId: null,
        repo,
        worktree: at.worktree,
        scope: "full",
        files: [],
        retry: false,
        ...(run.priority !== undefined ? { priority: run.priority } : {}),
      });
      // Délai, OOM, erreur, abandon : pas une base. Le cache n'accueille que `pass` ou `fail`.
      if (result.outcome !== "pass" && result.outcome !== "fail") return null;
      const titles = result.outcome === "pass" ? [] : (result.tap?.failing ?? null);
      // Un rouge sans le moindre `not ok` (suite plantée) n'est pas une base.
      if (titles === null || (result.outcome === "fail" && titles.length === 0)) return null;
      store.cachePut({
        key: at.key,
        repo: repo.name,
        tree: at.tree,
        command: at.command,
        outcome: result.outcome,
        exitCode: result.exitCode ?? -1,
        output: JSON.stringify(titles),
        durationMs: result.durationMs,
      });
      return titles;
    } finally {
      await git.removeWorktree(repo.path, at.worktree, null).catch(() => {});
    }
  }
}

function parseTitles(output: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(output);
    return Array.isArray(parsed) && parsed.every((title) => typeof title === "string") ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}
