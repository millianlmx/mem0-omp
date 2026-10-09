// Le pilote du projet : lancement des segments, base à jour, fusions, document.
import * as fs from "node:fs";
import * as path from "node:path";
import { realpathOr } from "./git.ts";
import type { GitResult, GitRunner } from "./git.ts";
import { isLotBaseSha, lotFeature, lotRepoKey, readLot } from "./lot.ts";
import type { LotController } from "./lotController.ts";
import {
  PROJECT_DOC_BRANCH,
  PROJECT_DOC_FILE,
  PROJECT_POLL_MS,
  projectDocWorktreePath,
  readProject,
  renderProjectDoc,
  segmentDone,
  syncFromLot,
  writeProject,
} from "./project.ts";
import type { Project, ProjectFeature, ProjectSegment } from "./project.ts";
import { lastLine, releaseTarget } from "./runs.ts";
import type { ReleaseTarget } from "./runs.ts";



// ---------------------------------------------------------------------------
// Le pilote du projet — il ne conduit AUCUN maillon.
// ---------------------------------------------------------------------------
// Les features d'un segment sont des features de lot ordinaires : le pilote de
// lot existant conduit leurs maillons. Ce pilote-ci ne fait que (1) relire leur
// avancement dans le lot, (2) constater les fusions des PR (`gh pr view`, au plus
// une fois par minute), (3) passer au segment suivant quand toutes les PR du
// segment courant sont fusionnées — ou retirées —, (4) lancer les features du
// segment courant depuis la branche par défaut du distant, fraîchement récupérée,
// et (5) tenir le document `PROJECT.md` sur la branche orpheline `omp-project`.
// Il tourne dans le process où la session /project est armée : chaque balayage du
// relais déclenche une passe, et les passes sont SÉRIALISÉES.

/** L'état /project du process : partagé par les instances de l'extension (même patron que `auditState`). */
export type ProjectState = {
  /** La session de CADRAGE ouverte par /project, et le « fin » que l'utilisateur y a dit (S-2). */
  cadrage: { sessionFile: string; fin: boolean } | null;
  /** Un amendement du plan est en dialogue : aucun segment n'est achevé ni lancé (S-9). */
  amending: boolean;
  /** Le dernier sondage des fusions ; `null` : la prochaine passe sonde tout de suite. */
  lastPollAt: number | null;
  /** La dernière tentative de base échouée ; `null` : la prochaine passe réessaie tout de suite. */
  lastLaunchAttemptAt: number | null;
  /** Les notices déjà dites (une fois par texte distinct, remise à zéro à l'armement). */
  warned: Set<string>;
  /** La file des synchronisations du document : jamais deux git à la fois dans son worktree. */
  docQueue: Promise<void>;
  /** Les évènements accumulés depuis le dernier commit du document. */
  docEvents: string[];
  /** Un commit du document attend encore son push. */
  docUnpushed: boolean;
  /** L'URL HTTPS de push et la branche par défaut du distant (`gh repo view`), une fois connues. */
  target: { pushUrl: string; base: string } | null;
};

const PROJECT_STATE_KEY = Symbol.for("omp-mem0-req.projectState");

export const projectState: ProjectState = (() => {
  const host = globalThis as unknown as Record<symbol, ProjectState | undefined>;
  const existing = host[PROJECT_STATE_KEY];
  if (existing) return existing;
  const created: ProjectState = {
    cadrage: null,
    amending: false,
    lastPollAt: null,
    lastLaunchAttemptAt: null,
    warned: new Set(),
    docQueue: Promise.resolve(),
    docEvents: [],
    docUnpushed: false,
    target: null,
  };
  host[PROJECT_STATE_KEY] = created;
  return created;
})();


export type ProjectDriverDeps = {
  stateDir: () => string;
  repoRoot: string;
  controller: () => LotController;
  /** git local (10 s). */
  runGit: GitRunner;
  /** git réseau (60 s) : fetch et push vers l'URL HTTPS du dépôt. */
  runGitNet: GitRunner;
  runGh: (args: string[], cwd: string) => Promise<GitResult>;
  notify: (text: string) => void;
  now?: () => number;
};


export type ProjectDriver = {
  /** Une passe (S-7), sérialisée derrière la précédente ; la promesse se résout à sa fin. */
  tick(): Promise<void>;
  /** « Relancer la feature » après échec (S-8 §3) : `null`, ou le motif du refus. */
  relaunch(slug: string): Promise<string | null>;
  /** « Retirer la feature du plan » après échec (S-8 §4). */
  remove(slug: string): Promise<string | null>;
  /** « Arrêter le projet » (S-8 §5). */
  stop(): Promise<string | null>;
  /** Met en file une synchronisation du document, avec ses évènements (S-5). */
  syncDoc(events: string[]): void;
  /** Le motif qui retient le lancement du segment courant (base introuvable), ou `null`. */
  waiting(): string | null;
};


/** Le ref local qui reçoit la branche par défaut du distant (hors `refs/remotes/`, cf. `## Documentation` §2). */
const BASE_REF = "refs/omp-project/base";

const DOC_REF = `refs/heads/${PROJECT_DOC_BRANCH}`;

const NO_PUSH_URL = "URL HTTPS du dépôt introuvable (gh repo view)";


/** La feature `slug` du segment courant, ou `undefined`. */
function currentFeature(project: Project, slug: string): ProjectFeature | undefined {
  return (project.segments[project.current] as ProjectSegment).features.find((feature) => feature.slug === slug);
}


/** L'état d'une PR lu dans `gh pr view --json state,url`, ou `null` (JSON illisible). */
function prStateOf(stdout: string): "OPEN" | "CLOSED" | "MERGED" | null {
  try {
    const state = (JSON.parse(stdout) as { state?: unknown }).state;
    return state === "OPEN" || state === "CLOSED" || state === "MERGED" ? state : null;
  } catch {
    return null;
  }
}


/** Le pilote du projet d'un dépôt (S-7, S-8, S-5). */
export function createProjectDriver(deps: ProjectDriverDeps): ProjectDriver {
  const repoKey = lotRepoKey(deps.repoRoot);
  const repoName = path.basename(realpathOr(deps.repoRoot)) || realpathOr(deps.repoRoot);
  const now = () => (deps.now ?? Date.now)();
  /** La file des passes : une seule à la fois, aucune perdue. */
  let passes: Promise<void> = Promise.resolve();
  let waitReason: string | null = null;

  const read = () => readProject(deps.stateDir(), repoKey);

  const notify = (text: string) => {
    try {
      deps.notify(text);
    } catch {
      /* une notice ne casse jamais une passe */
    }
  };

  /** Une notice par texte distinct (mémoire process, remise à zéro à l'armement). */
  const warnOnce = (text: string) => {
    if (projectState.warned.has(text)) return;
    projectState.warned.add(text);
    notify(text);
  };

  /**
   * Relit le projet, le mute, l'écrit — SANS `await` entre la lecture et
   * l'écriture (S-4, un seul écrivain). `mutate` rend `false` : rien n'est écrit.
   */
  function update(mutate: (project: Project) => boolean): Project | null {
    const project = read();
    if (project === null || !mutate(project)) return null;
    project.updatedAt = now();
    writeProject(deps.stateDir(), project);
    return project;
  }

  /** La transition d'une feature du segment courant, si elle est encore dans l'état attendu. */
  function updateFeature(
    slug: string,
    guard: (feature: ProjectFeature) => boolean,
    apply: (feature: ProjectFeature) => void,
  ): Project | null {
    return update((project) => {
      const feature = currentFeature(project, slug);
      if (feature === undefined || !guard(feature)) return false;
      apply(feature);
      feature.updatedAt = now();
      return true;
    });
  }

  /** `gh repo view --json url,defaultBranchRef` → la cible de push et la branche par défaut. */
  async function resolveTarget(): Promise<ReleaseTarget> {
    const view = await deps.runGh(["repo", "view", "--json", "url,defaultBranchRef"], deps.repoRoot);
    let parsed: unknown = null;
    if (view.code === 0) {
      try {
        parsed = JSON.parse(view.stdout);
      } catch {
        parsed = null;
      }
    }
    const target = releaseTarget(parsed);
    if (target.pushUrl !== null && target.base !== null) {
      projectState.target = { pushUrl: target.pushUrl, base: target.base };
    }
    return target;
  }

  /**
   * La base du segment courant (S-7 §4a) : celle déjà écrite pour ce segment, sinon
   * la branche par défaut du distant, récupérée en HTTPS dans `refs/omp-project/base`.
   */
  async function ensureBase(): Promise<{ sha: string } | { reason: string }> {
    const project = read();
    if (project === null) return { reason: "projet introuvable" };
    if (project.base !== null && project.base.segment === project.current) return { sha: project.base.sha };
    const segment = project.current;
    const target = await resolveTarget();
    if (target.pushUrl === null || target.base === null) return { reason: NO_PUSH_URL };
    const fetched = await deps.runGitNet(
      ["fetch", "--no-tags", target.pushUrl, `+refs/heads/${target.base}:${BASE_REF}`],
      deps.repoRoot,
    );
    if (fetched.code !== 0) return { reason: lastLine(fetched.stderr) || `code ${fetched.code}` };
    const rev = await deps.runGit(["rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`], deps.repoRoot);
    const sha = rev.stdout.trim();
    if (rev.code !== 0 || !isLotBaseSha(sha)) return { reason: lastLine(rev.stderr) || `code ${rev.code}` };
    update((fresh) => {
      if (fresh.current !== segment) return false;
      fresh.base = { segment, sha };
      return true;
    });
    return { sha };
  }

  // --- le document (S-5) ------------------------------------------------------

  /**
   * Le worktree privé du document, sur `omp-project` : réutilisé, rouvert sur la
   * branche locale ou distante, ou créé orphelin. `null`, ou la notice d'échec.
   */
  async function ensureDocWorktree(worktree: string): Promise<string | null> {
    if (fs.existsSync(worktree)) {
      const head = await deps.runGit(["symbolic-ref", "--short", "HEAD"], worktree);
      return head.code === 0 && head.stdout.trim() === PROJECT_DOC_BRANCH
        ? null
        : `[project] worktree du document invalide : ${worktree}`;
    }
    // Une inscription orpheline (dossier supprimé à la main) bloquerait l'ajout :
    // le retrait la nettoie, et son échec (rien à nettoyer) est sans conséquence.
    await deps.runGit(["worktree", "remove", "--force", worktree], deps.repoRoot);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    const hasBranch = async () =>
      (await deps.runGit(["rev-parse", "--verify", "--quiet", DOC_REF], deps.repoRoot)).code === 0;
    if (!(await hasBranch())) {
      const pushUrl = projectState.target?.pushUrl ?? (await resolveTarget()).pushUrl;
      if (pushUrl !== null) {
        await deps.runGitNet(["fetch", "--no-tags", pushUrl, `+${DOC_REF}:${DOC_REF}`], deps.repoRoot);
      }
    }
    const added = (await hasBranch())
      ? await deps.runGit(["worktree", "add", worktree, PROJECT_DOC_BRANCH], deps.repoRoot)
      : await deps.runGit(["worktree", "add", "--orphan", "-b", PROJECT_DOC_BRANCH, worktree], deps.repoRoot);
    return added.code === 0 ? null : `[project] document non commité : ${lastLine(added.stderr) || `code ${added.code}`}`;
  }

  /** Une synchronisation : rendu, commit s'il diffère, push (ou push seul d'un commit resté local). */
  async function syncDocNow(): Promise<void> {
    if (read() === null) return;
    const worktree = projectDocWorktreePath(deps.stateDir(), repoKey);
    const failure = await ensureDocWorktree(worktree);
    if (failure !== null) {
      warnOnce(failure);
      return;
    }
    // Le rendu et les évènements sont pris ENSEMBLE, sans `await` entre eux : le
    // commit porte exactement les évènements de l'état qu'il écrit.
    const project = read();
    if (project === null) return;
    const content = renderProjectDoc(project, repoName);
    const file = path.join(worktree, PROJECT_DOC_FILE);
    let previous: string | null = null;
    try {
      previous = fs.readFileSync(file, "utf8");
    } catch {
      previous = null;
    }
    if (previous !== content) {
      const events = projectState.docEvents.splice(0);
      fs.writeFileSync(file, content, "utf8");
      const message = `docs(project): ${events.length > 0 ? events.join("; ") : "mise à jour"}`.slice(0, 200);
      const added = await deps.runGit(["add", PROJECT_DOC_FILE], worktree);
      const committed = added.code === 0 ? await deps.runGit(["commit", "-m", message], worktree) : added;
      if (committed.code !== 0) {
        projectState.docEvents.unshift(...events);
        warnOnce(`[project] document non commité : ${lastLine(committed.stderr) || `code ${committed.code}`}`);
        return;
      }
      projectState.docUnpushed = true;
    } else if (!projectState.docUnpushed) {
      return;
    }
    const pushUrl = projectState.target?.pushUrl ?? (await resolveTarget()).pushUrl;
    if (pushUrl === null) {
      warnOnce(`[project] document non poussé : ${NO_PUSH_URL} — nouvel essai au prochain changement`);
      return;
    }
    const pushed = await deps.runGitNet(["push", pushUrl, `${DOC_REF}:${DOC_REF}`], worktree);
    if (pushed.code !== 0) {
      warnOnce(
        `[project] document non poussé : ${lastLine(pushed.stderr) || `code ${pushed.code}`} — nouvel essai au prochain changement`,
      );
      return;
    }
    projectState.docUnpushed = false;
  }

  function syncDoc(events: string[]): void {
    projectState.docEvents.push(...events);
    // Une file de promesses qui ne rejette jamais : une synchronisation en file
    // s'exécute même si le relais se désarme entre-temps.
    projectState.docQueue = projectState.docQueue.then(syncDocNow).catch(() => undefined);
  }

  // --- la passe (S-7) ---------------------------------------------------------

  /** Le sondage des fusions (S-7 §2) : `gh pr view` pour chaque PR ouverte du segment courant. */
  async function pollMerges(project: Project): Promise<void> {
    if (projectState.docUnpushed) syncDoc([]);
    for (const feature of (project.segments[project.current] as ProjectSegment).features) {
      if (feature.status !== "pr" || feature.prUrl === null) continue;
      const slug = feature.slug;
      const prUrl = feature.prUrl;
      const view = await deps.runGh(["pr", "view", prUrl, "--json", "state,url"], deps.repoRoot);
      const state = view.code === 0 ? prStateOf(view.stdout) : null;
      if (state === null) {
        const reason =
          view.code === 127 ? "gh introuvable — installe GitHub CLI" : lastLine(view.stderr) || `code ${view.code}`;
        warnOnce(`[project] fusion de ${slug} invérifiable : ${reason}`);
        continue;
      }
      const stillOpen = (f: ProjectFeature) => f.status === "pr" && f.prUrl === prUrl;
      if (state === "MERGED") {
        const merged = updateFeature(slug, stillOpen, (f) => {
          f.status = "merged";
        });
        if (merged !== null) {
          notify(`[project] ${slug} : PR fusionnée (${prUrl})`);
          syncDoc([`${slug} fusionnée`]);
        }
      } else if (state === "CLOSED") {
        const at = now();
        const failed = updateFeature(slug, stillOpen, (f) => {
          f.status = "failed";
          f.failure = { kind: "pr", reason: `PR fermée sans fusion : ${prUrl}`, at };
        });
        if (failed !== null) syncDoc([`${slug} en échec`]);
      }
    }
  }

  /** L'ajout d'une feature au lot, relayée à la session /project, depuis la base du segment. */
  async function addToLot(project: Project, feature: ProjectFeature, sha: string): Promise<string | null> {
    try {
      return await deps.controller().add({
        name: feature.slug,
        description: feature.intention,
        deps: [],
        auditSession: project.relayKey,
        relayKind: "project",
        // Les deux modèles de la feature de plan (S-2) : transportés tels quels vers
        // le lot — `undefined` (groupe au défaut) n'écrit aucune clé.
        modelReqSpecs: feature.modelReqSpecs ?? null,
        modelImplReview: feature.modelImplReview ?? null,
        fallbackReqSpecs: feature.fallbackReqSpecs ?? null,
        fallbackImplReview: feature.fallbackImplReview ?? null,
        base: sha,
      });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Le lancement du segment courant (S-7 §4) : base, puis un ajout par feature `planned`. */
  async function launchSegment(project: Project): Promise<void> {
    const index = project.current;
    const segment = project.segments[index] as ProjectSegment;
    if (!segment.features.some((feature) => feature.status === "planned")) return;
    const hasBase = project.base !== null && project.base.segment === index;
    const last = projectState.lastLaunchAttemptAt;
    if (!hasBase && last !== null && now() - last < PROJECT_POLL_MS) return;
    const where = `segment ${index + 1}/${project.segments.length} « ${segment.name} »`;
    const base = await ensureBase();
    if ("reason" in base) {
      projectState.lastLaunchAttemptAt = now();
      waitReason = base.reason;
      warnOnce(`[project] ${where} en attente : ${base.reason} — nouvel essai dans 60 s`);
      return;
    }
    projectState.lastLaunchAttemptAt = null;
    waitReason = null;
    const launched: string[] = [];
    for (const { slug } of segment.features) {
      // Relu avant CHAQUE ajout : un arrêt, un retrait ou un changement de segment
      // tombé pendant l'ajout précédent l'emporte.
      const fresh = read();
      const feature = fresh === null ? undefined : currentFeature(fresh, slug);
      if (fresh === null || fresh.status !== "running" || fresh.current !== index || feature?.status !== "planned") {
        continue;
      }
      const refusal = await addToLot(fresh, feature, base.sha);
      if (refusal === null) {
        updateFeature(slug, (f) => f.status === "planned", (f) => {
          f.status = "launched";
        });
        syncDoc([`${slug} lancée`]);
        launched.push(slug);
      } else {
        const at = now();
        updateFeature(slug, (f) => f.status === "planned", (f) => {
          f.status = "failed";
          f.failure = { kind: "launch", reason: `lancement refusé : ${refusal}`, at };
        });
        syncDoc([`${slug} en échec`]);
      }
    }
    if (launched.length > 0) {
      notify(`[project] ${where} lancé : ${launched.length} pipeline(s) — ${launched.join(", ")}`);
      syncDoc([`segment ${index + 1} lancé`]);
    }
  }

  async function pass(): Promise<void> {
    let project = read();
    if (project === null || project.status !== "running") return;

    // 1. L'avancement des features lancées, relu dans le lot.
    const synced = syncFromLot(project, readLot(deps.stateDir(), repoKey), now());
    if (synced.events.length > 0) {
      writeProject(deps.stateDir(), synced.project);
      syncDoc(synced.events);
      project = synced.project;
    }

    // 2. Les fusions, au plus une fois par minute (la première passe sonde tout de suite).
    const polledAt = now();
    if (projectState.lastPollAt === null || polledAt - projectState.lastPollAt >= PROJECT_POLL_MS) {
      projectState.lastPollAt = polledAt;
      await pollMerges(project);
    }

    // Un amendement en dialogue fige le plan : ni achèvement ni lancement (S-9).
    if (projectState.amending) return;

    // 3. L'achèvement du segment courant.
    project = read();
    if (project === null || project.status !== "running") return;
    if (segmentDone(project)) {
      const index = project.current;
      if (index === project.segments.length - 1) {
        const done = update((fresh) => {
          if (fresh.status !== "running" || fresh.current !== index || !segmentDone(fresh)) return false;
          fresh.status = "done";
          return true;
        });
        if (done !== null) {
          const merged = done.segments.flatMap((s) => s.features).filter((f) => f.status === "merged").length;
          syncDoc(["projet terminé"]);
          notify(
            `[project] projet terminé : ${done.segments.length} segment(s), ${merged} feature(s) fusionnée(s) — document ${PROJECT_DOC_FILE} sur la branche ${PROJECT_DOC_BRANCH}`,
          );
        }
        return;
      }
      const advanced = update((fresh) => {
        if (fresh.status !== "running" || fresh.current !== index || !segmentDone(fresh)) return false;
        fresh.current = index + 1;
        fresh.base = null;
        return true;
      });
      if (advanced === null) return;
      syncDoc([]);
      projectState.lastLaunchAttemptAt = null;
      waitReason = null;
      project = advanced;
    }

    // 4. Le lancement du segment courant.
    await launchSegment(project);
  }

  function tick(): Promise<void> {
    const next = passes.then(pass, pass);
    passes = next.catch(() => undefined);
    return next;
  }

  /** La feature en échec du segment courant d'un projet en cours, ou le motif du refus. */
  function failedFeature(slug: string): { project: Project; feature: ProjectFeature } | string {
    const project = read();
    if (project === null || project.status !== "running") return "aucun projet en cours dans ce dépôt";
    const feature = currentFeature(project, slug);
    if (feature === undefined || feature.status !== "failed" || feature.failure === null) {
      return `« ${slug} » n'est pas en échec dans le segment courant`;
    }
    return { project, feature };
  }

  const markRelaunched = (slug: string, status: "launched" | "pr") => {
    updateFeature(slug, (f) => f.status === "failed", (f) => {
      f.status = status;
      f.failure = null;
    });
    syncDoc([`${slug} relancée`]);
  };

  return {
    tick,

    async relaunch(slug) {
      const found = failedFeature(slug);
      if (typeof found === "string") return found;
      const { project, feature } = found;
      const failure = feature.failure as NonNullable<ProjectFeature["failure"]>;
      if (failure.kind === "lot") {
        const refusal = await deps.controller().relaunch(slug);
        if (refusal !== null) return refusal;
        markRelaunched(slug, "launched");
        return null;
      }
      if (failure.kind === "pr") {
        const reopened = await deps.runGh(["pr", "reopen", feature.prUrl ?? ""], deps.repoRoot);
        if (reopened.code !== 0) {
          return `réouverture refusée : ${lastLine(reopened.stderr) || `code ${reopened.code}`}`;
        }
        markRelaunched(slug, "pr");
        return null;
      }
      const base = await ensureBase();
      if ("reason" in base) return base.reason;
      const refusal = await addToLot(project, feature, base.sha);
      if (refusal !== null) {
        const reason = `lancement refusé : ${refusal}`;
        const at = now();
        updateFeature(slug, (f) => f.status === "failed", (f) => {
          f.failure = { kind: "launch", reason, at };
        });
        syncDoc([`${slug} en échec`]);
        return reason;
      }
      markRelaunched(slug, "launched");
      return null;
    },

    async remove(slug) {
      const found = failedFeature(slug);
      if (typeof found === "string") return found;
      if (found.feature.failure?.kind === "lot") {
        const lot = readLot(deps.stateDir(), repoKey);
        const lf = lot === null ? undefined : lotFeature(lot, slug);
        if (lf !== undefined && (lf.state === "failed" || lf.state === "blocked")) {
          const refusal = await deps.controller().cancel(slug, "keep");
          if (refusal !== null) return refusal;
        }
      }
      const removed = updateFeature(slug, (f) => f.status === "failed", (f) => {
        f.status = "removed";
        f.removedReason = `retirée par l'utilisateur après échec : ${f.failure?.reason ?? ""}`;
        f.failure = null;
      });
      if (removed === null) return `« ${slug} » n'est pas en échec dans le segment courant`;
      syncDoc([`${slug} retirée`]);
      return null;
    },

    async stop() {
      const stopped = update((project) => {
        if (project.status !== "running") return false;
        project.status = "stopped";
        return true;
      });
      if (stopped === null) return "aucun projet en cours dans ce dépôt";
      syncDoc(["projet arrêté"]);
      return null;
    },

    syncDoc,

    waiting() {
      return waitReason;
    },
  };
}
