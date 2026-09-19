// omp-mem0-req — Pipeline besoins → specs → implémentation → revue, one-shot.
//
// Quatre sessions dédiées (/req, /specs, /impl, /review). L'état traverse les
// sessions par un FICHIER CONTRAT déterministe, .omp/pipeline/contract.md, que
// l'agent écrit et relit avec ses outils standards (write / read).
//
// Pourquoi un fichier et pas la mémoire mem0 : les besoins, les critères
// d'acceptation, les specs et les lots sont des artefacts TRANSITOIRES d'une
// feature. mem0 est un store durable, non déterministe (recall à plancher de
// score) qui déduplique et fusionne à l'écriture — y déposer des specs, c'est en
// perdre au recall, les voir fusionner, et polluer la mémoire durable. Un fichier
// les porte à l'octet près, sans fusion, et laisse le préfixe système stable entre
// sessions (cache local). mem0 ne garde que les décisions DURABLES (choix +
// raison), écrites par /impl.
//
// Le pipeline est piloté par le CRITÈRE D'ACCEPTATION : chaque maillon descend
// d'un id, ce qui rend la chaîne vérifiable au lieu d'être déclarative.
//   B-n (besoin) → AC-n (critère, Given/When/Then) → S-n (spec) → BR-n (lot)
//   → test tagué AC-n → verdict /review
//
//   1. /req    : mode collecte. before_agent_start injecte une directive qui fait
//                clarifier l'INTENTION (ce que seul l'utilisateur sait) — résultat
//                attendu, périmètre, criticité — ET les critères d'acceptation
//                (comportement observable, donc de l'intention) ; pas la technique
//                (ça, c'est /specs, qui lit le dépôt). Clôture refusée tant qu'un
//                besoin n'a pas ≥1 critère falsifiable. « fin » (mot isolé) clôt :
//                l'agent écrit besoins et critères validés dans le contrat.
//   2. /specs  : session qui lit le contrat, lève les ambiguïtés TECHNIQUES contre
//                le dépôt réel, écrit les specs (tracées vers les critères) puis les
//                LOTS — briefs typés (ui / archi / aucun) qui portent le « comment ».
//   3. /impl   : session qui lit le contrat (déterministe) et implémente d'un
//                trait ; s'arrête si le contrat n'a pas de specs ; prouve chaque
//                AC-n par un test qui porte l'id du critère.
//   4. /review : session qui révise le git diff contre le contrat, critère par
//                critère (grep AC-n → test → pass/fail).
//
// FIN DE MAILLON — à chaque retombée terminale, l'extension annonce la commande de
// la suite dans le transcript (message d'affichage durable, pas un toast) : /specs
// après /req, /impl après /specs, /review après /impl, puis /impl --fix tant que
// `## Revue` consigne un BLOQUANT — sinon la fin du cycle est signalée. Un maillon
// dont le contrat n'a pas de `## Spécifications` renvoie vers /specs. En session
// interactive, la commande est en plus PRÉREMPLIE dans la zone de saisie (jamais
// par-dessus un brouillon). Le déclencheur est `session_stop`, pas `agent_end` :
// lui seul marque la retombée terminale du fil principal.
//
// Indépendante du plugin omp-mem0-memory : ne dépend que de l'API de base d'OMP
// (pi.registerCommand, pi.on). Sans plugin mémoire, le pipeline fonctionne quand
// même : le contrat est un simple fichier.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Contrat unique de la feature active, relatif à la racine du dépôt (même
// convention que .omp/mem0-brief.md). Une seule feature active à la fois : un
// nouveau cycle /req réécrit le contrat.
//
// Depuis l'isolation en worktree, ce chemin est RELATIF AU CWD : le cwd de la
// session est le worktree de la feature, donc le contrat vit sur la branche de la
// feature. Deux features ouvertes en parallèle ont deux cwd, donc deux contrats.
//
// Sections, dans cet ordre — chaque id référence celui dont il descend :
//   ## Besoins                B-<n>
//   ## Critères d'acceptation AC-<n> (B-<m>) : Given/When/Then (écrits par /req)
//   ## Documentation          doc externe rassemblée par /specs
//   ## Spécifications         S-<n> (AC-<m>) : comportement observable
//   ## Lots                   BR-<n> — type: ui | archi | aucun — sert AC-<m>
//   ## Revue                  verdict de /review ; BLOQUANTS relus par /impl --fix
export const CONTRACT_PATH = ".omp/pipeline/contract.md";

// ---------------------------------------------------------------------------
// State — CWD-keyed, PAS session-keyed
// ---------------------------------------------------------------------------
// /req remplace la session en cours (newSession + moveTo) pour l'installer dans
// le worktree de la feature : une clé par session perdrait la collecte au moment
// même où elle s'arme. Le cwd est l'identité stable — c'est le worktree de la
// feature, et c'est lui qui porte le contrat.

type ReqState = {
  reqMode: boolean;
  /** Maillon du pipeline ARMÉ pour ce cwd — absent hors pipeline. */
  phase?: PipelinePhase;
  /** /req : l'utilisateur a dit « fin » — le maillon peut se clore. */
  closing?: boolean;
  /** La suite de ce maillon a déjà été annoncée : une seule annonce par maillon. */
  announced?: boolean;
  /** Instant du lancement du maillon courant : le temps affiché repart de là. */
  phaseStartedAt?: number;
  /** Dernière entrée publiée dans le magasin — la session publiée vient d'elle. */
  entry?: RunningEntry;
};

const states = new Map<string, ReqState>();

function stateOfCwd(cwd: string | undefined): ReqState {
  const key = cwd ? path.resolve(cwd) : "session";
  let st = states.get(key);
  if (!st) {
    st = { reqMode: false };
    states.set(key, st);
  }
  return st;
}

/**
 * Arme un maillon : à sa prochaine retombée terminale, la suite sera annoncée.
 * À appeler APRÈS la bascule de session et juste AVANT `sendUserMessage` — armé
 * plus tôt, l'annonce partirait sur la retombée du tour PRÉCÉDENT (l'utilisateur
 * lance /specs pendant que le tour de /req tourne encore).
 */
function armPhase(cwd: string | undefined, phase: PipelinePhase): void {
  const st = stateOfCwd(cwd);
  st.phase = phase;
  st.closing = false; // le maillon qui s'arme n'a pas dit « fin »
  st.announced = false;
}

// ---------------------------------------------------------------------------
// Worktree de feature — une feature = un worktree, sur sa branche.
// ---------------------------------------------------------------------------
// /req n'ouvre plus une collecte dans le dépôt principal : il crée un worktree
// dédié (branche feat/<slug>) et y relocalise la session. Le contrat, relatif au
// cwd, vit alors sur la branche de la feature ; deux features en parallèle ne se
// marchent plus dessus.
//
// Les worktrees ne vivent PAS sous ~/.omp/wt : `omp worktree clear --all` y
// supprime tout, y compris du travail non commité (voir `## Documentation` §2 du
// contrat). Ils vivent sous ~/.omp/pipeline-worktrees (MEM0_PIPELINE_WORKTREES_DIR).

export type GitResult = { code: number; stdout: string; stderr: string };
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

// Même budget par opération que la convention du dépôt (omp-mem0-memory) : une
// commande git locale qui dépasse 10 s est un blocage, pas une lenteur.
export const GIT_TIMEOUT_MS = 10_000;

// realpath avec repli : une comparaison de préfixes doit porter sur des chemins
// réels (/tmp → /private/tmp sous macOS), mais un chemin absent n'est pas une
// erreur — c'est le cas « worktree introuvable sur le disque ».
function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Strictement sous : `<base>` lui-même n'est pas un candidat.
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return false;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** Contenu d'un `.git` FICHIER de worktree lié : « gitdir: X » → X, sinon null. */
export function gitfileTarget(contents: string): string | null {
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(contents);
  return m && m[1] ? m[1] : null;
}

/**
 * « …/.git/worktrees/<nom> » → dépôt principal, sinon null. Un `.git` de
 * sous-module pointe vers `…/.git/modules/<nom>` : ce n'est PAS un worktree, et
 * le confondre avec un dépôt principal déplacerait la mémoire du projet.
 */
export function primaryRootOf(gitdir: string): string | null {
  const p = gitdir.trim().replace(/\\/g, "/");
  const m = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(p);
  if (!m) return null;
  const primary = m[1].replace(/\/+$/, "");
  return primary || null;
}

/**
 * Racine de feature vue depuis `cwd`. `primary` est défini ssi `cwd` est dans un
 * worktree lié — c'est le signal « déjà dans une feature » ET le dépôt principal
 * d'où l'on crée les worktrees. Aucun `.git` trouvé en remontant : `dir` reste le
 * cwd (l'appelant refuse via l'absence de `.git`).
 */
export function resolveFeatureRoot(cwd: string): { dir: string; primary?: string } {
  const start = path.resolve(cwd);
  let dir = start;
  for (let i = 0; i < 32; i++) {
    const dotGit = path.join(dir, ".git");
    if (fs.existsSync(dotGit)) {
      try {
        if (fs.statSync(dotGit).isFile()) {
          const target = gitfileTarget(fs.readFileSync(dotGit, "utf8"));
          const primary = target ? primaryRootOf(target) : null;
          if (primary) return { dir, primary };
        }
      } catch {
        /* `.git` illisible : traité comme un dépôt local, comportement inchangé */
      }
      return { dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dir: start };
}

/** Normalisation d'un nom de feature en slug : [a-z0-9-], 40 caractères max. */
export function toSlug(raw: string): string | null {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || null;
}

export function branchFor(slug: string): string {
  return `feat/${slug}`;
}

/**
 * Base des worktrees de feature : `MEM0_PIPELINE_WORKTREES_DIR` (absolu ou `~`,
 * prioritaire) sinon `~/.omp/pipeline-worktrees`. Un chemin relatif est ignoré —
 * il dépendrait du cwd, donc de la session.
 */
export function worktreesBaseDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const raw = (env.MEM0_PIPELINE_WORKTREES_DIR ?? "").trim();
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.join(home, ".omp", "pipeline-worktrees");
}

/**
 * `<base>/<repo>-<hash7>/<slug>` : le nom de dossier nomme le dépôt (assaini), le
 * hash de son chemin réel le désambiguïse (deux `mem0-omp` clonés ne partagent pas
 * leur base), le slug nomme la feature.
 */
export function worktreePathFor(base: string, primaryRoot: string, slug: string): string {
  const real = realpathOr(primaryRoot);
  const repo = path.basename(real).replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
  const hash7 = crypto.createHash("sha1").update(real).digest("hex").slice(0, 7);
  return path.join(base, `${repo}-${hash7}`, slug);
}

/** `<cwd>/.omp/pipeline/contract.md` — le contrat est relatif au cwd de la session. */
export function contractPathFor(cwd: string): string {
  return path.join(path.resolve(cwd), CONTRACT_PATH);
}

const LINK_GATE_REFUSAL =
  "cette session n'est pas dans le worktree d'une feature — ouvre la session depuis le worktree " +
  "de la feature, ou lance /req depuis le dépôt principal.";

/**
 * Garde d'entrée de /specs, /impl et /review : la session doit être dans le
 * worktree d'une feature, ou porter un contrat hérité du mode sans worktree —
 * une feature déjà ouverte avant l'isolation ne doit pas être bloquée en cours de
 * cycle. Refus ⇒ aucune session créée, aucun seed envoyé.
 */
export function linkGate(cwd: string): { ok: true } | { ok: false; reason: string } {
  if (resolveFeatureRoot(cwd).primary) return { ok: true };
  if (fs.existsSync(contractPathFor(cwd))) return { ok: true };
  return { ok: false, reason: LINK_GATE_REFUSAL };
}

/** `feat/<branche>` prise en local ou connue d'un remote — aucune création alors. */
export async function branchTaken(run: GitRunner, primaryRoot: string, branch: string): Promise<boolean> {
  const local = await run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], primaryRoot);
  if (local.code === 0) return true;
  const remote = await run(["for-each-ref", "--format=%(refname:lstrip=2)", "refs/remotes/"], primaryRoot);
  if (remote.code !== 0) return false;
  return remote.stdout
    .split("\n")
    .some((line) => line.trim().endsWith(`/${branch}`));
}

/**
 * Crée le worktree de la feature depuis le dépôt principal. Aucun `--force`,
 * aucun commit, aucune commande distante : `git worktree add -b feat/<slug> <chemin>
 * HEAD`. L'arbre est vierge (le refus de git est la garantie, jamais un `rm`).
 */
export async function createFeatureWorktree(input: {
  run: GitRunner;
  primaryRoot: string;
  slug: string;
  baseDir: string;
}): Promise<{ ok: true; path: string; branch: string } | { ok: false; error: string }> {
  const { run, primaryRoot, slug, baseDir } = input;
  const branch = branchFor(slug);

  if (await branchTaken(run, primaryRoot, branch)) {
    return { ok: false, error: `la branche ${branch} existe déjà` };
  }

  const target = worktreePathFor(baseDir, primaryRoot, slug);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const add = await run(["worktree", "add", "-b", branch, target, "HEAD"], primaryRoot);
  if (add.code !== 0) {
    return { ok: false, error: add.stderr.trim() || `git worktree add a échoué (code ${add.code})` };
  }
  return { ok: true, path: realpathOr(target), branch };
}

// Accueil posté après la relocalisation. Il contient « fin » (« Dites « fin » … ») :
// il se poste en message d'AFFICHAGE (pi.sendMessage, triggerTurn:false), jamais via
// sendUserMessage — un tour démarré là ferait détecter le mot « fin » par
// before_agent_start et la collecte se clôturerait avant que l'utilisateur ait parlé.
export function buildWelcome(feature: { slug: string; branch: string; path: string }): string {
  return (
    `[req] Feature « ${feature.slug} » ouverte dans son worktree : ${feature.path}\n` +
    `(branche ${feature.branch}, créée depuis le dépôt principal, qui n'est pas modifié ; la session\n` +
    "précédente reste disponible). Décrivez-moi ce que vous voulez obtenir : je clarifie\n" +
    "l'intention — résultat attendu, périmètre, criticité — et les critères d'acceptation\n" +
    "(Given/When/Then), sans toucher aux choix techniques (ça, c'est /specs).\n" +
    "Dites « fin » quand tout est dit : je figerai vos besoins et leurs critères dans\n" +
    `${CONTRACT_PATH}, puis lancez /specs.`
  );
}

// ---------------------------------------------------------------------------
// Balayage des worktrees de feature — le push de l'utilisateur vaut clôture.
// ---------------------------------------------------------------------------
// La pipeline ne pousse jamais : elle constate. Un worktree dont la branche est
// poussée ET dont l'arbre est propre est retiré (la branche reste) au maillon
// suivant ; tout le reste est conservé, avec sa raison. Échec = conservation.

// Sous-commandes git que la pipeline s'autorise. Ni push, ni fetch, ni pull : le
// dépôt distant n'est jamais touché.
export const PIPELINE_GIT_SUBCOMMANDS: readonly string[] = ["rev-parse", "worktree", "status", "for-each-ref"];

/** Sortie de `git worktree list --porcelain` → une entrée par worktree, dans l'ordre. */
export function parseWorktreeList(porcelain: string): Array<{ path: string; head: string; branch?: string }> {
  const out: Array<{ path: string; head: string; branch?: string }> = [];
  let cur: { path: string; head: string; branch?: string } | null = null;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      cur = { path: value, head: "" };
      continue;
    }
    if (!cur) continue;
    if (key === "HEAD") cur.head = value;
    else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") cur.branch = undefined;
  }
  flush();
  return out;
}

/** Shas des refs distantes portant exactement `<branche>` (`origin/feat/x`, …). */
export function remoteShas(refsOutput: string, branch: string): string[] {
  const shas: string[] = [];
  for (const line of refsOutput.split("\n")) {
    const [ref, sha] = line.trim().split(/\s+/);
    if (ref && sha && ref.endsWith(`/${branch}`)) shas.push(sha);
  }
  return shas;
}

/**
 * Verdict pour un candidat, dans cet ordre : hors base → session courante →
 * introuvable → HEAD détaché → modifications non commitées → branche non poussée.
 * Les fichiers ignorés (dont le contrat) n'apparaissent pas dans `status`, donc un
 * worktree porteur du contrat reste « propre ».
 */
export function reapDecision(input: {
  path: string;
  branch?: string;
  head: string;
  status: string;
  remoteRefs: string;
  baseDir: string;
  currentCwd: string;
  exists: boolean;
}): { remove: true } | { remove: false; reason: string } {
  const real = realpathOr(input.path);
  if (!isUnder(real, realpathOr(input.baseDir))) {
    return { remove: false, reason: "hors du répertoire des worktrees de feature" };
  }
  const cwd = realpathOr(input.currentCwd);
  if (real === cwd || isUnder(cwd, real)) {
    return { remove: false, reason: "worktree de la session courante" };
  }
  if (!input.exists) return { remove: false, reason: "worktree introuvable sur le disque" };
  if (!input.branch) return { remove: false, reason: "HEAD détaché" };
  if (input.status.trim()) return { remove: false, reason: "modifications non commitées" };
  if (!remoteShas(input.remoteRefs, input.branch).includes(input.head)) {
    return { remove: false, reason: "branche non poussée" };
  }
  return { remove: true };
}

/**
 * Balayage d'une passe. Rien n'est sondé si `<base>` n'existe pas, et rien n'est
 * retiré avant que TOUTES les décisions soient prises : un balayage qui échoue en
 * cours de route ne retire rien (l'appelant le signale en warning).
 */
export async function sweepFeatureWorktrees(input: {
  run: GitRunner;
  baseDir: string;
  currentCwd: string;
  repoRoot: string;
}): Promise<{ removed: Array<{ path: string; branch: string }>; kept: Array<{ path: string; reason: string }> }> {
  const { run, baseDir, currentCwd, repoRoot } = input;
  const removed: Array<{ path: string; branch: string }> = [];
  const kept: Array<{ path: string; reason: string }> = [];
  if (!fs.existsSync(baseDir)) return { removed, kept };

  const list = await run(["worktree", "list", "--porcelain"], repoRoot);
  if (list.code !== 0) {
    throw new Error(list.stderr.trim() || `git worktree list a échoué (code ${list.code})`);
  }

  const pending: Array<{ path: string; branch: string }> = [];
  for (const entry of parseWorktreeList(list.stdout)) {
    if (!isUnder(realpathOr(entry.path), realpathOr(baseDir))) continue; // pas un candidat

    // Deux sous-processus par candidat, et seulement s'il peut encore l'être.
    const exists = fs.existsSync(entry.path);
    let status = "";
    let remoteRefs = "";
    if (exists && entry.branch) {
      const st = await run(["status", "--porcelain"], entry.path);
      if (st.code !== 0) {
        throw new Error(st.stderr.trim() || `git status a échoué dans ${entry.path} (code ${st.code})`);
      }
      status = st.stdout;
      const refs = await run(
        ["for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/remotes/"],
        entry.path,
      );
      if (refs.code !== 0) {
        throw new Error(refs.stderr.trim() || `git for-each-ref a échoué dans ${entry.path} (code ${refs.code})`);
      }
      remoteRefs = refs.stdout;
    }

    const decision = reapDecision({
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      status,
      remoteRefs,
      baseDir,
      currentCwd,
      exists,
    });
    if (decision.remove) pending.push({ path: entry.path, branch: entry.branch ?? "" });
    else kept.push({ path: entry.path, reason: decision.reason });
  }

  for (const candidate of pending) {
    const res = await run(["worktree", "remove", candidate.path], repoRoot);
    if (res.code === 0) removed.push(candidate);
    else kept.push({ path: candidate.path, reason: res.stderr.trim() || `retrait refusé (code ${res.code})` });
  }
  return { removed, kept };
}

/** Une ligne par entrée, `""` s'il n'y a rien à signaler. */
export function buildSweepMessage(result: {
  removed: Array<{ path: string; branch: string }>;
  kept: Array<{ path: string; reason: string }>;
}): string {
  const lines: string[] = [];
  for (const r of result.removed) {
    lines.push(`[pipeline] worktree retiré : ${r.path} — branche ${r.branch} conservée (poussée).`);
  }
  for (const k of result.kept) {
    lines.push(`[pipeline] worktree conservé : ${k.path} — ${k.reason}.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Registre des pipelines — le magasin d'état partagé par TOUS les processus.
// ---------------------------------------------------------------------------
// Le panneau liste les pipelines de tous les processus OMP de la machine, y
// compris ceux d'autres dépôts : un état en mémoire ne traverse pas les
// processus, et un démon serait un service de plus à faire vivre. Chaque
// processus PUBLIE donc ses pipelines armées dans un répertoire de fichiers, et
// le panneau LIT ce répertoire. Un fichier par pipeline — jamais un fichier
// partagé — écrit dans un temporaire puis RENOMMÉ : un lecteur ne voit jamais un
// JSON partiel.
//
// Le propriétaire fait autorité : lui seul écrit son fichier (`owner.pid`) et lui
// seul calcule l'état publié (`running` / `waiting`). Les autres processus se
// contentent de CONSTATER la mort d'un propriétaire pour déplacer l'entrée vers
// l'historique — c'est le seul effet de bord qu'un lecteur s'autorise. Il est
// idempotent : l'id d'une entrée d'historique dérive de l'entrée (cwd + instant
// de fin), jamais de l'instant du constat, donc deux lecteurs écrivent le même
// fichier.

export type PipelineRunState = "running" | "waiting";
export type PipelineFinalState = "done" | "failed";

/** Entrée `running/<id>.json` : une pipeline en cours, écrite par son propriétaire. */
export type RunningEntry = {
  id: string;
  cwd: string;
  label: string;
  phase: PipelinePhase;
  state: PipelineRunState;
  phaseStartedAt: number;
  updatedAt: number;
  sessionFile: string | null;
  sessionId: string | null;
  owner: { pid: number };
};

/** Entrée `history/<id>.json` : une pipeline close, écrite une seule fois. */
export type HistoryEntry = {
  id: string;
  cwd: string;
  label: string;
  phase: PipelinePhase;
  finalState: PipelineFinalState;
  sessionFile: string | null;
  sessionId: string | null;
  phaseStartedAt: number;
  endedAt: number;
};

export type StoreSnapshot = { running: RunningEntry[]; history: HistoryEntry[]; unreadable: number };

/** Le strict nécessaire d'un contexte pour publier/constater : rien d'OMP-specific. */
export type PipelineCtx = {
  cwd?: string;
  isIdle?: () => boolean;
  sessionManager?: {
    getCwd?: () => string;
    getSessionFile?: () => string | undefined;
    getSessionId?: () => string;
  };
  setInterval?: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown;
  clearTimer?: (timer: unknown) => void;
};

/** Seuls les fichiers d'id sont lus : temporaires d'écriture, `.DS_Store` ignorés. */
const STORE_FILE = /^[0-9a-f]{16}\.json$/;

// Bornes d'une passe de lecture : au-delà, le panneau ne sert plus à rien et la
// lecture synchrone coûterait un rafraîchissement par seconde.
export const RUNNING_READ_LIMIT = 200;
export const HISTORY_READ_LIMIT = 20;

/** Battement du propriétaire : réécrit ses entrées toutes les 2 s (S-3). */
export const PIPELINE_HEARTBEAT_MS = 2000;

const PIPELINE_PHASES: readonly PipelinePhase[] = ["req", "specs", "impl", "review"];

/**
 * Répertoire d'état commun : `MEM0_PIPELINE_STATE_DIR` (absolu ou `~`,
 * prioritaire) sinon `~/.omp/agent/pipeline`. Un chemin relatif est ignoré — il
 * dépendrait du cwd, donc de la session (même règle que les worktrees).
 */
export function pipelineStateDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const raw = (env.MEM0_PIPELINE_STATE_DIR ?? "").trim();
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.join(home, ".omp", "agent", "pipeline");
}

export function pipelineRunningDir(stateDir: string): string {
  return path.join(stateDir, "running");
}

export function pipelineHistoryDir(stateDir: string): string {
  return path.join(stateDir, "history");
}

/** `sha1(path.resolve(cwd)).slice(0,16)` : un fichier par pipeline, un par cwd. */
export function runningIdFor(cwd: string): string {
  return crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 16);
}

/** `sha1(realpath(cwd) + ":" + endedAt).slice(0,16)` : une entrée par clôture. */
export function historyIdFor(cwd: string, endedAt: number): string {
  return crypto.createHash("sha1").update(`${realpathOr(cwd)}:${endedAt}`).digest("hex").slice(0, 16);
}

/** `<dépôt>/<feature>` dans un worktree de feature, sinon le basename du cwd. */
export function pipelineLabel(cwd: string): string {
  const root = resolveFeatureRoot(cwd);
  if (root.primary) return `${path.basename(root.primary)}/${path.basename(root.dir)}`;
  return path.basename(root.dir) || path.resolve(root.dir);
}

/**
 * Temps écoulé : `<m>:<ss>` sous une heure, `<h>:<mm>:<ss>` au-delà. Un écart
 * négatif (horloge reculée, entrée future) vaut `0:00` plutôt qu'un signe.
 */
export function elapsedLabel(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours === 0 ? `${minutes}:${seconds}` : `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

/**
 * Le pid vit-il ? Seul `ESRCH` veut dire « mort » : `EPERM` (processus d'un autre
 * utilisateur) est traité comme vivant, sinon on enterrerait des pipelines bien
 * vivantes. Aucun seuil de fraîcheur : un processus vivant mais figé reste en
 * cours (S-6).
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Validation champ par champ : un fichier au schéma incomplet est rejeté. */
function asRunningEntry(raw: unknown): RunningEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.version !== 1) return null;
  if (typeof e.id !== "string" || typeof e.cwd !== "string" || typeof e.label !== "string") return null;
  if (!PIPELINE_PHASES.includes(e.phase as PipelinePhase)) return null;
  if (e.state !== "running" && e.state !== "waiting") return null;
  if (typeof e.phaseStartedAt !== "number" || typeof e.updatedAt !== "number") return null;
  const owner = e.owner;
  if (!owner || typeof owner !== "object" || !("pid" in owner) || typeof owner.pid !== "number") return null;
  return {
    id: e.id,
    cwd: e.cwd,
    label: e.label,
    // La phase est validée contre la liste ci-dessus : c'est un PipelinePhase.
    phase: e.phase as PipelinePhase,
    state: e.state,
    phaseStartedAt: e.phaseStartedAt,
    updatedAt: e.updatedAt,
    sessionFile: asStringOrNull(e.sessionFile),
    sessionId: asStringOrNull(e.sessionId),
    owner: { pid: owner.pid },
  };
}

function asHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.version !== 1) return null;
  if (typeof e.id !== "string" || typeof e.cwd !== "string" || typeof e.label !== "string") return null;
  if (!PIPELINE_PHASES.includes(e.phase as PipelinePhase)) return null;
  if (e.finalState !== "done" && e.finalState !== "failed") return null;
  if (typeof e.phaseStartedAt !== "number" || typeof e.endedAt !== "number") return null;
  return {
    id: e.id,
    cwd: e.cwd,
    label: e.label,
    phase: e.phase as PipelinePhase,
    finalState: e.finalState,
    sessionFile: asStringOrNull(e.sessionFile),
    sessionId: asStringOrNull(e.sessionId),
    phaseStartedAt: e.phaseStartedAt,
    endedAt: e.endedAt,
  };
}

/** Fichiers lisibles d'un répertoire du magasin : absent ou vide ⇒ aucun. */
function storeFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    if (STORE_FILE.test(name)) files.push(path.join(dir, name));
  }
  return files;
}

/** Écriture ATOMIQUE : temporaire dans le même répertoire, puis `rename`. */
function writeJsonAtomic(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function writeRunningEntry(stateDir: string, entry: RunningEntry): void {
  writeJsonAtomic(path.join(pipelineRunningDir(stateDir), `${entry.id}.json`), { version: 1, ...entry });
}

export function writeHistoryEntry(stateDir: string, entry: HistoryEntry): void {
  writeJsonAtomic(path.join(pipelineHistoryDir(stateDir), `${entry.id}.json`), { version: 1, ...entry });
}

/** Suppression = `unlink` : un fichier déjà absent est un succès silencieux (S-7). */
export function deleteHistoryEntry(stateDir: string, id: string): void {
  if (!/^[0-9a-f]{16}$/.test(id)) return;
  try {
    fs.unlinkSync(path.join(pipelineHistoryDir(stateDir), `${id}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function deleteRunningEntry(stateDir: string, id: string): void {
  if (!/^[0-9a-f]{16}$/.test(id)) return;
  try {
    fs.unlinkSync(path.join(pipelineRunningDir(stateDir), `${id}.json`));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Une passe de lecture : les entrées du magasin, triées et bornées. Aucune
 * écriture — la réconciliation des propriétaires morts est une passe distincte.
 * Un fichier au JSON invalide ou au schéma incomplet est ignoré ET compté ; tout
 * autre fichier du répertoire (temporaire d'écriture, `.DS_Store`) est ignoré
 * sans être compté.
 */
export function readStore(stateDir: string): StoreSnapshot {
  let unreadable = 0;
  const running: RunningEntry[] = [];
  for (const file of storeFiles(pipelineRunningDir(stateDir))) {
    const entry = asRunningEntry(readJsonFile(file));
    if (entry) running.push(entry);
    else unreadable += 1;
  }
  const history: HistoryEntry[] = [];
  for (const file of storeFiles(pipelineHistoryDir(stateDir))) {
    const entry = asHistoryEntry(readJsonFile(file));
    if (entry) history.push(entry);
    else unreadable += 1;
  }
  // En cours : le plus ancien maillon d'abord (l'ordre d'arrivée) ; historique :
  // le plus récent d'abord — puis les bornes, qui gardent donc les plus récents.
  running.sort((a, b) => a.phaseStartedAt - b.phaseStartedAt || a.cwd.localeCompare(b.cwd));
  history.sort((a, b) => b.endedAt - a.endedAt || a.cwd.localeCompare(b.cwd));
  return {
    running: running.slice(0, RUNNING_READ_LIMIT),
    history: history.slice(0, HISTORY_READ_LIMIT),
    unreadable,
  };
}

/**
 * Réconciliation : toute entrée en cours dont le propriétaire n'existe plus passe
 * à l'historique en `failed`. L'écriture d'historique PRÉCÈDE la suppression du
 * fichier en cours : une écriture impossible laisse l'entrée en cours (pas de
 * perte silencieuse). `endedAt` est le dernier `updatedAt` connu — l'instant où
 * le propriétaire a cessé de battre — ce qui rend l'opération idempotente entre
 * deux lecteurs.
 */
export function reconcileStore(stateDir: string, snapshot: StoreSnapshot = readStore(stateDir)): StoreSnapshot {
  const alive: RunningEntry[] = [];
  const moved: HistoryEntry[] = [];
  for (const entry of snapshot.running) {
    if (pidAlive(entry.owner.pid)) {
      alive.push(entry);
      continue;
    }
    const endedAt = entry.updatedAt;
    const record: HistoryEntry = {
      id: historyIdFor(entry.cwd, endedAt),
      cwd: entry.cwd,
      label: entry.label,
      phase: entry.phase,
      finalState: "failed",
      sessionFile: entry.sessionFile,
      sessionId: entry.sessionId,
      phaseStartedAt: entry.phaseStartedAt,
      endedAt,
    };
    try {
      writeHistoryEntry(stateDir, record);
      deleteRunningEntry(stateDir, entry.id);
    } catch {
      alive.push(entry); // écriture impossible : l'entrée en cours reste
      continue;
    }
    moved.push(record);
  }
  if (moved.length === 0) return snapshot;
  const history = [...moved, ...snapshot.history].sort((a, b) => b.endedAt - a.endedAt).slice(0, HISTORY_READ_LIMIT);
  return { running: alive, history, unreadable: snapshot.unreadable };
}

// --- côté propriétaire : armement, battement, publication -------------------

/** Horloge et sorties injectables : les tests pilotent le temps et les notices. */
export type PublishDeps = {
  ctx?: PipelineCtx;
  notify?: (text: string) => void;
  now?: () => number;
  stateDir?: string;
};

// Compteurs d'activité par identifiant d'appel d'outil : incrémentés et
// décrémentés, jamais posés à zéro sur un événement — un `tool_execution_end`
// manquant (processus tué, tour interrompu) ne doit pas figer l'état.
const pendingAsks = new Set<string>();
const pendingApprovals = new Set<string>();

// Dernier contexte vu pour ce processus : source de `isIdle` (délégué au runner,
// donc vivant) et de la session publiée. Le battement n'en a pas d'autre.
let liveCtx: PipelineCtx | undefined;
let stateWriteWarned = false;
let heartbeatStop: (() => void) | null = null;

function armedCwds(): string[] {
  const out: string[] = [];
  for (const [cwd, st] of states) {
    if (st.phase) out.push(cwd);
  }
  return out;
}

/**
 * Une écriture impossible (disque plein, permissions) ne casse JAMAIS un tour :
 * l'erreur est avalée et signalée au plus une fois par session, par une notice
 * durable — un toast disparaîtrait au redraw.
 */
export function reportStateWriteFailure(deps: PublishDeps, error: unknown): void {
  if (stateWriteWarned) return;
  stateWriteWarned = true;
  const reason = error instanceof Error ? error.message : String(error);
  deps.notify?.(`[pipeline] état des pipelines non écrit : ${reason}`);
}

/** La session de ce contexte conduit-elle bien ce cwd ? Sinon le fichier est nul. */
function sessionMatches(ctx: PipelineCtx | undefined, cwd: string): boolean {
  const manager = ctx?.sessionManager;
  if (typeof manager?.getCwd !== "function") return false;
  try {
    // Appelée SUR le manager, jamais via une variable intermédiaire : `getCwd`
    // lit `this.#cwd`, et un receveur perdu lève un TypeError qu'on lirait à tort
    // comme « pas la bonne session » — donc comme une entrée sans fichier.
    return path.resolve(manager.getCwd() ?? "") === path.resolve(cwd);
  } catch {
    return false;
  }
}

function sessionFileOf(ctx: PipelineCtx | undefined): string | null {
  try {
    return asStringOrNull(ctx?.sessionManager?.getSessionFile?.());
  } catch {
    return null;
  }
}

function sessionIdOf(ctx: PipelineCtx | undefined): string | null {
  try {
    return asStringOrNull(ctx?.sessionManager?.getSessionId?.());
  } catch {
    return null;
  }
}

/**
 * État publié d'une pipeline : `waiting` si une question `ask` est en vol, si une
 * approbation est en attente, si l'agent est inactif, ou si la session courante
 * ne conduit pas ce cwd (cette pipeline n'est alors plus pilotée par personne) ;
 * `running` sinon.
 */
function currentRunState(ctx: PipelineCtx | undefined, cwd: string): PipelineRunState {
  if (pendingAsks.size > 0 || pendingApprovals.size > 0) return "waiting";
  if (ctx?.cwd && path.resolve(ctx.cwd) !== path.resolve(cwd)) return "waiting";
  try {
    if (ctx?.isIdle?.() === true) return "waiting";
  } catch {
    /* contexte sans isIdle : on suppose l'agent actif */
  }
  return "running";
}

/**
 * Publie (ou republie) l'entrée en cours d'un cwd ARMÉ : phase courante, horodatage
 * de l'étape, état, session. Aucun effet si ce cwd n'est pas armé par ce processus —
 * le propriétaire ne réécrit que SES entrées.
 */
export function publishRunning(deps: PublishDeps, cwd: string): void {
  const st = states.get(path.resolve(cwd));
  if (!st?.phase) return;
  const ctx = deps.ctx ?? liveCtx;
  const now = (deps.now ?? Date.now)();
  const previous = st.entry;
  const same = sessionMatches(ctx, cwd);
  const entry: RunningEntry = {
    id: runningIdFor(cwd),
    cwd: path.resolve(cwd),
    label: previous?.label ?? pipelineLabel(cwd),
    phase: st.phase,
    state: currentRunState(ctx, cwd),
    phaseStartedAt: st.phaseStartedAt ?? previous?.phaseStartedAt ?? now,
    updatedAt: now,
    // La session publiée n'est retenue que si le contexte appartient bien à ce
    // cwd : après un `newSession`, le contexte du handler décrit encore la
    // session PRÉCÉDENTE, et publier son fichier ferait rejoindre la mauvaise.
    sessionFile: same ? (sessionFileOf(ctx) ?? previous?.sessionFile ?? null) : (previous?.sessionFile ?? null),
    sessionId: same ? (sessionIdOf(ctx) ?? previous?.sessionId ?? null) : (previous?.sessionId ?? null),
    owner: { pid: process.pid },
  };
  st.entry = entry;
  try {
    writeRunningEntry(deps.stateDir ?? pipelineStateDir(), entry);
  } catch (err) {
    reportStateWriteFailure(deps, err);
  }
}

/** Republie l'entrée du cwd courant, s'il est armé : le chemin des six événements. */
export function publishCurrentCwd(deps: PublishDeps): void {
  // Une publication est un effet de bord : elle ne doit jamais faire échouer le
  // tour qui l'a déclenchée, quelle que soit la panne.
  try {
    const ctx = deps.ctx;
    if (!ctx?.cwd) return;
    liveCtx = ctx;
    publishRunning(deps, ctx.cwd);
  } catch (err) {
    reportStateWriteFailure(deps, err);
  }
}

/**
 * Un seul intervalle de battement par processus : réarmer REMPLACE le précédent.
 * Réarmé à chaque armement parce qu'un changement de session (newSession) nettoie
 * les minuteries gérées de la session quittée.
 */
export function ensureHeartbeat(ctx: PipelineCtx | undefined, deps: Omit<PublishDeps, "ctx"> = {}): void {
  if (typeof ctx?.setInterval !== "function") return;
  if (ctx) liveCtx = ctx;
  heartbeatStop?.();
  const timer = ctx.setInterval(() => {
    for (const cwd of armedCwds()) publishRunning({ ...deps, ctx: liveCtx }, cwd);
  }, PIPELINE_HEARTBEAT_MS);
  heartbeatStop = () => {
    try {
      ctx.clearTimer?.(timer);
    } catch {
      /* minuterie déjà nettoyée par la session : rien à faire */
    }
  };
}

/** Repart à zéro à chaque session : « signalée au plus une fois par session ». */
export function resetStateWriteWarning(): void {
  stateWriteWarned = false;
}

/**
 * Arme un maillon ET le publie : l'entrée apparaît dès la commande, avant toute
 * réponse du modèle (S-3). Remplace `armPhase` partout où un contexte est
 * disponible ; un nouveau maillon réinitialise le temps de l'étape.
 */
export function armPipeline(deps: PublishDeps, cwd: string | undefined, phase: PipelinePhase): void {
  if (!cwd) return;
  armPhase(cwd, phase);
  const st = stateOfCwd(cwd);
  st.phaseStartedAt = (deps.now ?? Date.now)();
  st.entry = undefined;
  resetStateWriteWarning();
  ensureHeartbeat(deps.ctx, { notify: deps.notify, stateDir: deps.stateDir });
  publishRunning(deps, cwd);
}

/**
 * Clôt une pipeline : l'historique est écrit PUIS le fichier en cours supprimé,
 * jamais l'inverse — une écriture impossible laisse l'entrée en cours, et l'appel
 * remonte l'erreur à son appelant (qui la signale au plus une fois).
 */
export function closePipeline(deps: PublishDeps, cwd: string, finalState: PipelineFinalState): void {
  const st = states.get(path.resolve(cwd));
  const now = (deps.now ?? Date.now)();
  const previous = st?.entry;
  // `endedAt` figé pour un échec (dernier battement), instant de clôture pour une
  // fin de cycle : deux lecteurs qui constatent la même mort écrivent le même id.
  const endedAt = finalState === "failed" ? (previous?.updatedAt ?? now) : now;
  const record: HistoryEntry = {
    id: historyIdFor(cwd, endedAt),
    cwd: path.resolve(cwd),
    label: previous?.label ?? pipelineLabel(cwd),
    phase: st?.phase ?? previous?.phase ?? "req",
    finalState,
    sessionFile: previous?.sessionFile ?? null,
    sessionId: previous?.sessionId ?? null,
    phaseStartedAt: st?.phaseStartedAt ?? previous?.phaseStartedAt ?? now,
    endedAt,
  };
  const stateDir = deps.stateDir ?? pipelineStateDir();
  writeHistoryEntry(stateDir, record);
  deleteRunningEntry(stateDir, runningIdFor(cwd));
  if (st) {
    st.phase = undefined;
    st.entry = undefined;
    st.phaseStartedAt = undefined;
  }
}

// ---------------------------------------------------------------------------
// Panneau des pipelines — un overlay ancré en haut à droite.
// ---------------------------------------------------------------------------
// C'est un `ctx.ui.custom` avec `overlay: true` et `anchor: "top-right"` — le seul
// point de montage d'un composant maison en TUI (cf. `## Documentation` §1).
// L'overlay prend le FOCUS : aucune touche n'atteint l'éditeur tant qu'il est
// ouvert, et `done` est le seul moyen de rendre le focus et le texte de l'éditeur.
//
// La mise en page est une fonction PURE de rangs `{text, tone}` (aucun état, aucun
// accès disque), construite hors du composant et testable avec des glyphes ASCII —
// même séparation que `renderRecallRows` du plugin mémoire. Le composant ne fait
// que colorier EN BLOC : un rang, une couleur, donc aucun calcul ANSI.
//
// Contrainte de plateforme : la souris n'existe pas pour un overlay non
// fullscreen (cf. `## Documentation` §1). Rien n'est câblé — et rien ne doit
// l'être : les séquences de clic ne sont même pas émises.

export type PanelTone = "border" | "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text";
export type PanelRow = { text: string; tone: PanelTone };

/** Glyphes injectés : `theme.boxRound` + `theme.nav.cursor` en production. */
export type PanelGlyphs = {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  teeLeft: string;
  teeRight: string;
  cursor: string;
};

export type PanelModel = {
  running: RunningEntry[];
  history: HistoryEntry[];
  /** Index sur la liste concaténée `[...running, ...history]`, borné, `-1` si vide. */
  selection: number;
  notice: string | null;
  unreadable: number;
};

export const PANEL_WIDTH = 64;
export const PANEL_REFRESH_MS = 1000;
export const PANEL_MIN_ROWS = 8;
export const PANEL_MAX_ROWS = 18;

/** Le panneau se borne lui-même : au-delà, le TUI couperait par le BAS (pied perdu). */
export function panelBudget(terminalRows: number): number {
  const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : 24;
  return Math.max(PANEL_MIN_ROWS, Math.min(Math.floor(rows * 0.8), PANEL_MAX_ROWS));
}

export function clampSelection(selection: number, count: number): number {
  if (count <= 0) return -1;
  if (!Number.isFinite(selection)) return 0;
  return Math.min(Math.max(Math.trunc(selection), 0), count - 1);
}

/** Déplacement borné, sans bouclage : on ne sort pas de la liste. */
export function moveSelection(selection: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  // `-1` = « rien de sélectionné » : se déplacer entre alors par le premier rang.
  const current = selection < 0 ? -1 : clampSelection(selection, count);
  return clampSelection(current + delta, count);
}

/**
 * Modèle du panneau : lecture du magasin, réconciliation des propriétaires morts,
 * puis borne de la sélection. C'est la seule fonction qui touche le disque.
 */
export function readPanelModel(input: {
  stateDir: string;
  selection?: number;
  notice?: string | null;
}): PanelModel {
  const snapshot = reconcileStore(input.stateDir);
  const count = snapshot.running.length + snapshot.history.length;
  return {
    running: snapshot.running,
    history: snapshot.history,
    selection: clampSelection(input.selection ?? 0, count),
    notice: input.notice ?? null,
    unreadable: snapshot.unreadable,
  };
}

function fit(text: string, width: number): string {
  if (text.length === width) return text;
  return text.length > width ? clip(text, width) : text + " ".repeat(width - text.length);
}

function clip(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length > n ? (n > 1 ? `${s.slice(0, n - 1)}…` : s.slice(0, n)) : s;
}

/** Rang encadré : `│ <contenu de largeur innerW> │`, exactement `width` colonnes. */
function frame(glyphs: PanelGlyphs, content: string, width: number, innerW: number): string {
  return fit(`${glyphs.vertical} ${fit(clip(content, innerW), innerW)} ${glyphs.vertical}`, width);
}

/** Rang de titre : le cadre s'ouvre après le texte, sans le traverser. */
function topRule(glyphs: PanelGlyphs, title: string, width: number): string {
  const head = `${glyphs.topLeft} ${clip(title, Math.max(0, width - 4))} `;
  const rest = Math.max(0, width - head.length - 1);
  return fit(head + glyphs.horizontal.repeat(rest) + glyphs.topRight, width);
}

/** Séparateur de sections — et frontière entre « en cours » et « historique ». */
function separatorRule(glyphs: PanelGlyphs, width: number): string {
  return fit(
    `${glyphs.teeLeft}${glyphs.horizontal.repeat(Math.max(0, width - 2))}${glyphs.teeRight}`,
    width,
  );
}

/** Dernier rang : le pied porte le texte ET ferme le cadre. */
function bottomRule(glyphs: PanelGlyphs, text: string, width: number): string {
  const head = `${glyphs.bottomLeft} ${clip(text, Math.max(0, width - 4))} `;
  const rest = Math.max(0, width - head.length - 1);
  return fit(head + glyphs.horizontal.repeat(rest) + glyphs.bottomRight, width);
}

/** `<label>` à gauche, `<droite>` aligné à droite, curseur en tête si sélectionné. */
function entryLine(label: string, right: string, selected: boolean, glyphs: PanelGlyphs, innerW: number): string {
  const prefix = selected ? `${glyphs.cursor} ` : " ".repeat(glyphs.cursor.length + 1);
  const room = Math.max(0, innerW - prefix.length);
  if (right.length + 1 >= room) return clip(prefix + label, innerW); // pas la place pour la droite
  const left = clip(label, room - right.length - 1);
  const gap = " ".repeat(Math.max(1, room - left.length - right.length));
  return prefix + left + gap + right;
}

/** Le rang de notice, unique, compose l'illisible et le message d'action. */
function noticeText(model: PanelModel): string | null {
  const parts: string[] = [];
  if (model.unreadable > 0) {
    parts.push(`${model.unreadable} fichier(s) d'état illisible(s) — entrée(s) ignorée(s)`);
  }
  if (model.notice) parts.push(model.notice);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Tous les rangs du panneau, DANS L'ORDRE : titre, section « en cours »,
 * séparateur, section « historique », notice (absente si aucune), deux rangs de
 * pied. Pur : le temps écoulé vient de `now`, jamais d'une horloge implicite, et
 * les glyphes du test sont de l'ASCII.
 *
 * Le panneau tient dans `budget` rangs : toutes les pipelines en cours d'abord
 * (priorité), puis autant d'entrées d'historique que la place le permet, la plus
 * récente d'abord, et un rang `… <n> de plus` par section tronquée.
 */
export function buildPanelRows(
  model: PanelModel,
  opts: { width: number; budget: number; glyphs: PanelGlyphs; now: number },
): PanelRow[] {
  const width = Math.max(1, Math.floor(opts.width));
  const glyphs = opts.glyphs;
  const innerW = Math.max(0, width - 4);
  const rows: PanelRow[] = [];

  rows.push({
    text: topRule(glyphs, `Pipelines · ${model.running.length} en cours`, width),
    tone: "accent",
  });

  const runningCount = model.running.length;
  const historyCount = model.history.length;
  const notice = noticeText(model);
  // Titre + séparateur + deux rangs de pied, plus la notice quand il y en a une.
  const available = Math.max(0, opts.budget - (4 + (notice ? 1 : 0)));

  let shownRunning = Math.min(runningCount, available);
  if (runningCount > available) shownRunning = Math.max(0, available - 1);
  const runningMarker = runningCount > shownRunning && available - shownRunning >= 1;
  const left = available - shownRunning - (runningMarker ? 1 : 0);
  let shownHistory = Math.min(historyCount, left);
  if (historyCount > left) shownHistory = Math.max(0, left - 1);
  const historyMarker = historyCount > shownHistory && left - shownHistory >= 1;

  if (runningCount === 0) {
    rows.push({ text: frame(glyphs, "aucune pipeline en cours", width, innerW), tone: "muted" });
  } else {
    for (let i = 0; i < shownRunning; i++) {
      const entry = model.running[i]!;
      const state = entry.state === "waiting" ? "attend" : "tourne";
      const right = `/${entry.phase} · ${state} · ${elapsedLabel(opts.now - entry.phaseStartedAt)}`;
      rows.push({
        text: frame(glyphs, entryLine(entry.label, right, model.selection === i, glyphs, innerW), width, innerW),
        tone: entry.state === "waiting" ? "warning" : "success",
      });
    }
    if (runningMarker) {
      rows.push({ text: frame(glyphs, `… ${runningCount - shownRunning} de plus`, width, innerW), tone: "dim" });
    }
  }

  rows.push({ text: separatorRule(glyphs, width), tone: "border" });

  if (historyCount === 0) {
    rows.push({ text: frame(glyphs, "aucun historique", width, innerW), tone: "muted" });
  } else {
    for (let i = 0; i < shownHistory; i++) {
      const entry = model.history[i]!;
      const final = entry.finalState === "done" ? "terminé" : "échoué";
      const right = `/${entry.phase} · ${final}`;
      const selected = model.selection === runningCount + i;
      rows.push({
        text: frame(glyphs, entryLine(entry.label, right, selected, glyphs, innerW), width, innerW),
        tone: entry.finalState === "done" ? "dim" : "error",
      });
    }
    if (historyMarker) {
      rows.push({ text: frame(glyphs, `… ${historyCount - shownHistory} de plus`, width, innerW), tone: "dim" });
    }
  }

  if (notice) rows.push({ text: frame(glyphs, notice, width, innerW), tone: "warning" });

  rows.push({ text: frame(glyphs, "↑↓ naviguer · Entrée rejoindre · d supprimer", width, innerW), tone: "dim" });
  rows.push({ text: bottomRule(glyphs, "Échap fermer", width), tone: "border" });

  return rows.map((row) => ({ text: fit(row.text, width), tone: row.tone }));
}

// --- rejoindre la session d'une entrée (S-5) --------------------------------

/** En-tête exploitable d'un fichier de session : ce qu'on en garde pour la bascule. */
export type SessionHeaderInfo = { cwd: string | null };

/**
 * Borne de lecture de l'en-tête : une session pèse des mégaoctets et le panneau
 * se rafraîchit à la seconde — on ne lit jamais le fichier entier, et la boucle de
 * rafraîchissement n'appelle même pas cette fonction.
 */
export const SESSION_HEADER_READ_BYTES = 8192;

/**
 * En-tête d'un fichier de session : la PREMIÈRE ligne dont l'objet JSON satisfait
 * le validateur d'OMP (`type === "session"` et `id` chaîne, cf. `## Documentation`
 * §3), dans les `maxBytes` premiers octets. Un fichier courant commence par un
 * créneau de titre — l'en-tête est donc en 2e ligne — un fichier hérité le porte
 * en 1re. Aucune exception ne sort d'ici : illisible, ligne tronquée par la borne
 * ou JSON mal formé ⇒ `null`.
 */
export function readSessionHeader(file: string, maxBytes = SESSION_HEADER_READ_BYTES): SessionHeaderInfo | null {
  let raw: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      raw = buf.subarray(0, fs.readSync(fd, buf, 0, maxBytes, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // ligne vide, tronquée par la borne, ou JSON mal formé
    }
    const rec = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    if (rec?.type !== "session" || typeof rec.id !== "string") continue;
    return { cwd: asStringOrNull(rec.cwd) };
  }
  return null;
}

/** Sondes disque de la décision — injectées, pour que `switchDecision` reste PURE. */
export type SessionProbe = {
  /** Le chemin existe ET est un fichier régulier. */
  isSessionFile: (file: string) => boolean;
  /** En-tête de session (1re entrée valide : `type === "session"` et `id` chaîne), ou null si absent/illisible. */
  sessionHeader: (file: string) => SessionHeaderInfo | null;
  /** Le répertoire existe et est un répertoire (`statSync` suit les liens symboliques). */
  isDirectory: (dir: string) => boolean;
};

/** Sonde disque réelle, synchrone et bornée : aucune exception ne sort d'ici. */
export const diskProbe: SessionProbe = {
  isSessionFile: (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
  sessionHeader: (file) => readSessionHeader(file),
  isDirectory: (dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
};

export type JoinDecision =
  | { kind: "switch"; path: string; cwd: string | null }
  | { kind: "unavailable"; message: string };

/**
 * Décision de bascule, PURE (toute lecture passe par `probe`). Les contrôles sont
 * OBLIGATOIRES : basculer vers un chemin absent ne réinitialise pas la session, il
 * en CRÉE une vide à ce chemin, et OMP accepte une cible dont le cwd enregistré a
 * disparu (cf. `## Documentation` §4 points 5-6) — soit exactement l'inverse de ce
 * qu'on veut en signalant une entrée non reprenable.
 */
export function switchDecision(entry: { sessionFile?: string | null }, probe: SessionProbe): JoinDecision {
  const file = asStringOrNull(entry.sessionFile);
  if (!file) return { kind: "unavailable", message: "session introuvable — entrée non reprenable" };
  if (!probe.isSessionFile(file)) {
    return { kind: "unavailable", message: `session introuvable — entrée non reprenable : ${file}` };
  }
  const header = probe.sessionHeader(file);
  if (!header) {
    // Un fichier de 0 octet est converti en session vide par OMP à la bascule :
    // même piège que le chemin absent, donc même refus (S-2, 3e ligne).
    return { kind: "unavailable", message: `session sans en-tête valide — entrée non reprenable : ${file}` };
  }
  if (header.cwd !== null && !probe.isDirectory(header.cwd)) {
    return {
      kind: "unavailable",
      message: `répertoire de travail de la session cible disparu — entrée non reprenable : ${header.cwd}`,
    };
  }
  return { kind: "switch", path: file, cwd: header.cwd };
}

/**
 * Le gestionnaire de session VIVANT (`ctx.sessionManager`) : méthodes optionnelles
 * parce que la façade publique d'OMP masque celles de relocalisation
 * (`## Documentation` §2) — un OMP qui ne les expose pas dégrade en bascule simple.
 */
export type NavSessionManager = {
  getCwd?: () => string;
  captureState?: () => unknown;
  setCwdWithoutRelocation?: (cwd: string) => void;
  adoptRecordedCwd?: () => void;
  restoreState?: (snapshot: unknown) => void;
};

/** Le strict nécessaire d'un contexte de COMMANDE pour basculer. */
export type SwitchCtx = {
  switchSession?: (sessionPath: string) => Promise<{ cancelled: boolean }>;
  sessionManager?: NavSessionManager;
};

export type JoinDeps = {
  /** Contexte de commande : `switchSession` y est disponible, commande comme raccourci. */
  ctx?: SwitchCtx;
  /** Sondes disque ; sonde réelle par défaut. */
  probe?: SessionProbe;
  /** Ferme le panneau — AVANT la bascule, aucun overlay orphelin au-dessus du transcript. */
  close: () => void;
  /** Notice affichée DANS le panneau (entrée non reprenable). */
  showNotice: (message: string) => void;
  /** Notice DURABLE dans le transcript (bascule refusée). */
  notify: (text: string) => void;
};

/**
 * Aménagement du cwd de la session COURANTE avant la bascule, ou `null` si inutile
 * ou impossible. Aucun fichier n'est déplacé, aucun en-tête réécrit
 * (`setCwdWithoutRelocation`, `## Documentation` §2) : c'est la seule façon de
 * passer la garde d'OMP, qui refuse une cible dont le cwd enregistré diffère du
 * cwd courant (`## Documentation` §1). Le cwd déjà bon ⇒ rien à faire (et un
 * `getCwd` absent n'empêche pas l'aménagement : il est idempotent).
 */
function relocateCwd(
  sm: NavSessionManager | undefined,
  cwd: string | null,
): { sm: NavSessionManager; snapshot: unknown } | null {
  if (cwd === null || !sm) return null;
  if (
    typeof sm.captureState !== "function" ||
    typeof sm.setCwdWithoutRelocation !== "function" ||
    typeof sm.restoreState !== "function"
  ) {
    return null;
  }
  try {
    const current = sm.getCwd?.();
    if (typeof current === "string" && path.resolve(current) === path.resolve(cwd)) return null;
  } catch {
    /* getCwd cassé : on aménage quand même, l'opération est idempotente */
  }
  let snapshot: unknown;
  try {
    snapshot = sm.captureState();
    sm.setCwdWithoutRelocation(cwd);
  } catch {
    // Mutation interrompue : on remet l'état d'avant plutôt que de basculer sur un
    // gestionnaire à moitié amendé (l'annulation est elle-même sans garantie).
    try {
      sm.restoreState(snapshot);
    } catch {
      /* rien de mieux à faire : la bascule simple reste possible */
    }
    return null;
  }
  return { sm, snapshot };
}

/**
 * Rejoint la session d'une entrée, dans cet ordre (S-1) : décision, notice DANS le
 * panneau si l'entrée n'est pas reprenable (S-2/S-3), fermeture du panneau,
 * aménagement du cwd, bascule, adoption du répertoire de session, restauration du
 * snapshot sur refus. Un refus (`{cancelled: true}`), une exception ou un contexte
 * dégradé devient une notice durable — jamais une exception qui remonte au tour.
 */
export async function joinEntry(entry: { sessionFile?: string | null }, deps: JoinDeps): Promise<void> {
  const decision = switchDecision(entry, deps.probe ?? diskProbe);
  if (decision.kind === "unavailable") {
    deps.showNotice(decision.message);
    return;
  }
  deps.close();

  const ctx = deps.ctx;
  if (!ctx || typeof ctx.switchSession !== "function") {
    deps.notify(`[pipeline] bascule refusée — la session cible n'a pas pu être ouverte : ${decision.path}`);
    return;
  }
  const switchSession = ctx.switchSession;
  const relocation = relocateCwd(ctx.sessionManager, decision.cwd);

  let refused = false;
  try {
    // `call(ctx)` : la méthode garde son receveur (le câblage d'OMP passe une
    // fermeture, mais un contexte réel peut exposer une méthode liée à `this`).
    const res = await switchSession.call(ctx, decision.path);
    refused = res?.cancelled === true;
  } catch {
    refused = true;
  }

  if (!refused) {
    if (relocation) {
      // Sans ça le magasin reste sur le bucket de la session QUITTÉE (il n'est
      // re-pointé que par l'adoption, `## Documentation` §2).
      try {
        relocation.sm.adoptRecordedCwd?.();
      } catch {
        /* la bascule elle-même a réussi : rien à signaler */
      }
    }
    return;
  }

  if (relocation) {
    try {
      relocation.sm.restoreState?.(relocation.snapshot);
    } catch {
      /* restauration impossible : la notice durable reste le seul effet utile */
    }
  }
  deps.notify(`[pipeline] bascule refusée — la session cible n'a pas pu être ouverte : ${decision.path}`);
}

// --- le composant et sa fabrique --------------------------------------------

/** Surface de la TUI réellement utilisée : structurelle, donc testable sans OMP. */
export type PanelTui = { terminal?: { rows?: number }; requestRender?: () => void };
export type PanelTheme = {
  fg(color: string, text: string): string;
  boxRound: Omit<PanelGlyphs, "cursor">;
  nav: { cursor: string };
};
export type PanelKeybindings = { matches?: (data: string, keybinding: string) => boolean };

export type PanelComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
  /** Relecture du magasin — c'est exactement ce que déclenche le rafraîchissement périodique. */
  refresh(): void;
  dispose(): void;
};

export type PipelinesPanelDeps = {
  stateDir: string;
  /** Horloge du temps écoulé : injectée, le temps affiché est donc testable. */
  now?: () => number;
  /** Ordonnanceur du rafraîchissement ; renvoie de quoi l'arrêter. */
  schedule?: (callback: () => void, ms: number) => () => void;
  /** Rejoint la session d'une entrée (rangs en cours ET historique). */
  join: (entry: RunningEntry | HistoryEntry, close: () => void, showNotice: (message: string) => void) => void;
};

/** `unref` — un rafraîchissement de panneau ne doit pas retenir le processus. */
function unrefTimer(timer: unknown): void {
  if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
}

/** Minuterie de rafraîchissement ; l'arrêt est rendu à l'appelant (`dispose`). */
function defaultSchedule(callback: () => void, ms: number): () => void {
  const timer = setInterval(callback, ms);
  unrefTimer(timer);
  return () => clearInterval(timer);
}

/**
 * Fabrique du composant, au contrat `Component` de la TUI : `render(width)` rend
 * des rangs ≤ `width`, `dispose` arrête la minuterie. Le premier rendu est déjà
 * peuplé (lecture synchrone bornée : il n'y a pas d'état « chargement »), et un
 * magasin vide n'empêche pas le panneau de s'afficher.
 */
export function pipelinesPanelFactory(deps: PipelinesPanelDeps) {
  return (
    tui: PanelTui,
    theme: PanelTheme,
    keybindings: PanelKeybindings,
    done: (result?: unknown) => void,
  ): PanelComponent => {
    const glyphs: PanelGlyphs = {
      topLeft: theme.boxRound.topLeft,
      topRight: theme.boxRound.topRight,
      bottomLeft: theme.boxRound.bottomLeft,
      bottomRight: theme.boxRound.bottomRight,
      horizontal: theme.boxRound.horizontal,
      vertical: theme.boxRound.vertical,
      teeLeft: theme.boxRound.teeLeft,
      teeRight: theme.boxRound.teeRight,
      cursor: theme.nav.cursor,
    };
    const now = deps.now ?? (() => Date.now());
    const schedule = deps.schedule ?? defaultSchedule;
    let notice: string | null = null;
    let model = readPanelModel({ stateDir: deps.stateDir, selection: 0, notice });

    const paint = () => {
      model = readPanelModel({ stateDir: deps.stateDir, selection: model.selection, notice });
    };
    const redraw = () => {
      paint();
      tui.requestRender?.();
    };
    const showNotice = (message: string) => {
      notice = message;
      paint();
      tui.requestRender?.();
    };
    const entries = (): Array<RunningEntry | HistoryEntry> => [...model.running, ...model.history];
    // Le déplacement efface la notice : elle décrit un rang, pas le panneau.
    const move = (delta: number) => {
      notice = null;
      model = { ...model, notice: null, selection: moveSelection(model.selection, entries().length, delta) };
      tui.requestRender?.();
    };
    const selected = (): RunningEntry | HistoryEntry | undefined => entries()[model.selection];

    const remove = () => {
      const index = model.selection;
      if (index < 0) return; // aucune entrée : rien, aucune notice
      if (index < model.running.length) {
        showNotice("seules les entrées d'historique se suppriment");
        return;
      }
      const entry = model.history[index - model.running.length];
      if (!entry) return;
      try {
        deleteHistoryEntry(deps.stateDir, entry.id);
      } catch (err) {
        showNotice(`suppression impossible : ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      notice = null;
      redraw();
    };

    const stop = schedule(() => redraw(), PANEL_REFRESH_MS);

    return {
      render(width: number): string[] {
        const budget = panelBudget(tui.terminal?.rows ?? 24);
        return buildPanelRows(model, { width, budget, glyphs, now: now() }).map((row) =>
          theme.fg(row.tone, row.text),
        );
      },
      handleInput(data: string): void {
        const matches = (keybinding: string) => keybindings?.matches?.(data, keybinding) === true;
        // Fermer : Échap (`app.interrupt`) ou Ctrl+C, les deux du select.cancel d'OMP.
        if (matches("tui.select.cancel")) {
          done();
          return;
        }
        if (matches("tui.select.up") || data === "k") {
          move(-1);
          return;
        }
        if (matches("tui.select.down") || data === "j") {
          move(1);
          return;
        }
        if (data === "d") {
          remove();
          return;
        }
        if (matches("tui.select.confirm")) {
          const entry = selected();
          if (entry) deps.join(entry, () => done(), showNotice);
        }
      },
      refresh: redraw,
      dispose(): void {
        stop();
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Fin de maillon — la suite du pipeline est ANNONCÉE dans le transcript.
// ---------------------------------------------------------------------------
// Chaque maillon (/req, /specs, /impl, /review) se termine par une retombée
// TERMINALE du fil principal (session_stop, cf. `## Documentation` §1a) : c'est le
// seul instant où « la phase est finie » est vrai. L'extension y poste la
// commande EXACTE de la suite — l'utilisateur n'a plus à se souvenir de l'ordre du
// pipeline, ni à relire le contrat pour savoir si /review a laissé des bloquants.
//
// Message d'AFFICHAGE (pi.sendMessage, triggerTurn:false), jamais un toast : un
// notify disparaît au redraw et ne serait relisible nulle part (le critère exige
// la relecture après coup).
//
// Ces prédicats sont PURS — aucun accès disque, aucun état : le handler
// `session_stop` lit le contrat lui-même et leur en passe le contenu.

export type PipelinePhase = "req" | "specs" | "impl" | "review";
export type NextStep = { kind: "command"; command: string } | { kind: "cycle-end" };

// Ligne normalisée des règles de lecture du verdict : /review écrit en Markdown,
// donc les marques de mise en forme (gras, italique, code, dièses) sautent, puis
// la puce et les espaces de bord. Sans ça, `- **BLOQUANTS** : aucun` serait
// illisible et le cycle repartirait en /review.
function normalizeLine(line: string): string {
  return line
    .replace(/[*_`#]/g, "")
    .replace(/^[\s\-+•]+/, "")
    .replace(/\s+$/, "");
}

/** Le contrat porte-t-il la section `## <titre>` ? (`titre` sans les dièses) */
export function contractHasSection(contract: string, title: string): boolean {
  return contract.split("\n").some((line) => line.trim() === `## ${title}`);
}

/** Corps d'une section `## <titre>` : de son titre à la prochaine section `## `. */
export function contractSection(contract: string, title: string): string | null {
  const lines = contract.split("\n");
  const head = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (head === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(head + 1)) {
    if (line.trimStart().startsWith("## ")) break;
    body.push(line);
  }
  return body.join("\n");
}

// Libellés du verdict de /review (REVIEW_DIRECTIVE), dans l'ordre où ils sont
// écrits : ils bornent le corps du champ BLOQUANTS — le champ suivant n'est pas un
// bloquant, et une recommandation n'en est jamais un.
const REVIEW_LABELS = ["STATUT", "AC PAR AC", "SPEC PAR SPEC", "BLOQUANTS", "RECOMMANDATIONS", "DÉCISION FINALE"];

function isReviewLabel(line: string): boolean {
  const n = normalizeLine(line).toUpperCase();
  return REVIEW_LABELS.some((label) => n.startsWith(label));
}

// « Aucun bloquant » s'écrit de plusieurs façons selon la plume de l'agent : les
// reconnaître toutes évite de renvoyer l'utilisateur en /impl --fix pour rien.
const VACUOUS: Record<string, true> = {
  aucun: true,
  aucune: true,
  néant: true,
  "n/a": true,
  none: true,
  "0": true,
  "-": true,
  "—": true,
  "–": true,
  "(aucun)": true,
};

function isVacuous(line: string): boolean {
  const n = normalizeLine(line).replace(/[.!]$/, "").trim();
  return n === "" || VACUOUS[n.toLowerCase()] === true;
}

/**
 * Verdict du maillon /review, lu dans `## Revue`. `"unreadable"` couvre les deux
 * cas où il n'y a rien à lire (section absente, champ `BLOQUANTS` absent) : dans
 * le doute on renvoie vers /review, jamais vers /impl --fix (corriger ce qui n'a
 * pas été identifié) ni vers une fausse fin de cycle.
 */
export function reviewVerdict(contract: string): "blockers" | "clean" | "unreadable" {
  const section = contractSection(contract, "Revue");
  if (section === null) return "unreadable";
  const lines = section.split("\n");
  const at = lines.findIndex((line) => /^BLOQUANTS\s*(?::|：|$)/i.test(normalizeLine(line)));
  if (at === -1) return "unreadable";
  const head = normalizeLine(lines[at]!);
  const sep = /^BLOQUANTS\s*(?::|：)?/i.exec(head)!;
  const body = [head.slice(sep[0].length)];
  for (const line of lines.slice(at + 1)) {
    if (line.trimStart().startsWith("## ") || isReviewLabel(line)) break;
    body.push(line);
  }
  return body.every(isVacuous) ? "clean" : "blockers";
}

/**
 * Suite d'un maillon terminé. Pure : aucun accès disque, aucun état. Un maillon
 * dont le contrat ne porte pas `## Spécifications` renvoie vers /specs : il n'y a
 * rien à implémenter ni à réviser, et proposer /review enverrait l'utilisateur
 * vers la revue d'un travail qui n'a pas eu lieu.
 */
export function nextStepFor(phase: PipelinePhase, contract: string): NextStep {
  const hasSpecs = contractHasSection(contract, "Spécifications");
  switch (phase) {
    case "req":
      return { kind: "command", command: "/specs" };
    case "specs":
      return hasSpecs ? { kind: "command", command: "/impl" } : { kind: "command", command: "/specs" };
    case "impl":
      return hasSpecs ? { kind: "command", command: "/review" } : { kind: "command", command: "/specs" };
    case "review": {
      const verdict = reviewVerdict(contract);
      if (verdict === "blockers") return { kind: "command", command: "/impl --fix" };
      if (verdict === "clean") return { kind: "cycle-end" };
      return { kind: "command", command: "/review" };
    }
  }
}

/**
 * Message d'affichage annonçant la suite. Aucune notice du plugin ne doit
 * contenir « fin » comme mot isolé : elles retraversent before_agent_start, où un
 * « fin » clôturerait la collecte (cf. isPipelineNotice).
 */
export function buildNextStepNotice(phase: PipelinePhase, step: NextStep): string {
  if (step.kind === "cycle-end") {
    return (
      "[pipeline] Phase /review terminée — cycle terminé : aucun BLOQUANT consigné dans " +
      "## Revue, rien à corriger."
    );
  }
  return `[pipeline] Phase /${phase} terminée — commande suivante : ${step.command}`;
}

/** Le strict nécessaire de `ctx.ui` : l'éditeur, qui n'existe qu'en mode interactif. */
type EditorUI = {
  getEditorText?: () => string;
  setEditorText?: (text: string) => void;
};

/**
 * Préremplit la zone de saisie avec la commande de la suite. Les quatre
 * conditions sont nécessaires : hors TUI les méthodes sont des no-op (et la
 * commande n'aurait nulle part où s'afficher), et un brouillon déjà saisi est du
 * travail de l'utilisateur — jamais écrasé. Échec = éditeur inchangé, en silence :
 * l'annonce dans le transcript porte déjà l'information.
 */
function prefillEditor(ctx: { hasUI: boolean; ui?: EditorUI }, step: NextStep): void {
  if (step.kind !== "command") return; // fin de cycle : rien à valider
  if (!ctx.hasUI) return;
  const ui = ctx.ui;
  if (typeof ui?.getEditorText !== "function" || typeof ui.setEditorText !== "function") return;
  let current = "";
  try {
    current = ui.getEditorText();
  } catch {
    return;
  }
  if (typeof current !== "string" || current.trim() !== "") return;
  ui.setEditorText(step.command);
}

// ---------------------------------------------------------------------------
// /req — directive injectée en mode collecte. Clarifie l'INTENTION seulement :
// besoins ET critères d'acceptation (un critère est comportemental, donc de
// l'intention — l'utilisateur arbitre les deux). Questionne par enjeu, pas par
// réflexe ; fige le tout dans le contrat à la clôture.
// ---------------------------------------------------------------------------

const SYSTEM_DIRECTIVE_REQ = `Mode collecte de besoins ACTIF.
Tu es un collecteur de besoins. Ton unique rôle : cerner EXACTEMENT ce que l'utilisateur veut obtenir, ET à quoi on reconnaîtra qu'il l'a obtenu. Tu clarifies l'INTENTION, pas la technique.

Frontière stricte :
- CE QUI T'APPARTIENT (seul l'utilisateur peut le trancher) : le résultat attendu, le périmètre (ce qui reste explicitement hors scope), la priorité/criticité, toute contrainte non négociable (délai, compatibilité, sécurité) qui changerait la solution, ET les critères d'acceptation — le comportement OBSERVABLE qui prouvera que le besoin est satisfait. Un critère est comportemental, donc de l'intention : l'utilisateur peut l'arbitrer, et c'est lui qui le valide.
- CE QUI NE T'APPARTIENT PAS : les choix techniques déductibles du dépôt (quelle lib, quel fichier, quel pattern, quelle convention). Tu ne lis pas le code et tu ne le devines pas. Ces ambiguïtés-là seront levées par /specs, qui lit le dépôt. NE les pose PAS ici.

Règles :

1. QUESTIONNE PAR ENJEU, pas par réflexe. Ne pose une question que si une hypothèse fausse changerait l'implémentation OU le test d'acceptation. Un besoin déjà explicite ne se questionne pas. N'inflige pas une check-list mécanique (objet / périmètre / contraintes / cas limites / priorité / dépendances) à un besoin trivial : tu fabriquerais de fausses contraintes.

2. Chaque question = un \`ask\` avec 2 à 4 options TRANCHÉES, PLUS une option d'échappement « peu importe / suis les conventions du dépôt ». L'utilisateur ne doit jamais être forcé d'inventer une réponse sur un point qui lui est égal — une réponse forcée est une fausse décision qui devient une fausse spec.

3. Ne propose ni solution ni action tant qu'un besoin n'est pas clair sur ce qui compte (résultat, périmètre, criticité). Traite un besoin à la fois.

4. FAIS ÉMERGER LES CRITÈRES D'ACCEPTATION. Pour chaque besoin, fais dire ce qui, OBSERVÉ, prouve qu'il est satisfait : une condition binaire pass/fail au format Given/When/Then (contexte → action → résultat observable). Un critère n'existe que si un bug plausible le ferait échouer : pas de cérémonie sur un besoin trivial (« Given un user, When il clique, Then ça clique » n'en est pas un). Ne fabrique pas de critère technique (chiffres de perf, format interne, choix de lib) — sauf si l'utilisateur l'a EXIGÉ comme contrainte, auquel cas c'est une contrainte du besoin.

5. Quand tu penses avoir levé les flous à enjeu de TOUS les besoins, envoie un \`ask\` de contrôle :
   - « Tout est bon, c'est complet. » → clôture.
   - « Il reste des choses à ajouter. » → continue la collecte.
   - « Un besoin a changé. » → reclarifie-le.

6. GARDE-FOU DE CLÔTURE. Ne clôture pas tant que l'utilisateur n'a pas dit explicitement que c'est complet (ou tapé « fin »), ET que chaque besoin n'a pas AU MOINS un critère d'acceptation falsifiable et observable. Un besoin sans critère est un besoin non compris : redemande-le avant de clôturer. C'est là que doit passer l'essentiel de ton temps.

7. CLÔTURE — quand c'est validé : reformule chaque besoin en une phrase d'action autoportante et non ambiguë au format
   \`B-<n> : [verbe précis] [objet précis] [contraintes validées].\`
   puis chaque critère au format
   \`AC-<n> (B-<m>) : Given … When … Then …\`
   et ÉCRIS-les (outil write) dans ${CONTRACT_PATH}, sous DEUX titres à la suite : \`## Besoins\` (un \`B-<n>\` numéroté par ligne) puis \`## Critères d'acceptation\` (un \`AC-<n>\` par ligne, chacun référençant le besoin qu'il prouve). Crée le fichier et son dossier si besoin ; remplace des sections \`## Besoins\` / \`## Critères d'acceptation\` existantes, ne touche pas au reste. Ce fichier est le contrat que /specs puis /impl reliront : il fait foi. Présente ensuite le récap numéroté (besoins ET critères) pour validation. Si l'utilisateur corrige, RÉÉCRIS le fichier pour qu'il reflète toujours l'état validé.

8. N'écris PAS les besoins ni les critères en mémoire mem0 : ce sont des artefacts transitoires de cette feature, ils vivent dans le contrat, pas dans la mémoire durable.`;

// « fin » comme MOT ISOLÉ (Unicode-aware), jamais la sous-chaîne : « définir »,
// « enfin », « affiner », « finir » ne clôturent pas. Une lettre adjacente
// (avant ou après) invalide le match.
export function saysFin(prompt: string): boolean {
  return /(^|[^\p{L}])fin([^\p{L}]|$)/iu.test(prompt);
}

// Les notices du plugin ([req] … et [pipeline] …) retraversent before_agent_start
// comme n'importe quel message. Elles ne sont PAS des entrées utilisateur : les
// passer au détecteur de « fin » clôturerait la collecte sur le mot « fin » du
// message d'accueil, et le préfixe `[pipeline]` d'une notice de fin de maillon
// n'immunise pas son contenu — une notice qui cite un chemin contenant « fin »
// (ex. /x/fin-de-feature) contient un « fin » isolé. Le préfixe est la seule
// marque fiable : l'utilisateur n'écrit ni « [req] » ni « [pipeline] ».
export function isPipelineNotice(prompt: string): boolean {
  const p = prompt.trimStart();
  return p.startsWith("[req]") || p.startsWith("[pipeline]");
}

/**
 * Message de clôture, envoyé quand l'utilisateur dit « fin ». Il fige : l'agent
 * reformule chaque besoin (B-<n>) et chaque critère d'acceptation (AC-<n>), et
 * les écrit dans le contrat. C'est après validation que le fichier est (ré)écrit,
 * donc les corrections de l'utilisateur y sont capturées — pas de récap
 * pré-validation perdu.
 */
export function buildReqHandoff(): string {
  return (
    "[req] Collecte terminée. Fige maintenant le contrat :\n" +
    "1. reformule chaque besoin clarifié en une phrase d'action autoportante, " +
    "numérotée (B-<n> : verbe précis + objet précis + contraintes validées) ;\n" +
    "2. reformule chaque critère d'acceptation validé au format " +
    "AC-<n> (B-<m>) : Given … When … Then … — une condition binaire pass/fail, chaque " +
    "besoin devant en avoir AU MOINS un ;\n" +
    `3. écris-les (write) dans ${CONTRACT_PATH}, sous deux titres à la suite : \`## Besoins\` ` +
    "(B-<n> numérotés) puis `## Critères d'acceptation` (AC-<n> numérotés, chacun référençant " +
    "le besoin qu'il prouve) — crée le fichier et son dossier si besoin, remplace des sections " +
    "existantes sans toucher au reste ;\n" +
    "4. présente-moi le récap numéroté (besoins ET critères) pour validation. Si je corrige, " +
    "réécris le fichier pour qu'il reflète l'état validé.\n\n" +
    `Ne mets pas les besoins ni les critères en mémoire mem0 : ce contrat (${CONTRACT_PATH}) ` +
    "est leur seul support. Quand besoins et critères sont figés, lance /specs — une session de " +
    "spécification lira ce contrat et produira des specs non ambiguës, tracées vers les " +
    "critères, prêtes à implémenter d'un trait."
  );
}

// ---------------------------------------------------------------------------
// /specs — fige les ambiguïtés techniques contre le dépôt réel, écrit les specs
// (tracées vers les critères d'acceptation) puis les LOTS : les briefs typés qui
// portent le « comment » (ui / archi / aucun) que la spec laisse dehors. Besoins
// et critères viennent du contrat (écrit par /req), pas d'un état local ni de mem0.
// ---------------------------------------------------------------------------

// Rubric des lots. Un lot = un brief : ce que la SPEC ne dit pas (elle décrit le
// comportement observable), le brief le dit (conventions de domaine, surfaces,
// états). Le type conditionne ce que le brief doit couvrir — ui et archi sont les
// deux domaines qui portent du savoir-faire non déductible d'une spec ; « aucun »
// quand le lot n'en mobilise aucun (échappatoire : on n'invente pas un brief).
const BRIEF_RUBRICS = `Ce qu'un LOT (BR-<n>) doit porter — il porte le « comment », que la spec laisse dehors :
- IDENTIFIANT ET TYPE : \`BR-<n> — type: ui | archi | aucun\`. Choisis le type d'après ce que le lot construit réellement ; \`aucun\` si aucune convention de domaine n'est en jeu (le brief reste alors court : surfaces + étapes).
- CRITÈRES SERVIS : les AC-<n> que ce lot fait passer. Aucun lot orphelin (sans AC), aucun AC non servi par au moins un lot.
- SURFACES RÉELLES : fichiers, modules et symboles du dépôt touchés, avec leur chemin — rien d'inventé.
- CONVENTIONS DU DÉPÔT À SUIVRE : le pattern existant à réutiliser, nommé avec sa référence de fichier ; on ne crée pas une convention à côté d'une existante.
- DOC EXTERNE UTILE : renvoi aux entrées pertinentes de \`## Documentation\` (pas de re-cherche).
- ÉTAPES ORDONNÉES : découpe implémentable et vérifiable, sans dépendance arrière.

Si type = ui :
- ÉCRANS / COMPOSANTS : chacun nommé, avec son rôle.
- CHAQUE ÉTAT : vide, chargement, erreur, succès (et dégradé si pertinent) — un état non traité est un bug, pas un détail.
- INTERACTIONS souris ET clavier : focus, navigation, retour visuel.
- MESSAGES À L'UTILISATEUR : formulation exacte des erreurs et des confirmations.
- RÉUTILISATION du design system, des tokens et des composants existants (les nommer) ; responsive et accessibilité (contraste, libellés, ordre de tabulation) si le dépôt les traite déjà.

Si type = archi :
- MODÈLE DE DONNÉES : entités, champs, types, contraintes, invariants ; schéma et migration (réversible) si persistance.
- CONTRATS D'API : route/méthode, payload, réponses, codes d'erreur, authentification.
- TRANSACTIONS ET INTÉGRITÉ : ce qui doit être atomique, comportement en échec partiel.
- PERFORMANCE : index, requêtes, bornes — seulement si un AC l'exige ou si le dépôt s'en soucie déjà.
- CONFIG / ENV / SECRETS, et compatibilité ascendante (migration des données existantes).`;

const SPECS_DIRECTIVE = `Tu es un rédacteur de spécifications. Ton livrable : des specs qu'un agent d'implémentation exécute d'un seul passage, sans avoir à te reposer une question, PLUS les lots (briefs) qui disent comment les construire. L'ambiguïté est l'ennemi : une spec qui laisse un choix ouvert n'est pas finie.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read), sections \`## Besoins\` (B-<n>) et \`## Critères d'acceptation\` (AC-<n>). C'est l'intention validée par l'utilisateur : elle fait foi. Si le contrat est absent, sans besoins ou sans critères, ils n'ont pas été figés — renvoie vers /req (dire « fin »). Ne les réinvente pas et ne re-questionne pas l'intention.
2. Ancre-toi dans le RÉEL : lis le dépôt et la mémoire projet (mem0_search) — conventions existantes, patterns à réutiliser, chemins et symboles réels. On ne spécifie pas une convention neuve à côté d'une convention existante.
3. DOCUMENTE-toi pour la future implémentation. C'est À CETTE ÉTAPE, et pas à /impl, qu'on rassemble la documentation externe : APIs, bibliothèques, frameworks, formats, protocoles que les specs vont mobiliser. Cherche les sources qui font autorité (web_search puis read de la doc officielle) et retiens les faits précis dont /impl aura besoin : versions exactes, signatures, options, contraintes, pièges connus. CONSIGNE-les dans le contrat ${CONTRACT_PATH} sous un titre \`## Documentation\` — pour chaque source : le composant concerné, la version, l'URL, et les extraits/faits réutilisables (jamais un lien nu). /impl s'appuiera sur cette section sans re-chercher. Si aucune doc externe n'est nécessaire, écris-le explicitement dans cette section.
4. Lève les ambiguïtés TECHNIQUES restantes contre le dépôt. L'intention métier est déjà figée dans le contrat : NE la re-questionne pas. Ne pose un \`ask\` (2-4 options tranchées) que pour un choix technique que le dépôt ne tranche pas à lui seul. Zéro « à décider », zéro TODO, zéro « devrait raisonnablement ».
5. Rédige les specs selon le rubric ci-dessous : chacune référence le ou les AC-<n> qu'elle fait passer, et par eux les B-<n>.
6. Découpe en LOTS et écris leurs briefs selon le rubric des lots ci-dessous. C'est la couche qui dit COMMENT construire (conventions ui / archi), là où la spec dit seulement ce qui doit être observable.
7. Une fois l'ensemble cohérent, ÉCRIS (write) dans le contrat ${CONTRACT_PATH} les sections \`## Spécifications\` puis \`## Lots\`, à la suite de \`## Documentation\`, sans supprimer les besoins, les critères ni la documentation. Ce contrat est ce que /impl relira. N'écris PAS les specs en mémoire mem0 : ce sont des artefacts transitoires de la feature. Présente ensuite l'ensemble numéroté (specs ET lots) pour validation et indique que /impl peut être lancé.

Ce qu'est une BONNE spec (rubric — chaque spec les respecte toutes) :
- TRAÇABLE : référence le(s) AC-<n> du contrat qu'elle fait passer (et par eux les besoins). Aucun AC non couvert, aucune spec orpheline.
- COMPORTEMENT OBSERVABLE, pas implémentation : entrées → sorties, effets de bord. Le comment est laissé à l'implémentation — et au lot.
- CRITÈRES D'ACCEPTATION VÉRIFIABLES : conditions binaires pass/fail, Given/When/Then — repris des AC-<n> du contrat, jamais réinventés ici.
- CONTRATS EXPLICITES : signatures/schemas d'API, formes de données, types nommés, codes d'erreur, invariants.
- CAS LIMITES ET ERREURS : entrée invalide, vide, concurrence, dépassement de borne, échec de dépendance — chacun avec le comportement attendu.
- PÉRIMÈTRE BORNÉ : liste explicitement les NON-objectifs, ce qui reste hors scope.
- POINTS D'INTÉGRATION : fichiers/modules/symboles touchés, dépendances, migrations, config/env, compatibilité ascendante.
- NON-FONCTIONNEL SI PERTINENT SEULEMENT : perf, sécurité, budgets — ne sur-spécifie pas.
- PLAN D'IMPLÉMENTATION ORDONNÉ : la découpe ordonnée vit dans le lot (\`## Lots\`) qui implémente la spec, pas dans la spec elle-même.

Une spec qui ne permet pas d'écrire le test d'acceptation avant le code n'est pas assez précise : reprends-la.`;

/**
 * Amorce de la session de spécification. Fonction pure. Besoins ET critères d'acceptation
 * ne sont PAS portés ici : ils vivent dans le contrat (écrit par /req). `extra` = contexte
 * ajouté sur la ligne de commande.
 */
export function buildSpecsSeed(extra: string): string {
  const added = extra.trim();
  return (
    "[specs] Session de spécification. Objectif : transformer l'intention figée dans le contrat " +
    `${CONTRACT_PATH} — besoins ET critères d'acceptation — en spécifications SANS AMBIGUÏTÉ et en ` +
    "lots (briefs) exécutables en un seul passage d'implémentation.\n\n" +
    (added ? `Contexte ajouté : ${added}\n\n` : "") +
    SPECS_DIRECTIVE +
    "\n\n" +
    BRIEF_RUBRICS
  );
}

// ---------------------------------------------------------------------------
// /impl — implémente d'un trait les specs ET les lots figés dans le contrat, et
// prouve chaque critère d'acceptation par un test qui porte son id (AC-<n>),
// retrouvable par grep à /review. Ne redéfinit rien : contrat sans specs → arrêt,
// renvoi vers /specs.
// ---------------------------------------------------------------------------

const IMPL_DIRECTIVE = `Tu es un agent d'implémentation. Ton contrat : implémenter d'un seul passage les spécifications figées dans le contrat de feature, sans les redéfinir ni improviser.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read). S'il est absent ou sans section \`## Spécifications\`, ARRÊTE-toi et dis-le : l'implémentation one-shot repose sur des specs figées — lance /specs d'abord. N'invente pas de spec.
2. Lis le dépôt aux points d'intégration nommés par les specs ET par les lots (\`## Lots\`). Réutilise les conventions et patterns existants ; ne crée pas une convention à côté d'une existante. Lis aussi la section \`## Documentation\` du contrat si elle existe : /specs y a rassemblé la doc externe (APIs, bibliothèques, versions, pièges) — appuie-toi dessus, ne re-cherche pas ce qui y est déjà consigné.
3. Implémente CHAQUE spec en suivant le lot qui la porte et son plan d'implémentation ordonné, en une passe complète : aucun stub, aucun TODO, aucun placeholder, pas de « v1/foundation ». Suis le brief de chaque lot pour le « comment » (type ui : chaque état d'écran, interactions, messages ; type archi : modèle, contrats d'API, transactions).
4. Prouve chaque CRITÈRE D'ACCEPTATION (AC-<n>, Given/When/Then) par un test qui PORTE L'ID : écris ou lance le test / smoke test correspondant, et mets \`AC-<n>\` dans son nom ou sa description (\`test("AC-3 : …")\`). C'est ainsi que /review le retrouvera par grep — une preuve qu'on ne peut pas relier à un AC n'est pas une preuve. Un AC n'est « fait » que quand son test passe ; si un besoin n'a aucun critère, signale-le plutôt que de le déclarer couvert.
5. Respecte le périmètre borné : n'implémente pas les non-objectifs listés par les specs.
6. Si une spec est ambiguë ou contredite par l'état réel du dépôt, NE devine pas : signale-le et corrige la spec DANS LE CONTRAT (édite ${CONTRACT_PATH}) plutôt que d'implémenter à côté.
7. À la fin : récapitule AC par AC (id, test, prouvé ou non), et enregistre en mémoire mem0 (mem0_add) UNIQUEMENT les décisions et pièges DURABLES rencontrés — pas les specs elles-mêmes, qui restent dans le contrat.

Le livrable n'est pas « du code qui compile » mais « chaque critère d'acceptation vérifié par un test traçable ».`;

const IMPL_FIX_DIRECTIVE = `Tu es un agent d'implémentation en mode CORRECTION. Une revue a bloqué l'implémentation ; ton contrat : lever les points bloquants qu'elle a consignés, sans élargir le périmètre.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read) : sections \`## Critères d'acceptation\` (les AC-<n> à re-prouver), \`## Spécifications\` (le contrat à respecter) et \`## Revue\` (le verdict de la dernière revue). Si \`## Revue\` est absente ou ne liste aucun BLOQUANT, ARRÊTE-toi et dis-le : il n'y a rien à corriger — lance /review d'abord.
2. Traite CHAQUE point BLOQUANT de la revue, un par un. Ne touche qu'au code nécessaire pour le lever ; n'ajoute aucune fonctionnalité hors specs (pas de scope creep).
3. Pour chaque bloquant levé, re-prouve le(s) CRITÈRE(S) D'ACCEPTATION concerné(s) (AC-<n>, Given/When/Then) : lance ou écris le test / smoke test correspondant, en portant \`AC-<n>\` dans son nom ou sa description — c'est ainsi que /review le retrouve par grep.
4. Si un bloquant révèle une spec fausse ou contredite par le dépôt, NE devine pas : corrige la spec DANS LE CONTRAT (édite \`## Spécifications\`) et signale-le.
5. À la fin : mets à jour la section \`## Revue\` du contrat (marque les bloquants levés), récapitule bloquant par bloquant (levé + preuve), et enregistre en mémoire mem0 (mem0_add) UNIQUEMENT les décisions et pièges DURABLES.

Le livrable : chaque BLOQUANT de la revue est levé et re-prouvé. Relance /review pour reconfirmer.`;

/**
 * Amorce de la session d'implémentation. Fonction pure. Les specs vivent dans le
 * contrat : la directive dit à l'agent de le lire. `focus` restreint le périmètre.
 * `fix` (drapeau --fix) bascule en mode correction : lever les BLOQUANTS que
 * /review a consignés dans le contrat, au lieu d'implémenter de zéro.
 */
export function buildImplSeed(focus: string, fix = false): string {
  const f = focus.trim();
  const header = fix
    ? "[impl --fix] Session de correction. Objectif : lever les points bloquants de la dernière " +
      `revue consignée dans le contrat ${CONTRACT_PATH}, sans élargir le périmètre.\n\n`
    : "[impl] Session d'implémentation. Objectif : implémenter d'un seul trait les spécifications " +
      `figées dans le contrat ${CONTRACT_PATH}, sans les redéfinir.\n\n`;
  return header + (f ? `Périmètre : ${f}\n\n` : "") + (fix ? IMPL_FIX_DIRECTIVE : IMPL_DIRECTIVE);
}

// ---------------------------------------------------------------------------
// /review — révise le git diff contre le contrat, CRITÈRE PAR CRITÈRE : chaque
// AC-<n> est retrouvé par grep dans la suite de tests, lu et lancé. Le diff est la
// source de vérité de CE QUI a changé (/impl ne commit pas) ; le contrat porte
// besoins, critères, specs et lots à confronter.
// ---------------------------------------------------------------------------

const REVIEW_DIRECTIVE = `Tu es un agent de revue. Ton contrat : vérifier qu'une implémentation correspond aux spécifications figées, que CHAQUE critère d'acceptation est prouvé par un test traçable, et que l'ensemble couvre les besoins originaux.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read) : sections \`## Besoins\` (B-<n>), \`## Critères d'acceptation\` (AC-<n>), \`## Spécifications\` (S-<n>) et \`## Lots\` (BR-<n>). S'il est absent ou sans specs, indique-le clairement — la revue ne peut pas se faire sans specs.
2. Constitue le PÉRIMÈTRE réel à réviser via git, ne le devine pas : \`git status\` puis \`git diff\` (les modifications non commitées laissées par la session /impl vivent dans l'arbre de travail). Si l'arbre est propre, \`git diff\` contre le dernier commit ou tag de release. La revue porte sur CE diff, pas sur ta mémoire de ce qui aurait dû changer.
3. LIS chaque fichier du diff : ouvre-le (read), vérifie les symboles réels (lsp), confirme l'état actuel (grep). Ne révise pas sur un résumé.
4. POUR CHAQUE CRITÈRE (AC-<n>) : retrouve son test par \`grep AC-<n>\` dans la suite de tests, LIS-le et LANCE-le. Rapporte \`AC-<n> → fichier:ligne → pass/fail\`. Un critère sans test traçable est un BLOQUANT (l'implémentation ne l'a pas prouvé) ; un critère dont le test échoue est un BLOQUANT.
5. POUR CHAQUE spec (S-<n>) : vérifie que l'implémentation respecte son comportement observable et que le(s) AC qu'elle fait passer passent. Une spec n'est revue que quand ses critères sont prouvés.
6. Traçabilité DANS LES DEUX SENS : (a) chaque spec (S-<n>) et chaque lot (BR-<n>) pointe vers un AC — un S ou un BR sans AC est une spec orpheline à signaler ; (b) chaque AC est couvert par au moins une spec — un AC non couvert est à signaler ; (c) chaque fichier du diff est couvert par au moins une spec — fichier modifié sans spec = changement non spécifié à signaler.
7. Évalue les implications sécurité : nouvelles dépendances, exposition d'API, gestion des erreurs critiques.
8. Vérifie les exigences non-fonctionnelles si listées dans les specs (performance, compatibilité).
9. CONSIGNE le verdict dans le contrat : écris-le (write) dans ${CONTRACT_PATH} sous un titre \`## Revue\` (remplace une section \`## Revue\` existante, ne touche pas au reste). C'est ce que /impl --fix relira pour lever les bloquants. Ne le mets PAS en mémoire mem0.

Format du verdict (dans le contrat ET dans ta réponse) :
- STATUT : APPROUVÉ / BLOQUANT / MINEUR
- AC PAR AC : id → test (fichier:ligne) → pass/fail
- SPEC PAR SPEC : pass ou fail, avec preuve
- BLOQUANTS : s'il n'y a AUCUN bloquant, écris EXACTEMENT \`- BLOQUANTS : aucun\` ; s'il y en a, liste-les numérotés et actionnables, un par ligne sous ce champ (\`1. …\`). Cette ligne est relue MÉCANIQUEMENT pour router la suite du pipeline — elle annonce /impl --fix tant qu'un bloquant reste consigné, et la fin du cycle sur « aucun » ; un champ omis donne un verdict illisible (retour sur /review). C'est aussi la liste que /impl --fix traitera.
- RECOMMANDATIONS : améliorations non-bloquantes
- DÉCISION FINALE : approuvé ou non (avec raison)`;

/**
 * Amorce de la session de revue. Fonction pure. Besoins, critères, specs et lots
 * viennent du contrat ; le diff git dit ce qui a changé. `focus` restreint le
 * périmètre.
 */
export function buildReviewSeed(focus: string): string {
  const f = focus.trim();
  return (
    "[review] Session de revue. Objectif : vérifier que l'implémentation correspond aux spécifications " +
    `figées dans le contrat ${CONTRACT_PATH}, que chaque critère d'acceptation est prouvé par un test ` +
    "traçable, et que l'ensemble couvre les besoins originaux.\n\n" +
    (f ? `Périmètre : ${f}\n\n` : "") +
    REVIEW_DIRECTIVE
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function reqExtension(pi: ExtensionAPI) {
  // Toute la git du plugin passe par là : jamais node:child_process dans
  // l'extension, et le runner est injectable dans les tests. `killed` (timeout)
  // devient un échec, comme un code ≠ 0 — aucune porte d'approbation sur pi.exec.
  const run: GitRunner = async (args, cwd) => {
    try {
      const res = await pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
      return {
        code: res.killed ? 124 : res.code,
        stdout: res.stdout ?? "",
        stderr: res.killed ? `git ${args[0]} : délai dépassé (${GIT_TIMEOUT_MS} ms)` : (res.stderr ?? ""),
      };
    } catch (err) {
      return { code: 127, stdout: "", stderr: (err as Error).message };
    }
  };

  // Balayage en tête de CHAQUE maillon, avant toute autre action : le worktree
  // d'une feature poussée et propre est retiré au déclenchement suivant. Un
  // balayage impossible est signalé et ne retire rien.
  const sweep = async (ctx: ExtensionContext) => {
    try {
      const result = await sweepFeatureWorktrees({
        run,
        baseDir: worktreesBaseDir(),
        currentCwd: ctx.cwd,
        repoRoot: ctx.cwd,
      });
      const message = buildSweepMessage(result);
      if (message) {
        pi.sendMessage(
          { customType: "pipeline", content: message, display: true, attribution: "user" },
          { triggerTurn: false },
        );
      }
    } catch (err) {
      ctx.ui?.notify?.(`[pipeline] balayage des worktrees ignoré : ${(err as Error).message}.`, "warning");
    }
  };

  // Une notice DURABLE (message d'affichage, jamais un toast qui disparaît au
  // redraw) est le seul canal de signalement du registre : le panneau, lui, ne
  // parle à l'utilisateur que dans son propre rang de notice.
  const notifyDurable = (text: string) =>
    pi.sendMessage({ customType: "pipeline", content: text, display: true, attribution: "user" }, { triggerTurn: false });

  const pipelineDeps = (ctx: PipelineCtx): PublishDeps => ({ ctx, notify: notifyDurable });

  // --- /pipelines et alt+w : le panneau des pipelines en cours --------------
  // Un seul panneau par processus : tant qu'un overlay est monté, une seconde
  // ouverture ne monte rien (aucun overlay empilé, aucun doublon).
  let panelOpen = false;
  let panelUnavailableNotified = false;

  const openPanel = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
      // RPC / print : rien à monter, et l'utilisateur doit l'apprendre UNE fois.
      if (!panelUnavailableNotified) {
        panelUnavailableNotified = true;
        notifyDurable("[pipeline] panneau indisponible hors session interactive");
      }
      return;
    }
    if (panelOpen) return;
    panelOpen = true;
    const deps: PipelinesPanelDeps = {
      stateDir: pipelineStateDir(),
      join: (entry, close, showNotice) => {
        // `switchSession` vit sur le contexte de COMMANDE : le runtime appelle
        // `createCommandContext()` pour les commandes ET pour les raccourcis, donc
        // le même `ctx` porte la bascule dans les deux cas (cf. `## Documentation` §3).
        // Le cast est DOUBLE parce que la façade publique masque les méthodes de
        // relocalisation du gestionnaire (`## Documentation` §2) : elles sont bien
        // là au runtime, le type ne les déclare pas.
        void joinEntry(entry, {
          ctx: ctx as unknown as SwitchCtx,
          close,
          showNotice,
          notify: notifyDurable,
        });
      },
    };
    try {
      void ctx.ui
        .custom(pipelinesPanelFactory(deps), {
          overlay: true,
          overlayOptions: { anchor: "top-right", width: PANEL_WIDTH, maxHeight: "80%", margin: 1 },
        })
        .catch(() => {
          /* le panneau ne doit jamais faire échouer la commande qui l'ouvre */
        })
        .finally(() => {
          panelOpen = false;
        });
    } catch {
      panelOpen = false;
      ctx.ui?.notify?.("[pipeline] affichage du panneau impossible.", "warning");
    }
  };

  pi.registerCommand("pipelines", {
    description: "Affiche le panneau des pipelines en cours (tous les processus OMP, tous dépôts) — Échap ferme",
    handler: async (_args, ctx) => {
      openPanel(ctx);
    },
  });

  pi.registerShortcut("alt+w", {
    description: "Panneau des pipelines en cours",
    handler: async (ctx) => {
      openPanel(ctx);
    },
  });

  // --- registre des pipelines : battement et republication -------------------
  // Le propriétaire SEUL écrit ses entrées : les lecteurs du magasin (le panneau,
  // y compris celui d'un autre processus) ne font que constater.
  pi.on("session_start", async (_event, ctx) => {
    resetStateWriteWarning();
    ensureHeartbeat(ctx as PipelineCtx, { notify: notifyDurable });
  });

  pi.on("agent_start", async (_event, ctx) => {
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  // L'outil `ask` en vol est le cas le plus visible de « suspendu à une question » :
  // l'état est publié dès le démarrage de l'appel, pas à la fin du tour.
  pi.on("tool_execution_start", async (event, ctx) => {
    if (event.toolName === "ask") pendingAsks.add(event.toolCallId);
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Par identifiant d'appel : un `end` manquant ne fige pas le compteur, et un
    // `end` d'un autre appel non plus.
    pendingAsks.delete(event.toolCallId);
    pendingApprovals.delete(event.toolCallId);
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  pi.on("tool_approval_requested", async (event, ctx) => {
    pendingApprovals.add(event.toolCallId);
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  pi.on("tool_approval_resolved", async (event, ctx) => {
    pendingApprovals.delete(event.toolCallId);
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  // --- /req : ouvre la feature dans son worktree, puis arme la collecte ------
  // L'isolation passe AVANT tout envoi de texte : l'agent doit écrire le contrat
  // dans le worktree, pas dans le dépôt principal.
  pi.registerCommand("req", {
    description: "Ouvre la feature dans son worktree git dédié et active la collecte de besoins",
    handler: async (args, ctx) => {
      await sweep(ctx);

      const root = resolveFeatureRoot(ctx.cwd);
      if (root.primary) {
        ctx.ui?.notify?.(
          `[req] déjà dans le worktree d'une feature (${root.dir}) — /req s'ouvre depuis le dépôt principal (${root.primary}).`,
          "warning",
        );
        return;
      }
      if (!fs.existsSync(path.join(root.dir, ".git"))) {
        ctx.ui?.notify?.(
          `[req] ${ctx.cwd} n'est pas dans un dépôt git — /req isole chaque feature dans son worktree.`,
          "warning",
        );
        return;
      }

      const typed = String(args ?? "").trim();
      let name = typed.split(/\s+/).filter(Boolean)[0] ?? "";
      if (!name && ctx.hasUI && typeof ctx.ui?.input === "function") {
        name = ((await ctx.ui.input("Nom de la feature", "ex. isolation-worktree")) ?? "").trim();
      }
      if (!name) {
        ctx.ui?.notify?.("[req] nom de feature requis : /req <nom-de-feature> (ex. isolation-worktree).", "warning");
        return;
      }
      const slug = toSlug(name);
      if (!slug) {
        ctx.ui?.notify?.(
          `[req] nom invalide : « ${name} » — lettres minuscules, chiffres et tirets (ex. isolation-worktree).`,
          "warning",
        );
        return;
      }

      const branch = branchFor(slug);
      if (await branchTaken(run, root.dir, branch)) {
        ctx.ui?.notify?.(`[req] la branche ${branch} existe déjà — choisis un autre nom.`, "warning");
        return;
      }

      const created = await createFeatureWorktree({
        run,
        primaryRoot: root.dir,
        slug,
        baseDir: worktreesBaseDir(),
      });
      if (!created.ok) {
        ctx.ui?.notify?.(`[req] création du worktree impossible : ${created.error}`, "warning");
        return;
      }

      // Rollback : l'arbre vient d'être créé, il est vierge — `worktree remove`
      // sans `--force` suffit, et la branche reste.
      const rollback = async () => {
        await run(["worktree", "remove", created.path], root.dir);
      };

      if (typeof ctx.newSession !== "function") {
        await rollback();
        ctx.ui?.notify?.(
          "[req] session dans le worktree impossible : nouvelle session indisponible — worktree annulé, relance /req.",
          "warning",
        );
        return;
      }

      let failure = "";
      try {
        const res = await ctx.newSession({
          setup: async (sm) => {
            await sm.moveTo(created.path);
          },
        });
        if (res?.cancelled) failure = "nouvelle session annulée";
      } catch (err) {
        failure = (err as Error).message;
      }
      if (failure) {
        await rollback();
        ctx.ui?.notify?.(
          `[req] session dans le worktree impossible : ${failure} — worktree annulé, relance /req.`,
          "warning",
        );
        return;
      }

      // La collecte suit le WORKTREE (clé = cwd), pas la session : la session
      // vient d'être remplacée, le worktree est l'identité de la feature.
      const st = stateOfCwd(created.path);
      st.reqMode = true;
      // Maillon armé après la bascule de session : l'annonce partira à la
      // retombée qui SUIT un « fin » de l'utilisateur, jamais pendant la collecte.
      // L'armement publie AUSSI l'entrée du magasin : elle existe dès la commande.
      armPipeline(pipelineDeps(ctx as PipelineCtx), created.path, "req");
      pi.sendMessage(
        {
          customType: "req",
          content: buildWelcome({ slug, branch: created.branch, path: created.path }),
          display: true,
          attribution: "user",
        },
        { triggerTurn: false },
      );
    },
  });

  // --- /specs : session de spécification ---------------------------------
  // newSession n'existe que sur le contexte de commande (pas sur celui d'un
  // event) — d'où une commande plutôt qu'une détection de mot-clé. Les besoins
  // ne sont pas portés dans l'amorce : ils vivent dans le contrat, écrit par la
  // clôture de /req.
  pi.registerCommand("specs", {
    description: "Ouvre une session de spécification qui lit le contrat de besoins (specs one-shot)",
    handler: async (args, ctx) => {
      await sweep(ctx);
      // Le contrat est celui du CWD : hors du worktree d'une feature (et sans
      // contrat hérité), il n'y a rien à spécifier.
      const gate = linkGate(ctx.cwd);
      if (!gate.ok) {
        ctx.ui?.notify?.(`[specs] : ${gate.reason}`, "warning");
        return;
      }
      const seed = buildSpecsSeed(String(args ?? "").trim());
      stateOfCwd(ctx.cwd).reqMode = false;
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[specs] nouvelle session impossible (${(err as Error).message}) — spécification dans la session courante.`,
            "warning",
          );
        }
      }
      // Armé juste avant l'envoi de l'amorce : la suite (/impl, ou /specs si le
      // contrat n'a pas de specs) sera annoncée à la retombée de CE maillon, pas
      // à celle du tour précédent.
      armPipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "specs");
      pi.sendUserMessage(seed);
    },
  });

  // --- /impl : session d'implémentation ----------------------------------
  pi.registerCommand("impl", {
    description: "Ouvre une session d'implémentation one-shot ; --fix lève les bloquants de la dernière /review",
    handler: async (args, ctx) => {
      await sweep(ctx);
      const gate = linkGate(ctx.cwd);
      if (!gate.ok) {
        ctx.ui?.notify?.(`[impl] : ${gate.reason}`, "warning");
        return;
      }
      const raw = String(args ?? "").trim();
      const tokens = raw.split(/\s+/).filter(Boolean);
      const fix = tokens.includes("--fix");
      const focus = tokens.filter((t) => t !== "--fix").join(" ");
      const seed = buildImplSeed(focus, fix);
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[impl] nouvelle session impossible (${(err as Error).message}) — implémentation dans la session courante.`,
            "warning",
          );
        }
      }
      // Armé juste avant l'envoi de l'amorce : la suite (/review, ou /specs si le
      // contrat n'a pas de specs) sera annoncée à la retombée de ce maillon.
      armPipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "impl");
      pi.sendUserMessage(seed);
    },
  });

  // --- /review : session de revue ----------------------------------------
  pi.registerCommand("review", {
    description: "Ouvre une session de revue one-shot (contrat de feature + git diff)",
    handler: async (args, ctx) => {
      await sweep(ctx);
      const gate = linkGate(ctx.cwd);
      if (!gate.ok) {
        ctx.ui?.notify?.(`[review] : ${gate.reason}`, "warning");
        return;
      }
      const seed = buildReviewSeed(String(args ?? "").trim());
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[review] nouvelle session impossible (${(err as Error).message}) — revue dans la session courante.`,
            "warning",
          );
        }
      }
      // Armé juste avant l'envoi de l'amorce : à la retombée, le verdict lu dans
      // `## Revue` décidera entre /impl --fix et la fin de cycle.
      armPipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "review");
      pi.sendUserMessage(seed);
    },
  });

  // --- before_agent_start : directive + détection de « fin » -------------
  pi.on("before_agent_start", async (event, ctx) => {
    const st = stateOfCwd(ctx.cwd);
    if (!st.reqMode) {
      return { systemPrompt: event.systemPrompt };
    }

    const prompt = event.prompt.trim();
    // Nos propres notices ([req] … et [pipeline] …) retraversent ce hook ; ne
    // jamais les traiter comme une entrée utilisateur, sinon le « fin » du message
    // d'accueil (buildWelcome) clôturerait la collecte, et celui d'une notice de
    // fin de maillon (un chemin de worktree peut contenir « fin ») aussi. Défense
    // en profondeur : elles sont déjà postées sans démarrer de tour, mais un echo
    // ou une régression resteraient sûrs.
    if (isPipelineNotice(prompt)) {
      return { systemPrompt: event.systemPrompt };
    }

    if (saysFin(prompt)) {
      // « fin » dit : le maillon /req peut se clore. C'est la seule clôture que le
      // handler session_stop acceptera d'annoncer pour cette phase — sans elle, la
      // collecte est en cours et l'agent vient simplement de rendre la main.
      st.closing = true;
      // Post the handoff as a display message (NO turn started) to break the notice-posting loop.
      // Keep reqMode = true so before_agent_start keeps filtering notices instead of unfiltering them.
      pi.sendMessage(
        { customType: "req", content: buildReqHandoff(), display: true, attribution: "user" },
        { triggerTurn: false },
      );
      // Le contrat n'est PAS écrit ici : `pi.fs` n'existe pas sur ExtensionAPI
      // (vérifié dans les types OMP : ni fs, ni readFile, ni writeFile), et un
      // dump brut des messages n'est de toute façon pas le contrat attendu —
      // `## Besoins` doit porter des phrases d'action et `## Critères
      // d'acceptation` des Given/When/Then. C'est l'agent, dans ce
      // même tour, qui lit le handoff et écrit le fichier avec son outil write.
      return { systemPrompt: event.systemPrompt };
    }

    // Pas d'accusé de réception par sendUserMessage : il DÉMARRE un tour
    // supplémentaire à chaque message (deux tours par échange, pour rien). La
    // directive suffit à faire répondre l'agent, et la conversation est déjà
    // dans son contexte — inutile de la recopier dans un état local vide.
    return { systemPrompt: [...event.systemPrompt, SYSTEM_DIRECTIVE_REQ] };
  });

  // --- session_stop : fin de maillon, la commande de la suite est annoncée ---
  // OMP n'émet `session_stop` que sur la retombée TERMINALE du fil principal :
  // toutes les retombées non terminales (retry, compaction, todo, job asynchrone)
  // sortent avant par un `willContinue: true`, et une session de sous-agent `task`
  // est écartée par la garde `agentKind` du harness. C'est donc le seul instant où
  // « la phase est finie » est vrai — d'où ce hook, et pas `agent_end`.
  //
  // Le handler ne demande AUCUNE continuation et ne relance AUCUN tour : il poste
  // un message d'affichage et rend `undefined`. C'est la faute qui avait produit
  // la boucle infinie de la v0.4.5 — un `sendUserMessage` d'ici démarre un tour
  // dont la fin redéclenche ce hook. Corps sous try/catch : une annonce ne doit
  // jamais perturber la retombée.
  pi.on("session_stop", async (_event, ctx) => {
    try {
      const st = stateOfCwd(ctx.cwd);
      const phase = st.phase;
      // L'agent rend la main : l'état publié bascule sur « attend » (S-4), même
      // quand ce maillon n'a rien à annoncer (retombée d'une collecte en cours).
      publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
      if (!phase || st.announced) return;
      // /req ne se clôt que sur « fin » : sans elle, la collecte est en cours et
      // l'agent vient simplement de rendre la main.
      if (phase === "req" && !st.closing) return;
      // Marqué AVANT les effets : une annonce qui échoue ne doit pas se rejouer à
      // chaque retombée suivante.
      st.announced = true;

      // Contrat du cwd, `""` s'il est absent ou illisible : lu comme « pas de
      // specs » → /specs, ce qui est le rattrapage voulu et non un échec.
      let contract = "";
      try {
        contract = fs.readFileSync(contractPathFor(ctx.cwd), "utf8");
      } catch {
        /* contrat absent : routage sur chaîne vide */
      }

      const step = nextStepFor(phase, contract);
      pi.sendMessage(
        {
          customType: "pipeline",
          content: buildNextStepNotice(phase, step),
          display: true,
          attribution: "user",
        },
        { triggerTurn: false },
      );
      prefillEditor(ctx, step);

      // Fin de CYCLE (S-6) : le verdict de /review ne laisse aucun bloquant — la
      // pipeline quitte la liste des pipelines en cours et rejoint l'historique en
      // « terminé ». Une revue bloquante la laisse en cours (la suite est
      // /impl --fix), et un verdict illisible n'est jamais un « terminé » par
      // défaut : `nextStepFor` ne rend `cycle-end` que sur un verdict propre.
      if (step.kind === "cycle-end") {
        try {
          closePipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "done");
        } catch (err) {
          // Historique non écrit ⇒ l'entrée en cours reste (aucune perte
          // silencieuse) ; l'échec est signalé au plus une fois par session.
          reportStateWriteFailure(pipelineDeps(ctx as PipelineCtx), err);
        }
      }
    } catch {
      /* une annonce ne doit jamais perturber la fin de maillon */
    }
  });
}
