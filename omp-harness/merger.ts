// Le merge des runs validés (auto-merge ou humain), en FILE PAR DÉPÔT.
//
// Deux merges du même dépôt ne se croisent jamais : le second attend le premier,
// puis se rebase sur le `main` qu'il a produit. Sans file, ils se disputaient
// `update-ref` et le perdant refaisait rebase et suite complète à chaque tentative.
// Les dépôts différents mergent en parallèle.
//
// Si main a bougé depuis la revue : rebase, puis la suite complète repasse en heavy
// sur le nouvel arbre — sans LLM. Rouge ou conflit : retour en correction (machine).
import type { RepoConfig } from "./config.ts";
import type { HarnessContext } from "./context.ts";
import type { RunRow } from "./db.ts";
import { afterMergeFailed, afterMergeStopped, afterMerged, isTerminal } from "./machine.ts";

export class Merger {
  readonly #ctx: HarnessContext;
  readonly #onDone: () => void;
  /** La queue de chaque dépôt : la promesse du dernier merge enfilé. */
  readonly #queues = new Map<string, Promise<void>>();
  /** Les runs enfilés ou en cours de merge. */
  readonly #pending = new Set<string>();

  constructor(ctx: HarnessContext, onDone: () => void) {
    this.#ctx = ctx;
    this.#onDone = onDone;
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
        this.#onDone();
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
      let run = store.getRun(runId) as RunRow;
      if (run?.state !== "merging") return;
      const repo = this.#ctx.repo(run.repo);
      const worktree = run.worktree as string;
      await this.#ctx.fetchMain(repo);
      const main = await git.revParse(repo.path, repo.mainBranch);
      mainAtStart = main;
      if (await git.isDirty(worktree)) await git.commitAll(worktree, `wip: avant merge — ${run.title}`.slice(0, 120));
      // Déjà dans main (merge fait, état non écrit avant un arrêt) : rien à refaire.
      if (
        (await git.run(repo.path, ["rev-parse", `${run.branch}^{tree}`])) ===
          (await git.run(repo.path, ["rev-parse", `${main}^{tree}`])) &&
        main !== run.baseSha
      ) {
        this.#finish(run, main, repo);
        return;
      }
      if (main !== run.baseSha) {
        const rebased = await git.rebase(worktree, main);
        // Conflit : retour en revue, qui fusionne main et fait résoudre les conflits.
        if (!rebased.ok)
          return this.#stopped(run, "review", `conflit avec main avant merge : ${rebased.conflicts.join(", ")}`);
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
      const decisions = store.listDecisions({ runId, status: ["auto", "accepted", "reversed"] });
      const message = [
        run.title,
        "",
        run.verdict?.summary ?? "",
        "",
        ...(decisions.length > 0
          ? [
              "Décisions :",
              ...decisions.map((d) => `- ${d.question} → ${d.status === "reversed" ? d.reversalOption : d.chosen}`),
              "",
            ]
          : []),
        `Harness-Run: ${run.id}`,
      ].join("\n");
      if (repo.merge === "gh") {
        const url = await this.#mergeWithGh(run, repo, message);
        run = store.updateRun(run.id, { prUrl: url });
        this.#finish(run, await git.revParse(repo.path, repo.mainBranch), repo);
        return;
      }
      const sha = await git.squashMerge(repo.path, run.branch, repo.mainBranch, main, message);
      if (repo.remote) {
        const push = await git.raw(repo.path, [
          "push",
          "-q",
          repo.remote,
          `refs/heads/${repo.mainBranch}:refs/heads/${repo.mainBranch}`,
        ]);
        if (push.code !== 0) this.#ctx.event("push_failed", run.id, { detail: push.stderr.trim().slice(0, 300) });
      }
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

  async #mergeWithGh(run: RunRow, repo: RepoConfig, message: string): Promise<string> {
    const { git, exec } = this.#ctx;
    const remote = repo.remote ?? "origin";
    await git.run(run.worktree as string, ["push", "-q", "-f", remote, `${run.branch}:${run.branch}`]);
    const body = message.split("\n").slice(2).join("\n");
    const created = await exec(
      "gh",
      ["pr", "create", "-B", repo.mainBranch, "-H", run.branch, "-t", run.title, "-b", body],
      { cwd: repo.path, timeoutMs: 120_000 },
    );
    const url = created.stdout.trim().split("\n").pop() ?? "";
    if (created.code !== 0 && url === "") throw new Error(`gh pr create : ${created.stderr.trim().slice(0, 300)}`);
    const merged = await exec("gh", ["pr", "merge", run.branch, "--squash", "--delete-branch"], {
      cwd: repo.path,
      timeoutMs: 120_000,
    });
    if (merged.code !== 0) throw new Error(`gh pr merge : ${merged.stderr.trim().slice(0, 300)}`);
    await this.#ctx.fetchMain(repo);
    return url;
  }

  /** Le merge s'arrête : retour en correction ou en revue, borné par le plafond de corrections (machine). */
  #stopped(run: RunRow, step: "fix" | "review", reason: string): void {
    const { store, config } = this.#ctx;
    const transition = afterMergeStopped(run, step, reason, config.review.fixCap);
    store.transaction(() => {
      const patch =
        transition.state === "queued" ? { verdict: run.verdict ? { ...run.verdict, blockers: [reason] } : null } : {};
      const moved = this.#ctx.transition(run, transition, ["merging"], { patch });
      if (moved && transition.state === "queued")
        store.addInstructions(
          run.id,
          `Le merge a été arrêté : ${reason}. ${step === "fix" ? "Corrige, puis la revue reprendra." : "Reprends la revue."}`,
        );
    });
  }

  /** Fin de run : état, knowledge-updater (oracle), worktree rendu, projet clos si tout est mergé. */
  #finish(run: RunRow, sha: string, repo: RepoConfig): void {
    const { store, git, oracle } = this.#ctx;
    // Le merge est fait dans git : l'état suit. Aucun geste ne passe pendant un merge
    // (annuler, renverser et valider le refusent), le run est donc toujours en `merging`.
    const current = store.getRun(run.id) ?? run;
    store.transaction(() => {
      if (!this.#ctx.transition(current, afterMerged(current), ["merging"], { patch: { mergeSha: sha } })) return;
      this.#ctx.event("merged", run.id, { sha, prUrl: store.getRun(run.id)?.prUrl ?? null });
      if (run.projectId) {
        const rest = store.listRuns({ projectId: run.projectId }).filter((other) => !isTerminal(other.state));
        if (rest.length === 0) {
          store.setProjectStatus(run.projectId, "done");
          this.#ctx.event("project_done", null, { projectId: run.projectId }, run.repo);
        }
      }
    });
    const decisions = store.listDecisions({ runId: run.id, status: ["auto", "accepted", "reversed"] });
    const summary = [
      `Feature mergée « ${run.title} » (${sha.slice(0, 12)}) : ${run.verdict?.summary ?? ""}`,
      run.modules.length > 0 ? `Modules : ${run.modules.join(", ")}.` : "",
      decisions.length > 0
        ? `Décisions : ${decisions.map((d) => `${d.question} → ${d.status === "reversed" ? d.reversalOption : d.chosen}${d.status === "reversed" ? ` (raison humaine : ${d.reversalReason})` : ""}`).join(" ; ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    void oracle.retain(repo.scope, summary, ["harness", "feature"]);
    void git
      .removeWorktree(repo.path, run.worktree as string, repo.merge === "local" ? run.branch : null)
      .catch(() => {});
  }
}
