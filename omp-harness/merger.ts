// Le merge des runs validés (auto-merge ou humain), en FILE PAR DÉPÔT.
//
// Deux merges du même dépôt ne se croisent jamais : le second attend le premier,
// puis se rebase sur le `main` qu'il a produit. Sans file, ils se disputaient
// `update-ref` et le perdant refaisait rebase et suite complète à chaque tentative.
// Les dépôts différents mergent en parallèle.
//
// Si main a bougé depuis la revue : rebase, puis la suite complète repasse en heavy
// sur le nouvel arbre — sans LLM. Rouge ou conflit : retour en correction (machine),
// après un délai (5, 15 puis 60 min) compté dans `mergeRetries`.
//
// Mode `gh` : une PR, `gh pr merge --squash --auto`, puis l'attente de la fusion
// constatée (les checks requis de la branche protégée) — jamais « merged » avant que
// GitHub l'ait fait. Mode `local` : squash puis push ; un push refusé n'est PAS un
// merge : le run attend l'humain avec la raison (une coupure réseau est réessayée).
import * as path from "node:path";
import type { RepoConfig } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import type { DecisionRow, DecisionStatus, RunRow } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { afterMergeFailed, afterMergeStopped, afterMerged } from "./machine.ts";
import type { NewRunInput } from "./orchestrator.ts";

export type MergerHooks = {
  /** Un merge (réussi ou non) a quitté la file : l'orchestrateur refait un tour. */
  onDone: () => void;
  /** Le run de suite ouvert après un revert. */
  followUp: (input: NewRunInput, actor: Actor) => Promise<RunRow>;
};

/** Les statuts de décision qui comptent dans le message de merge et le souvenir. */
const DECIDED: DecisionStatus[] = ["auto", "auto_timeout", "accepted", "reversed"];

/** Les refus de push qui tiennent au réseau, pas au dépôt : réessayés. */
const NETWORK_PUSH_ERROR =
  /could not resolve|could not connect|connection (?:refused|reset|timed out)|timed out|unable to access|network is unreachable|early EOF|remote end hung up|temporarily unavailable|operation timed out/i;

/** Les attentes entre deux poussées après une coupure réseau, en multiples de `mergePollSec`. */
const PUSH_RETRY_STEPS: readonly number[] = [1, 2, 5];

/** Une décision rendue dans le message de merge et le souvenir : l'option retenue, et qui l'a validée. */
function decisionLine(decision: DecisionRow): string {
  const chosen = decision.status === "reversed" ? (decision.reversalOption ?? decision.chosen) : decision.chosen;
  const mark =
    decision.status === "auto" || decision.status === "auto_timeout"
      ? " (choix de l'agent, non validé)"
      : decision.status === "reversed"
        ? ` (renversée par l'humain : ${decision.reversalReason ?? "sans raison donnée"})`
        : "";
  return `${decision.question} → ${chosen}${mark}`;
}

/** Une URL https dans une sortie de `gh` (stdout de `pr create`, ou stderr « already exists: … »). */
function urlIn(output: string): string | null {
  const match = /https:\/\/\S+/.exec(output);
  return match ? match[0].replace(/[.,)]+$/, "") : null;
}

export class Merger {
  readonly #ctx: HarnessContext;
  readonly #hooks: MergerHooks;
  /** La queue de chaque dépôt : la promesse du dernier merge enfilé. */
  readonly #queues = new Map<string, Promise<void>>();
  /** Les runs enfilés ou en cours de merge. */
  readonly #pending = new Set<string>();

  constructor(ctx: HarnessContext, hooks: MergerHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  /** Le run est-il enfilé ou en cours de merge ? (un geste humain ne l'interrompt pas). */
  has(runId: string): boolean {
    return this.#pending.has(runId);
  }

  /** Enfile le merge d'un run en `merging` derrière ceux de son dépôt. */
  enqueue(run: RunRow): void {
    if (this.#pending.has(run.id)) return;
    this.#pending.add(run.id);
    const previous = this.#queues.get(run.repo) ?? Promise.resolve();
    if (this.#queues.has(run.repo))
      this.#ctx.event("merge_queued", run.id, {
        behind: [...this.#pending].filter((id) => id !== run.id && this.#ctx.store.getRun(id)?.repo === run.repo),
      });
    const next = previous
      .then(() => this.#merge(run.id))
      .finally(() => {
        this.#pending.delete(run.id);
        if (this.#queues.get(run.repo) === next) this.#queues.delete(run.repo);
        this.#hooks.onDone();
      });
    this.#queues.set(run.repo, next);
  }

  /** Attend que toutes les files soient vides (arrêt du service). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#queues.values()]);
  }

  async #merge(runId: string): Promise<void> {
    const { store, git, heavy } = this.#ctx;
    let mainAtStart: string | null = null;
    try {
      let run = store.getRun(runId);
      if (run?.state !== "merging") return;
      const repo = this.#ctx.repo(run.repo);
      const worktree = run.worktree;
      if (worktree === null) throw new Error("le run n'a plus de worktree");
      await this.#ctx.fetchMain(repo);
      const main = await git.revParse(repo.path, repo.mainBranch);
      mainAtStart = main;
      if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip: avant merge — ${run.title}`.slice(0, 120));
      // Déjà dans main (merge fait, état non écrit avant un arrêt) : rien à refaire, sauf la poussée.
      if (
        (await git.run(repo.path, ["rev-parse", `${run.branch}^{tree}`])) ===
          (await git.run(repo.path, ["rev-parse", `${main}^{tree}`])) &&
        main !== run.baseSha
      ) {
        if (repo.merge === "local" && !(await this.#pushMain(run, repo))) return;
        this.#finish(run, main, repo);
        return;
      }
      if (main !== run.baseSha) {
        // Un rebase qui bute ne vaut pas conflit : une branche qui porte déjà une fusion de
        // main (conflits résolus en revue) rejoue au rebase ses commits d'avant la fusion,
        // donc les mêmes conflits, à chaque tentative. Une fusion de main ne rejoue rien :
        // elle ne bute que sur un conflit nouveau.
        const rebased = await git.rebase(worktree, main);
        const updated = rebased.ok
          ? rebased
          : await git.mergeCommit(worktree, main, `merge: main dans ${run.branch} (avant merge)`);
        // Conflit : retour en revue, qui fusionne main et fait résoudre les conflits.
        if (!updated.ok)
          return this.#stopped(run, "review", `conflit avec main avant merge : ${updated.conflicts.join(", ")}`);
        await this.#ctx.remapCheckpoints(run.id, worktree, main);
        run = store.updateRun(run.id, { baseSha: main });
        const result = await heavy.run({
          runId: run.id,
          stepId: null,
          repo,
          worktree,
          scope: "full",
          files: [],
          priority: run.priority,
        });
        if (result.outcome !== "pass")
          return this.#stopped(run, "fix", `suite complète ${result.outcome} après rebase sur main`);
      }
      const decisions = store.listDecisions({ runId, status: DECIDED });
      const message = [
        run.title,
        "",
        run.verdict?.summary ?? "",
        "",
        ...(decisions.length > 0 ? ["Décisions :", ...decisions.map((d) => `- ${decisionLine(d)}`), ""] : []),
        `Harness-Run: ${run.id}`,
      ].join("\n");
      if (repo.merge === "gh") {
        const outcome = await this.#mergeWithGh(run, repo, message);
        if (outcome.prUrl !== null && outcome.prUrl !== run.prUrl)
          run = store.updateRun(run.id, { prUrl: outcome.prUrl });
        if (outcome.kind === "merged") {
          this.#finish(run, await git.revParse(repo.path, repo.mainBranch), repo);
          return;
        }
        return this.#stopped(run, "review", outcome.reason);
      }
      const sha = await git.squashMerge(repo.path, run.branch, repo.mainBranch, main, message);
      if (!(await this.#pushMain(run, repo))) return;
      this.#finish(run, sha, repo);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const run = store.getRun(runId);
      if (!run) return;
      // main a avancé pendant ce merge (un push venu d'ailleurs, CAS de update-ref perdu) : on retente au tick suivant.
      const repo = this.#ctx.repo(run.repo);
      const nowMain = await git.revParse(repo.path, repo.mainBranch).catch(() => null);
      if (mainAtStart !== null && nowMain !== null && nowMain !== mainAtStart) {
        this.#ctx.event("merge_retry", runId, { reason });
        return;
      }
      this.#ctx.transition(run, afterMergeFailed(run, reason), ["merging"]);
    }
  }

  /**
   * Pousse `main` sur le distant (mode `local`). Un refus du dépôt (branche protégée,
   * droit manquant) n'est pas un merge : le run attend l'humain avec la raison. Une
   * coupure réseau est réessayée un nombre borné de fois avant d'en faire autant.
   * `true` si main est poussée (ou qu'il n'y a pas de distant).
   */
  async #pushMain(run: RunRow, repo: RepoConfig): Promise<boolean> {
    if (!repo.remote) return true;
    const { git, config } = this.#ctx;
    const args = ["push", "-q", repo.remote, `refs/heads/${repo.mainBranch}:refs/heads/${repo.mainBranch}`];
    let detail = "";
    for (let attempt = 0; ; attempt++) {
      const push = await git.raw(repo.path, args);
      if (push.code === 0) return true;
      detail = (push.stderr || push.stdout).trim().slice(0, 300);
      this.#ctx.event("push_failed", run.id, { detail, attempt });
      const wait = PUSH_RETRY_STEPS[attempt];
      if (!NETWORK_PUSH_ERROR.test(detail) || wait === undefined) break;
      await new Promise<void>((resolve) => setTimeout(resolve, wait * config.review.mergePollSec * 1000));
    }
    const current = this.#ctx.store.getRun(run.id) ?? run;
    this.#ctx.transition(current, { ...afterMergeFailed(current, detail), reason: `push refusé : ${detail}` }, [
      "merging",
    ]);
    return false;
  }

  /**
   * Mode `gh` : la PR (créée ou retrouvée), `gh pr merge --squash --auto`, puis l'attente
   * de la fusion constatée par `gh pr view`, toutes les `mergePollSec`, jusqu'à
   * `mergeWaitSec`. Fermée sans fusion, refusée ou trop longue : le merge s'arrête.
   */
  async #mergeWithGh(
    run: RunRow,
    repo: RepoConfig,
    message: string,
  ): Promise<{ kind: "merged"; prUrl: string | null } | { kind: "stopped"; prUrl: string | null; reason: string }> {
    const { git, exec, config } = this.#ctx;
    const remote = repo.remote ?? "origin";
    const worktree = run.worktree;
    if (worktree === null) throw new Error("le run n'a plus de worktree");
    await git.run(worktree, ["push", "-q", "-f", remote, `${run.branch}:${run.branch}`]);
    const body = message.split("\n").slice(2).join("\n");
    const created = await exec(
      "gh",
      ["pr", "create", "-B", repo.mainBranch, "-H", run.branch, "-t", run.title, "-b", body],
      { cwd: repo.path, timeoutMs: 120_000 },
    );
    // Une PR existe déjà pour la branche (merge relancé) : gh le dit, avec son URL.
    const prUrl = urlIn(created.stdout) ?? urlIn(created.stderr) ?? run.prUrl;
    if (created.code !== 0 && prUrl === null) throw new Error(`gh pr create : ${created.stderr.trim().slice(0, 300)}`);
    const merge = await exec("gh", ["pr", "merge", run.branch, "--squash", "--auto", "--delete-branch"], {
      cwd: repo.path,
      timeoutMs: 120_000,
    });
    if (merge.code !== 0)
      return { kind: "stopped", prUrl, reason: `gh pr merge --auto refusé : ${merge.stderr.trim().slice(0, 300)}` };
    const deadline = Date.now() + config.review.mergeWaitSec * 1000;
    for (;;) {
      const view = await exec("gh", ["pr", "view", run.branch, "--json", "state,mergedAt"], {
        cwd: repo.path,
        timeoutMs: 120_000,
      });
      const state = view.code === 0 ? this.#prState(view.stdout) : null;
      if (state === "MERGED") {
        await this.#ctx.fetchMain(repo);
        return { kind: "merged", prUrl };
      }
      if (state === "CLOSED") return { kind: "stopped", prUrl, reason: "la PR a été fermée sans être fusionnée" };
      if (Date.now() >= deadline)
        return {
          kind: "stopped",
          prUrl,
          reason: `fusion non constatée après ${config.review.mergeWaitSec} s (checks ou revue en attente sur la PR)`,
        };
      await new Promise<void>((resolve) => setTimeout(resolve, config.review.mergePollSec * 1000));
    }
  }

  /** L'état d'une PR dans la sortie de `gh pr view --json state,mergedAt` ; `null` si illisible. */
  #prState(stdout: string): "OPEN" | "MERGED" | "CLOSED" | null {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (parsed === null || typeof parsed !== "object") return null;
      if ("mergedAt" in parsed && typeof parsed.mergedAt === "string" && parsed.mergedAt !== "") return "MERGED";
      if (!("state" in parsed) || typeof parsed.state !== "string") return null;
      return parsed.state === "MERGED" || parsed.state === "CLOSED" || parsed.state === "OPEN" ? parsed.state : null;
    } catch {
      return null;
    }
  }

  /**
   * Le merge s'arrête : retour en correction ou en revue après un délai, compté dans
   * `mergeRetries` (machine) ; au plafond, l'humain.
   */
  #stopped(run: RunRow, step: "fix" | "review", reason: string): void {
    const { store, config } = this.#ctx;
    const transition = afterMergeStopped(run, step, reason, config.review, Date.now());
    store.transaction(() => {
      const patch = {
        mergeRetries: run.mergeRetries + 1,
        ...(transition.state === "queued"
          ? { verdict: run.verdict ? { ...run.verdict, blockers: [reason] } : null }
          : {}),
      };
      const moved = this.#ctx.transition(run, transition, ["merging"], { patch });
      if (moved && transition.state === "queued")
        store.addInstructions(
          run.id,
          `Le merge a été arrêté : ${reason}. ${step === "fix" ? "Corrige, puis la revue reprendra." : "Reprends la revue."}`,
        );
    });
  }

  /** Fin de run : état, knowledge-updater (oracle), worktree rendu (le projet est clos par le contexte). */
  #finish(run: RunRow, sha: string, repo: RepoConfig): void {
    const { store, git, oracle } = this.#ctx;
    // Le merge est fait dans git : l'état suit. Aucun geste ne passe pendant un merge
    // (annuler, renverser et valider le refusent), le run est donc toujours en `merging`.
    const current = store.getRun(run.id) ?? run;
    const moved = store.transaction(() => {
      if (!this.#ctx.transition(current, afterMerged(current), ["merging"], { patch: { mergeSha: sha } })) return false;
      this.#ctx.event("merged", run.id, { sha, prUrl: store.getRun(run.id)?.prUrl ?? null });
      return true;
    });
    if (!moved) return;
    const decisions = store.listDecisions({ runId: run.id, status: DECIDED });
    const verdict = run.verdict;
    const summary = [
      `Feature mergée « ${run.title} » (${sha.slice(0, 12)}) : ${verdict?.summary ?? ""}`,
      run.modules.length > 0 ? `Modules : ${run.modules.join(", ")}.` : "",
      verdict && verdict.risks.length > 0 ? `Risques résiduels : ${verdict.risks.join(" ; ")}.` : "",
      verdict && verdict.unverified.length > 0 ? `Non vérifié par la revue : ${verdict.unverified.join(" ; ")}.` : "",
      decisions.length > 0 ? `Décisions : ${decisions.map(decisionLine).join(" ; ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    void oracle.retain(repo.scope, summary, ["harness", "feature"]);
    if (run.worktree !== null)
      void git.removeWorktree(repo.path, run.worktree, repo.merge === "local" ? run.branch : null).catch(() => {});
  }

  /**
   * Revert d'un run mergé : le commit squash est défait sur `main` (mode `local` :
   * `git revert` puis push ; mode `gh` : une PR de revert fusionnée en `--auto`), puis
   * un run de suite s'ouvre pour reprendre la feature. Lève AVANT d'ouvrir le run de
   * suite si le revert ou la poussée échoue ; 409 si le run n'est pas mergé.
   */
  async revert(runId: string, actor: Actor): Promise<RunRow> {
    const run = this.#ctx.run(runId);
    if (run.state !== "merged" || run.mergeSha === null)
      throw new HarnessError(409, `le run ${runId} n'est pas mergé : rien à reverter`);
    const repo = this.#ctx.repo(run.repo);
    const { git, config } = this.#ctx;
    await this.#ctx.fetchMain(repo);
    const main = await git.revParse(repo.path, repo.mainBranch);
    const scratch = path.join(config.worktreesDir, `revert-${run.slug}-${Date.now().toString(36)}`);
    const branch = repo.merge === "gh" ? `harness/revert-${run.slug}` : null;
    let result: { sha: string; prUrl: string | null };
    try {
      await git.addWorktree(repo.path, scratch, branch, main);
      // Un commit squash n'a qu'un parent : un revert simple suffit.
      const reverted = await git.raw(scratch, ["revert", "--no-edit", run.mergeSha]);
      if (reverted.code !== 0) {
        await git.raw(scratch, ["revert", "--abort"]);
        throw new HarnessError(409, `revert impossible : ${(reverted.stderr || reverted.stdout).trim().slice(0, 300)}`);
      }
      const sha = await git.revParse(scratch, "HEAD");
      result = repo.merge === "gh" ? await this.#revertWithGh(run, repo, scratch, sha) : { sha, prUrl: null };
      if (repo.merge === "local") {
        await git.run(repo.path, ["update-ref", `refs/heads/${repo.mainBranch}`, sha, main]);
        if (repo.remote) {
          const push = await git.raw(repo.path, [
            "push",
            "-q",
            repo.remote,
            `refs/heads/${repo.mainBranch}:refs/heads/${repo.mainBranch}`,
          ]);
          if (push.code !== 0) {
            // La poussée refusée défait le revert local : main reste comme le distant la connaît.
            await git.raw(repo.path, ["update-ref", `refs/heads/${repo.mainBranch}`, main, sha]);
            this.#ctx.event("push_failed", run.id, { detail: push.stderr.trim().slice(0, 300), revert: true });
            throw new HarnessError(502, `push du revert refusé : ${push.stderr.trim().slice(0, 300)}`);
          }
        }
      }
    } finally {
      await git.removeWorktree(repo.path, scratch, branch).catch(() => {});
    }
    this.#ctx.event("reverted", run.id, {
      sha: result.sha,
      revertedSha: run.mergeSha,
      prUrl: result.prUrl,
      ...(actor.by ? { by: actor.by } : {}),
    });
    void this.#ctx.oracle.retain(
      repo.scope,
      `Feature revertée « ${run.title} » : le commit ${run.mergeSha.slice(0, 12)} a été défait sur ${repo.mainBranch} (${result.sha.slice(0, 12)})${actor.by ? ` par ${actor.by}` : ""}. Un run de suite reprend la feature.`,
      ["harness", "feature", "revert"],
    );
    return this.#hooks.followUp(
      {
        repo: run.repo,
        title: `Reprise après revert — ${run.title}`.slice(0, 120),
        request: [
          `La feature « ${run.title} » (run ${run.id}) avait été mergée dans ${repo.mainBranch} (${run.mergeSha.slice(0, 12)}), puis revertée (${result.sha.slice(0, 12)})${actor.by ? ` par ${actor.by}` : ""}.`,
          "Reprends-la : relis le commit reverté, comprends ce qui a motivé le revert (consignes ci-dessous s'il y en a) et livre une version corrigée.",
          "",
          "Demande d'origine :",
          run.request,
        ].join("\n"),
        modules: run.modules,
        priority: run.priority,
      },
      actor,
    );
  }

  /** Mode `gh` : la branche de revert poussée, une PR, `gh pr merge --squash --auto`. */
  async #revertWithGh(
    run: RunRow,
    repo: RepoConfig,
    scratch: string,
    sha: string,
  ): Promise<{ sha: string; prUrl: string | null }> {
    const { git, exec } = this.#ctx;
    const remote = repo.remote ?? "origin";
    const branch = `harness/revert-${run.slug}`;
    await git.run(scratch, ["push", "-q", "-f", remote, `${branch}:${branch}`]);
    const created = await exec(
      "gh",
      [
        "pr",
        "create",
        "-B",
        repo.mainBranch,
        "-H",
        branch,
        "-t",
        `Revert « ${run.title} »`.slice(0, 120),
        "-b",
        `Revert du commit ${run.mergeSha?.slice(0, 12) ?? ""} (run ${run.id}).\n\nHarness-Run: ${run.id}`,
      ],
      { cwd: repo.path, timeoutMs: 120_000 },
    );
    const prUrl = urlIn(created.stdout) ?? urlIn(created.stderr);
    if (created.code !== 0 && prUrl === null)
      throw new HarnessError(502, `gh pr create (revert) : ${created.stderr.trim().slice(0, 300)}`);
    const merge = await exec("gh", ["pr", "merge", branch, "--squash", "--auto", "--delete-branch"], {
      cwd: repo.path,
      timeoutMs: 120_000,
    });
    if (merge.code !== 0)
      throw new HarnessError(502, `gh pr merge --auto (revert) : ${merge.stderr.trim().slice(0, 300)}`);
    return { sha, prUrl };
  }
}
