// La CI de la forge comme juge de la suite complète (`repos[].tests.judge: "ci"`).
//
// Le slot heavy est un conteneur Linux qui ne ressemble pas à la CI du dépôt : il rend
// des faux échecs (outils absents) et laisse passer de vrais (TypeScript, lint). Avec
// `judge: "ci"`, la suite complète n'est JAMAIS lancée ici : la branche du run est poussée
// (`--force-with-lease`), sa PR ouverte en BROUILLON, et le harness attend les checks de la
// forge sur le SHA exact poussé, au plus `tests.ciTimeoutSec` secondes.
//
// Le verdict prend la forme d'un résultat heavy (scope `full`) : `HeavyRunner` le cache par
// arbre, le rend au runner et à la revue comme un résultat local.
// - `pass` : tous les checks exigés par la protection de la branche principale sont verts
//   (à défaut d'en exiger, tous les checks) ;
// - `fail` : un check de ce lot est rouge ; la sortie nomme chaque job rouge, son URL et un
//   extrait filtré de ses logs (contenu NON FIABLE, rendu par `untrusted()`) ;
// - `timeout` : la CI n'a pas fini à temps — jamais un vert ;
// - `error` : le geste de forge ou le push a échoué (aucun verdict).
import { ciTimeoutSec } from "./config.ts";
import type { HarnessConfig } from "./config.ts";
import type { Store } from "./db.ts";
import { isRedCheck, openForge } from "./forge.ts";
import type { FailedLog, Forge, ForgeCheck } from "./forge.ts";
import { remoteEnv } from "./git.ts";
import type { Git } from "./git.ts";
import type { HeavyJob, HeavyOutcome, HeavyResult } from "./heavy.ts";
import type { Exec } from "./proc.ts";
import { untrusted } from "./workstation-guards.ts";

/** La « commande » d'une suite jugée par la CI : dans la clé du cache heavy, jamais exécutée. */
export const CI_COMMAND = "ci";

/** Les caractères de logs gardés par job rouge, et le nombre de jobs détaillés. */
export const CI_LOG_CHARS = 1500;
export const CI_LOG_JOBS = 6;

/** Où en est la CI : verte, rouge (tous les checks jugés ont rendu compte), ou encore à attendre. */
export type CiState = "pass" | "fail" | "pending";

/** Les checks qui font le verdict : ceux que la branche protégée exige, à défaut tous. */
export function judgedChecks(checks: readonly ForgeCheck[]): ForgeCheck[] {
  const required = checks.filter((check) => check.required);
  return required.length > 0 ? required : [...checks];
}

/** Aucun check jugé n'est terminé-rouge ni en attente → `pass` ; un check en attente (ou aucun encore) → `pending`. */
export function ciState(checks: readonly ForgeCheck[]): CiState {
  const judged = judgedChecks(checks);
  if (judged.length === 0 || judged.some((check) => check.status !== "completed")) return "pending";
  return judged.some(isRedCheck) ? "fail" : "pass";
}

/**
 * Les jobs rouges de `sha` : nom, URL et extrait filtré de leurs logs, en texte pour le correcteur.
 * Les logs sont du contenu non fiable (`untrusted()`) ; des logs illisibles ne cachent pas le job.
 */
export async function ciFailureReport(forge: Forge, sha: string, checks: readonly ForgeCheck[]): Promise<string> {
  const red = judgedChecks(checks).filter(isRedCheck);
  const logs: FailedLog[] = await forge.failedLogs(sha, CI_LOG_CHARS).catch(() => []);
  const detailed = red.slice(0, CI_LOG_JOBS).map((check) => {
    const log = logs.find((entry) => entry.name === check.name)?.log ?? "";
    const head = `- ${check.name}${check.url ? ` — ${check.url}` : ""}`;
    if (log === "") return `${head}\n  (aucun log lisible)`;
    return `${head}\n${untrusted(`logs du job « ${check.name} »`, log)}`;
  });
  const more = red.length > CI_LOG_JOBS ? [`… et ${red.length - CI_LOG_JOBS} autre(s) job(s) rouge(s)`] : [];
  const title = `${red.length} job(s) rouge(s) sur la CI de ${forge.name} (${sha.slice(0, 12)}) :`;
  return [title, ...detailed, ...more].join("\n");
}

/** Ce dont le juge a besoin : la configuration, la base (PR, cache), git et la CLI de la forge. */
export type CiDeps = { config: HarnessConfig; store: Store; git: Git; exec: Exec; now?: () => number };

/** Attend `ms`, ou la fin du signal. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export class CiJudge {
  readonly #deps: CiDeps;

  constructor(deps: CiDeps) {
    this.#deps = deps;
  }

  /**
   * Juge l'arbre du worktree de `job` par la CI de la forge : le commit y est poussé, sa PR
   * ouverte en brouillon, ses checks attendus. Ne lève jamais : un geste refusé rend `error`.
   */
  async judge(
    job: HeavyJob,
    id: { key: string; tree: string; command: string },
    signal: AbortSignal,
  ): Promise<HeavyResult> {
    const { store } = this.#deps;
    const now = this.#deps.now ?? Date.now;
    const started = now();
    const result = (outcome: HeavyOutcome, output: string): HeavyResult => ({
      outcome,
      exitCode: outcome === "pass" ? 0 : outcome === "fail" ? 1 : null,
      output,
      durationMs: now() - started,
      attempts: 1,
      cached: false,
      skipped: false,
      note: null,
      tree: id.tree,
      key: id.key,
      command: id.command,
      tap: null,
      judge: "ci",
    });
    store.appendEvent("heavy_started", job.runId, { scope: job.scope, attempt: 1, unit: "ci" });
    let judged: HeavyResult;
    try {
      judged = await this.#judge(job, signal, result);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      judged = result("error", `la CI de la forge n'a pas pu juger : ${why}`);
    }
    store.appendEvent("heavy_done", job.runId, {
      scope: job.scope,
      attempt: 1,
      outcome: judged.outcome,
      exitCode: judged.exitCode,
    });
    return judged;
  }

  async #judge(
    job: HeavyJob,
    signal: AbortSignal,
    result: (outcome: HeavyOutcome, output: string) => HeavyResult,
  ): Promise<HeavyResult> {
    const { git, store, config, exec } = this.#deps;
    const now = this.#deps.now ?? Date.now;
    const { repo, worktree } = job;
    const run = store.getRun(job.runId);
    if (run === null) throw new Error(`le run ${job.runId} n'existe plus`);
    const forge = await openForge(repo, { exec, git });
    // Le message dit quoi faire : la configuration refuse `ci` sans forge, mais le distant a pu changer depuis.
    if (forge.kind === "none")
      throw new Error(`le dépôt ${repo.name} n'a pas de forge : déclare \`forge\` ("github" ou "gitlab")`);
    if (await git.mergeInProgress(worktree)) throw new Error("une fusion est en cours : rien à pousser");
    // La CI juge un commit : ce que le worktree porte encore sans commit y entre d'abord (même arbre que la clé de cache).
    if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip: avant la CI — ${run.title}`.slice(0, 120));
    // Le bail attend ce que le harness a lui-même poussé : une réécriture après /fix ou rebase passe,
    // un commit poussé par quelqu'un d'autre sur la branche fait refuser la poussée au lieu d'être écrasé.
    const expected = await git.pushedSha(worktree, run.branch);
    const push = await git.raw(
      worktree,
      [
        "push",
        "-q",
        `--force-with-lease=refs/heads/${run.branch}:${expected}`,
        repo.remote ?? "origin",
        `HEAD:refs/heads/${run.branch}`,
      ],
      remoteEnv(repo),
    );
    if (push.code !== 0) throw new Error(`push refusé : ${(push.stderr || push.stdout).trim().slice(0, 300)}`);
    await git.recordPushed(worktree, run.branch, "HEAD");
    const sha = await git.revParse(worktree, "HEAD");
    const prUrl = await forge.openChange(
      {
        head: run.branch,
        base: repo.mainBranch,
        title: run.title,
        body: `Brouillon : la CI de la forge juge la suite complète de cette branche.\n\nHarness-Run: ${run.id}`,
      },
      run.prUrl,
      true,
    );
    if (prUrl !== null && prUrl !== run.prUrl) store.updateRun(run.id, { prUrl });

    const timeoutSec = ciTimeoutSec(repo);
    const deadline = now() + timeoutSec * 1000;
    let checks: ForgeCheck[] = [];
    let unreadable = "";
    for (;;) {
      if (signal.aborted) return result("aborted", "jugement par la CI arrêté (plus personne ne l'attendait)");
      try {
        checks = await forge.checks(sha);
        unreadable = "";
      } catch (err) {
        // La forge ne répond pas : un trou, pas un verdict — le délai tranche.
        unreadable = err instanceof Error ? err.message : String(err);
      }
      const state = ciState(checks);
      if (state === "pass") {
        const names = judgedChecks(checks).map((check) => check.name);
        return result("pass", `CI ${forge.name} verte sur ${sha.slice(0, 12)} : ${names.join(", ")}`);
      }
      const red = judgedChecks(checks).some(isRedCheck);
      const expired = now() >= deadline;
      if (state === "fail" || (expired && red)) return result("fail", await ciFailureReport(forge, sha, checks));
      if (expired) {
        const waiting = judgedChecks(checks)
          .filter((check) => check.status !== "completed")
          .map((check) => check.name);
        return result(
          "timeout",
          [
            `délai dépassé : la CI de ${forge.name} n'a pas fini en ${timeoutSec} s sur ${sha.slice(0, 12)}`,
            waiting.length > 0 ? `en attente : ${waiting.join(", ")}` : "aucun check n'a été vu",
            ...(unreadable !== "" ? [`dernière erreur de la forge : ${unreadable}`] : []),
          ].join("\n"),
        );
      }
      await sleep(Math.min(config.review.mergePollSec * 1000, Math.max(deadline - now(), 0)), signal);
    }
  }
}
