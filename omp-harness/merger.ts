// Le merge des runs validés (auto-merge ou humain), en FILE PAR DÉPÔT.
//
// Deux merges du même dépôt ne se croisent jamais : le second attend le premier,
// puis se rebase sur le `main` qu'il a produit. Sans file, ils se disputaient
// `update-ref` et le perdant refaisait rebase et suite complète à chaque tentative.
// Les dépôts différents mergent en parallèle.
//
// Si main a bougé depuis la revue : rebase, puis la suite complète repasse en heavy
// sur le nouvel arbre — sans LLM. Rouge ou conflit : retour en correction (machine),
// après un délai (5, 15 puis 60 min) compté dans `mergeRetries`. Une branche que le
// rebase a vidée (son travail est déjà dans main) se termine mergée, sans commit.
//
// Dépôt en `tests.judge: "ci"` : aucune suite locale. En mode `gh`, la branche rebasée est poussée, sa PR sort du
// brouillon, l'auto-merge est armé, puis l'attente de la fusion lit aussi les checks de la forge sur ce SHA : rouges,
// le run repart en correction avec leurs extraits de logs ; en mode `local`, la CI juge le rebase à la place de `full`.
//
// Le message du squash vient du verdict (`commit` : sujet Conventional Commits, corps),
// suivi des décisions et du trailer `Harness-Run` ; le résumé de la revue n'y entre pas.
//
// Mode `gh` : une PR (une MR sur GitLab) sur la forge du dépôt (forge.ts), sa fusion
// squash automatique, puis l'attente de la fusion constatée (les checks requis de la
// branche protégée, le pipeline) — jamais « merged » avant que la forge l'ait fait. Mode
// `local` : squash puis push ; un push refusé n'est PAS un merge : le run attend
// l'humain avec la raison (une coupure réseau est réessayée).
import * as path from "node:path";
import { testsJudge } from "./config.ts";
import { newFailuresText } from "./baseline.ts";
import type { RepoConfig } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import type { DecisionRow, DecisionStatus, RunRow } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { type Forge, openForge } from "./forge.ts";
import { remoteEnv } from "./git.ts";
import { afterMergeFailed, afterMergeStopped, afterMerged } from "./machine.ts";
import type { NewRunInput } from "./orchestrator.ts";
import { ciFailureReport, ciState } from "./ci-judge.ts";

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
      const mainMoved = main !== run.baseSha;
      if (mainMoved) {
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
      }
      // La branche n'apporte plus rien à main (son travail y est entré par un autre run,
      // et le rebase l'a vidée) : déjà dans main, sans commit vide, sans poussée ni PR.
      // Vérifié avant la suite complète : elle jugerait l'arbre de main, pas ce run.
      if (
        (await git.run(repo.path, ["rev-parse", `${run.branch}^{tree}`])) ===
        (await git.run(repo.path, ["rev-parse", `${main}^{tree}`]))
      ) {
        this.#finish(run, null, repo);
        return;
      }
      // `judge: "ci"` + PR : la CI de la forge juge le rebase pendant l'attente de la fusion (#mergeWithForge), sans suite locale.
      if (mainMoved && !(repo.merge === "gh" && testsJudge(repo) === "ci")) {
        const result = await heavy.run({
          runId: run.id,
          stepId: null,
          repo,
          worktree,
          scope: "full",
          files: [],
          priority: run.priority,
        });
        if (result.outcome !== "pass") {
          // Les échecs que main a déjà ne renvoient pas en correction ; seuls les nouveaux comptent.
          const baseline = await this.#ctx.baseline.judge(run, repo, result);
          if (baseline) this.#ctx.baseline.record(run.id, "merge", baseline);
          if (baseline === null || baseline.new.length > 0)
            return this.#stopped(
              run,
              "fix",
              baseline
                ? `suite complète rouge après rebase sur main : ${newFailuresText(baseline)}`
                : `suite complète ${result.outcome} après rebase sur main`,
            );
        }
      }
      const decisions = store.listDecisions({ runId, status: DECIDED });
      // Le message vient du verdict (`commit`) ; un verdict rendu avant ce champ garde le titre du run.
      const subject = run.verdict?.commit?.subject ?? run.title;
      const body = run.verdict?.commit?.body ?? "";
      const trailer = [
        ...(decisions.length > 0 ? ["Décisions :", ...decisions.map((d) => `- ${decisionLine(d)}`), ""] : []),
        `Harness-Run: ${run.id}`,
      ];
      const commitBody = [...(body === "" ? [] : [body, ""]), ...trailer].join("\n");
      if (repo.merge === "gh") {
        // La PR est le lieu de la revue : son corps porte aussi le résumé du relecteur, le commit non.
        const review = run.verdict?.summary ?? "";
        const prBody = [
          ...(body === "" ? [] : [body, ""]),
          ...(review === "" ? [] : ["## Revue", review, ""]),
          ...trailer,
        ];
        const outcome = await this.#mergeWithForge(run, repo, { subject, commitBody, prBody: prBody.join("\n") });
        if (outcome.prUrl !== null && outcome.prUrl !== run.prUrl)
          run = store.updateRun(run.id, { prUrl: outcome.prUrl });
        if (outcome.kind === "merged") {
          this.#finish(run, await git.revParse(repo.path, repo.mainBranch), repo);
          return;
        }
        return this.#stopped(run, outcome.step ?? "review", outcome.reason);
      }
      const sha = await git.squashMerge(repo.path, run.branch, repo.mainBranch, main, `${subject}\n\n${commitBody}`);
      if (!(await this.#pushMain(run, repo))) return;
      // `judge: "ci"` : la branche poussée pour la CI et sa PR brouillon n'ont plus d'objet ; sans branche, la forge ferme la PR.
      if (testsJudge(repo) === "ci")
        await git.raw(repo.path, ["push", "-q", repo.remote ?? "origin", "--delete", run.branch], remoteEnv(repo));
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
      const push = await git.raw(repo.path, args, remoteEnv(repo));
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
   * Mode `gh` : la PR (créée ou retrouvée) sur la forge du dépôt, sa fusion squash
   * automatique, puis l'attente de la fusion constatée, relue toutes les `mergePollSec`,
   * jusqu'à `mergeWaitSec`. Fermée sans fusion, refusée ou trop longue : le merge
   * s'arrête. Le squash prend le sujet et le corps du verdict : sans eux, la forge
   * composerait le message depuis le titre et les commits de la PR, selon son réglage.
   */
  async #mergeWithForge(
    run: RunRow,
    repo: RepoConfig,
    message: { subject: string; commitBody: string; prBody: string },
  ): Promise<
    { kind: "merged"; prUrl: string | null } | { kind: "stopped"; prUrl: string | null; reason: string; step?: "fix" }
  > {
    const { git, config } = this.#ctx;
    const remote = repo.remote ?? "origin";
    const worktree = run.worktree;
    if (worktree === null) throw new Error("le run n'a plus de worktree");
    const forge = await this.#forge(repo);
    await git.run(worktree, ["push", "-q", "-f", remote, `${run.branch}:${run.branch}`], remoteEnv(repo));
    // Le SHA que la CI de la forge jugera (`judge: "ci"`).
    const sha = testsJudge(repo) === "ci" ? await git.revParse(worktree, "HEAD") : null;
    const prUrl = await forge.openChange(
      { head: run.branch, base: repo.mainBranch, title: message.subject, body: message.prBody },
      run.prUrl,
    );
    try {
      // `judge: "ci"` : la PR, restée en brouillon depuis la preuve de la revue, en sort avant l'auto-merge.
      if (sha !== null) await forge.markReady(run.branch);
      await forge.autoMerge(run.branch, { subject: message.subject, body: message.commitBody });
    } catch (err) {
      return { kind: "stopped", prUrl, reason: err instanceof Error ? err.message : String(err) };
    }
    const deadline = Date.now() + config.review.mergeWaitSec * 1000;
    const change = forge.kind === "gitlab" ? "MR" : "PR";
    for (;;) {
      const state = await forge.changeState(run.branch);
      if (state === "MERGED") {
        await this.#ctx.fetchMain(repo);
        return { kind: "merged", prUrl };
      }
      if (state === "CLOSED")
        return { kind: "stopped", prUrl, reason: `la ${change} a été fermée sans être fusionnée` };
      // `judge: "ci"` : la CI rougit après le rebase → retour en correction, les extraits de logs pour raison.
      const red = sha === null ? null : await this.#ciFailure(forge, sha);
      if (red !== null) return { kind: "stopped", prUrl, reason: red, step: "fix" };
      if (Date.now() >= deadline)
        return {
          kind: "stopped",
          prUrl,
          reason: `fusion non constatée après ${config.review.mergeWaitSec} s (checks ou revue en attente sur la ${change})`,
        };
      await new Promise<void>((resolve) => setTimeout(resolve, config.review.mergePollSec * 1000));
    }
  }

  /** La forge des PR du dépôt ; sans forge, le mode `gh` est refusé en le disant. */
  async #forge(repo: RepoConfig): Promise<Forge> {
    const forge = await openForge(repo, { exec: this.#ctx.exec, git: this.#ctx.git });
    if (forge.kind === "none")
      throw new HarnessError(
        409,
        `le dépôt ${repo.name} est en \`"merge": "gh"\` mais n'a pas de forge : déclare \`forge\` ("github" ou "gitlab"), ou passe-le en \`"merge": "local"\``,
      );
    return forge;
  }

  /**
   * `judge: "ci"` : les jobs rouges de la CI sur `sha` (nom, URL, extrait des logs) si elle a fini rouge, sinon
   * `null` — verte, en cours, ou forge muette (la prochaine lecture reprendra).
   */
  async #ciFailure(forge: Forge, sha: string): Promise<string | null> {
    const checks = await forge.checks(sha).catch(() => null);
    if (checks === null || ciState(checks) !== "fail") return null;
    return `suite complète rouge sur la CI de la forge après le rebase sur main (${sha.slice(0, 12)})\n${await ciFailureReport(forge, sha, checks)}`;
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

  /**
   * Fin de run : état, knowledge-updater (oracle), worktree rendu (le projet est clos par le contexte).
   * `sha` null : la branche n'apportait plus rien à main, aucun commit n'a été posé —
   * `mergeSha` reste null (un revert déferait le commit d'un autre) et l'événement
   * `merged` porte `empty: true`.
   */
  #finish(run: RunRow, sha: string | null, repo: RepoConfig): void {
    const { store, git, oracle } = this.#ctx;
    // Le merge est fait dans git : l'état suit. Aucun geste ne passe pendant un merge
    // (annuler, renverser et valider le refusent), le run est donc toujours en `merging`.
    const current = store.getRun(run.id) ?? run;
    const moved = store.transaction(() => {
      if (!this.#ctx.transition(current, afterMerged(current), ["merging"], { patch: { mergeSha: sha } })) return false;
      this.#ctx.event("merged", run.id, {
        sha,
        prUrl: store.getRun(run.id)?.prUrl ?? null,
        ...(sha === null ? { empty: true } : {}),
      });
      return true;
    });
    if (!moved) return;
    const decisions = store.listDecisions({ runId: run.id, status: DECIDED });
    const verdict = run.verdict;
    const summary = [
      `Feature mergée « ${run.title} » (${sha === null ? "déjà dans main, sans commit" : sha.slice(0, 12)}) : ${verdict?.summary ?? ""}`,
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
    if (run.state !== "merged") throw new HarnessError(409, `le run ${runId} n'est pas mergé : rien à reverter`);
    if (run.mergeSha === null)
      throw new HarnessError(409, `le run ${runId} n'a posé aucun commit sur main (déjà dans main) : rien à reverter`);
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
      result = repo.merge === "gh" ? await this.#revertWithForge(run, repo, scratch, sha) : { sha, prUrl: null };
      if (repo.merge === "local") {
        await git.run(repo.path, ["update-ref", `refs/heads/${repo.mainBranch}`, sha, main]);
        if (repo.remote) {
          const push = await git.raw(
            repo.path,
            ["push", "-q", repo.remote, `refs/heads/${repo.mainBranch}:refs/heads/${repo.mainBranch}`],
            remoteEnv(repo),
          );
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

  /** Mode `gh` : la branche de revert poussée, une PR sur la forge, sa fusion squash automatique. */
  async #revertWithForge(
    run: RunRow,
    repo: RepoConfig,
    scratch: string,
    sha: string,
  ): Promise<{ sha: string; prUrl: string | null }> {
    const { git } = this.#ctx;
    const remote = repo.remote ?? "origin";
    const branch = `harness/revert-${run.slug}`;
    const forge = await this.#forge(repo);
    await git.run(scratch, ["push", "-q", "-f", remote, `${branch}:${branch}`], remoteEnv(repo));
    const prUrl = await forge.openChange(
      {
        head: branch,
        base: repo.mainBranch,
        title: `Revert « ${run.title} »`.slice(0, 120),
        body: `Revert du commit ${run.mergeSha?.slice(0, 12) ?? ""} (run ${run.id}).\n\nHarness-Run: ${run.id}`,
      },
      null,
    );
    await forge.autoMerge(branch, null);
    return { sha, prUrl };
  }
}
