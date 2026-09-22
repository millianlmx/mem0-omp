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

import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

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

const PIPELINE_PHASES: readonly PipelinePhase[] = ["req", "specs", "impl", "review", "release"];

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

/**
 * Schéma réellement écrit dans `running/<id>.json` : `RunningEntry` plus le
 * marqueur de schéma. Nommé pour que l'écart ne se reperde pas — `version` n'est
 * pas un champ de `RunningEntry`, et le lecteur (`asRunningEntry`) refuse toute
 * autre valeur que 1.
 */
export type RunningFile = RunningEntry & { version: 1 };

export function writeRunningEntry(stateDir: string, entry: RunningEntry): void {
  const payload: RunningFile = { version: 1, ...entry };
  writeJsonAtomic(path.join(pipelineRunningDir(stateDir), `${entry.id}.json`), payload);
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
  // Aucun réarmement ici : la notice « état non écrit » vaut AU PLUS UNE FOIS PAR
  // SESSION, et la seule frontière de session est le hook `session_start`. Réarmer
  // à chaque maillon la republiait une fois par maillon.
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
// Lot de features — le magasin, la chaîne, le pilote.
// ---------------------------------------------------------------------------
// Un lot = N features, un pipeline par feature, piloté par UN process (le
// propriétaire, `owner.pid`). Chaque maillon d'une feature est un RUN : un
// processus `omp -p` (cf. `buildLotRunArgv`) qui travaille dans le worktree de la
// feature et meurt à la fin de son tour. Le pilote ne décide rien d'autre que la
// suite, et cette décision est PURE (`nextChainAction`) : l'état vit dans deux
// fichiers — le contrat de la feature (écrit par l'agent) et le lot (écrit par le
// pilote seul).
//
// Pourquoi des processus et pas des sessions en mémoire : l'échec ou le blocage
// d'un pipeline ne doit ni emporter le lot ni freiner les autres (B-5), et une
// extension n'a aucun moyen de créer une session (`ctx.newSession` n'existe que
// sur un contexte de commande, cf. `## Documentation` §1). Le parallélisme du lot
// est donc celui de N processus indépendants, et l'isolation est structurelle.

export const LOT_VERSION = 1;

export type LotFeatureState = "pending" | "running" | "waiting" | "blocked" | "failed" | "done" | "cancelled";
export type LotWaitKind = "answer" | "specs" | "review";
/**
 * D'où vient la feature. `session` : sa collecte se déroule dans la session de
 * l'utilisateur (créée par /req) — le pilote ne lance aucun run tant que le
 * maillon `req` n'est pas clos. `panneau` : tout est run, collecte comprise.
 */
export type LotOrigin = "session" | "panneau";

export type LotFeature = {
  slug: string;
  /** L'intention déclarée à l'ajout : elle amorce la collecte. */
  name: string;
  branch: string;
  /** Chemin du worktree de la feature ("" tant qu'il n'est pas créé). */
  worktree: string;
  deps: string[];
  origin: LotOrigin;
  state: LotFeatureState;
  phase: PipelinePhase;
  waitKind: LotWaitKind | null;
  /** Texte à montrer quand la feature attend une réponse (fin du tour du run). */
  waitPrompt: string | null;
  sessionFile: string | null;
  prUrl: string | null;
  stopReason: string | null;
  /** Tours de correction `impl --fix` consommés (plafond, S-5). */
  fixes: number;
  /** Passes de `review` consommées (borne du verdict illisible). */
  reviewRuns: number;
  /** sha1 du contrat au DÉMARRAGE du run courant — dit si un run a travaillé. */
  contractHash: string | null;
  addedAt: number;
  /** Instant d'entrée dans l'état courant : c'est lui que le panneau chronomètre. */
  sinceAt: number;
  updatedAt: number;
  endedAt: number | null;
};

export type Lot = {
  version: 1;
  id: string;
  repoRoot: string;
  status: "draft" | "running";
  /** Plafond de tours de correction, figé au premier lancement (S-5). */
  reviewCap: number;
  /** Instant du récap posté, `null` tant qu'il ne l'a pas été (S-12). */
  recapAt: number | null;
  owner: { pid: number; sessionFile: string | null; sessionId: string | null };
  createdAt: number;
  launchedAt: number | null;
  features: LotFeature[];
};

export type LotTotals = { done: number; blocked: number; failed: number; cancelled: number; live: number };

const LOT_FEATURE_STATES: Record<LotFeatureState, true> = {
  pending: true,
  running: true,
  waiting: true,
  blocked: true,
  failed: true,
  done: true,
  cancelled: true,
};
const LOT_WAIT_KINDS: Record<LotWaitKind, true> = { answer: true, specs: true, review: true };
const LOT_ORIGINS: Record<LotOrigin, true> = { session: true, panneau: true };

/** Un état terminal ne repart que par une relance explicite (S-9). */
export function lotStateTerminal(state: LotFeatureState): boolean {
  return state === "blocked" || state === "failed" || state === "done" || state === "cancelled";
}

export function lotStateLabel(state: LotFeatureState): string {
  switch (state) {
    case "pending":
      return "à venir";
    case "running":
      return "en cours";
    case "waiting":
      return "attend";
    case "blocked":
      return "bloqué";
    case "failed":
      return "échoué";
    case "done":
      return "terminé";
    case "cancelled":
      return "annulé";
  }
}

/** Le libellé du jalon en cours d'attente (« attend ma réponse », …). */
export function lotWaitLabel(waitKind: LotWaitKind | null): string | null {
  if (waitKind === "answer") return "attend réponse";
  if (waitKind === "specs") return "attend validation";
  if (waitKind === "review") return "attend accord";
  return null;
}

/** `<stateDir>/lots` : un fichier par dépôt. */
export function lotStateDir(stateDir: string): string {
  return path.join(stateDir, "lots");
}

/** `sha1(realpath(repoRoot)).slice(0,16)` : même famille d'id que `runningIdFor`. */
export function lotRepoKey(repoRoot: string): string {
  return crypto.createHash("sha1").update(realpathOr(repoRoot)).digest("hex").slice(0, 16);
}

export function lotPathFor(stateDir: string, repoKey: string): string {
  return path.join(lotStateDir(stateDir), `${repoKey}.json`);
}

function asLotFeatureState(value: unknown): LotFeatureState | null {
  return typeof value === "string" && LOT_FEATURE_STATES[value as LotFeatureState] === true
    ? (value as LotFeatureState)
    : null;
}

/** Validation champ par champ : un fichier au schéma incomplet est rejeté. */
function asLotFeature(raw: unknown): LotFeature | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  // Le FORMAT du slug compte autant que son type : il nomme un répertoire de
  // worktree et sort de la base d'archive (`worktreePathFor`), puis sert de `cwd`
  // aux runs. Un slug hors `[a-z0-9-]` — fichier de lot falsifié ou écrit par une
  // version future — est donc rejeté ici, comme un champ manquant.
  if (typeof f.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(f.slug)) return null;
  if (typeof f.name !== "string" || typeof f.branch !== "string" || typeof f.worktree !== "string") return null;
  const state = asLotFeatureState(f.state);
  if (!state) return null;
  if (!PIPELINE_PHASES.includes(f.phase as PipelinePhase)) return null;
  const origin =
    typeof f.origin === "string" && LOT_ORIGINS[f.origin as LotOrigin] === true ? (f.origin as LotOrigin) : null;
  if (!origin) return null;
  const waitKind =
    f.waitKind === null
      ? null
      : typeof f.waitKind === "string" && LOT_WAIT_KINDS[f.waitKind as LotWaitKind] === true
        ? (f.waitKind as LotWaitKind)
        : undefined;
  if (waitKind === undefined) return null;
  const deps = Array.isArray(f.deps) ? f.deps.filter((d): d is string => typeof d === "string") : [];
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    slug: f.slug,
    name: f.name,
    branch: f.branch,
    worktree: f.worktree,
    deps,
    origin,
    state,
    // La phase est validée contre la liste ci-dessus : c'est un PipelinePhase.
    phase: f.phase as PipelinePhase,
    waitKind,
    waitPrompt: asStringOrNull(f.waitPrompt),
    sessionFile: asStringOrNull(f.sessionFile),
    prUrl: asStringOrNull(f.prUrl),
    stopReason: asStringOrNull(f.stopReason),
    fixes: Math.max(0, Math.trunc(num(f.fixes, 0))),
    reviewRuns: Math.max(0, Math.trunc(num(f.reviewRuns, 0))),
    contractHash: asStringOrNull(f.contractHash),
    addedAt: num(f.addedAt, 0),
    sinceAt: num(f.sinceAt, 0),
    updatedAt: num(f.updatedAt, 0),
    endedAt: typeof f.endedAt === "number" && Number.isFinite(f.endedAt) ? f.endedAt : null,
  };
}

function asLot(raw: unknown): Lot | null {
  if (!raw || typeof raw !== "object") return null;
  const l = raw as Record<string, unknown>;
  if (l.version !== LOT_VERSION) return null;
  if (typeof l.id !== "string" || l.id === "" || typeof l.repoRoot !== "string" || l.repoRoot === "") return null;
  if (l.status !== "draft" && l.status !== "running") return null;
  if (!Array.isArray(l.features)) return null;
  // Une feature invalide fait rejeter le lot ENTIER : un lot amputé en silence
  // ferait disparaître un pipeline du panneau et lancerait les runs d'un état que
  // personne n'a écrit. Même doctrine que le reste du fichier — un schéma
  // incomplet est lu comme absent (S-1), et le panneau le compte comme illisible.
  const features: LotFeature[] = [];
  for (const raw of l.features) {
    const feature = asLotFeature(raw);
    if (!feature) return null;
    features.push(feature);
  }
  const owner = l.owner;
  if (!owner || typeof owner !== "object" || typeof (owner as Record<string, unknown>).pid !== "number") return null;
  const o = owner as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    version: LOT_VERSION,
    id: l.id,
    repoRoot: l.repoRoot,
    status: l.status,
    reviewCap: Math.max(1, Math.trunc(typeof l.reviewCap === "number" ? l.reviewCap : 1)),
    recapAt: typeof l.recapAt === "number" && Number.isFinite(l.recapAt) ? l.recapAt : null,
    owner: { pid: o.pid as number, sessionFile: asStringOrNull(o.sessionFile), sessionId: asStringOrNull(o.sessionId) },
    createdAt: num(l.createdAt),
    launchedAt: typeof l.launchedAt === "number" && Number.isFinite(l.launchedAt) ? l.launchedAt : null,
    features,
  };
}

/** Le lot du dépôt, ou `null` (absent, illisible, ou schéma d'une autre version). */
export function readLot(stateDir: string, repoKey: string): Lot | null {
  return asLot(readJsonFile(lotPathFor(stateDir, repoKey)));
}

export function writeLot(stateDir: string, lot: Lot): void {
  writeJsonAtomic(lotPathFor(stateDir, lot.id), { ...lot, version: LOT_VERSION });
}

export function lotFeature(lot: Lot, slug: string): LotFeature | undefined {
  return lot.features.find((f) => f.slug === slug);
}

/** Une feature sans dépendance satisfaite n'a pas le droit de démarrer (S-10). */
export function runnable(lot: Lot, feature: LotFeature): boolean {
  return feature.deps.every((dep) => lotFeature(lot, dep)?.state === "done");
}

/**
 * Raison de blocage héritée d'une dépendance, ou `null`. Une dépendance `done`
 * libère ; une dépendance en cours ou en attente fait patienter (sans erreur) ;
 * échouée, bloquée ou annulée bloque la dépendante (AC-17).
 */
export function dependencyBlock(lot: Lot, feature: LotFeature): string | null {
  for (const dep of feature.deps) {
    const d = lotFeature(lot, dep);
    if (!d) return `dépendance inconnue : ${dep}`;
    if (d.state === "failed" || d.state === "blocked" || d.state === "cancelled") {
      return `dépend de ${dep} (${lotStateLabel(d.state)})`;
    }
  }
  return null;
}

export function lotTotals(lot: Lot): LotTotals {
  const totals: LotTotals = { done: 0, blocked: 0, failed: 0, cancelled: 0, live: 0 };
  for (const f of lot.features) {
    if (f.state === "done") totals.done += 1;
    else if (f.state === "blocked") totals.blocked += 1;
    else if (f.state === "failed") totals.failed += 1;
    else if (f.state === "cancelled") totals.cancelled += 1;
    else totals.live += 1;
  }
  return totals;
}

/**
 * Récap de fin de lot (AC-15) : le décompte exact et une ligne par catégorie non
 * vide. Les raisons des bloquées et des échouées sont reprises telles quelles.
 */
export function buildLotRecap(repo: string, lot: Lot): string {
  const t = lotTotals(lot);
  const lines = [
    `[pipeline] lot ${repo} terminé — ${t.done} terminées, ${t.blocked} bloquées, ${t.failed} échouées, ${t.cancelled} annulées`,
  ];
  const withState = (state: LotFeatureState) => lot.features.filter((f) => f.state === state);
  const done = withState("done").map((f) => f.slug);
  if (done.length > 0) lines.push(`terminé : ${done.join(", ")}`);
  const blocked = withState("blocked");
  if (blocked.length > 0) {
    lines.push(`bloqué : ${blocked.map((f) => `${f.slug} (${f.stopReason ?? "raison inconnue"})`).join(", ")}`);
  }
  const failed = withState("failed");
  if (failed.length > 0) {
    lines.push(`échoué : ${failed.map((f) => `${f.slug} (${f.stopReason ?? "raison inconnue"})`).join(", ")}`);
  }
  const cancelled = withState("cancelled").map((f) => f.slug);
  if (cancelled.length > 0) lines.push(`annulé : ${cancelled.join(", ")}`);
  return lines.join("\n");
}

export type LotAlert = { text: string; tone: "info" | "warning" | "error" };

/**
 * Alerte d'une transition (AC-11) : une par transition, jamais rejouée par une
 * relecture. `null` pour les états qui n'appellent pas l'utilisateur (à venir, en
 * cours, annulé). Le texte ne contient jamais « fin » comme mot isolé : il
 * retraverse `before_agent_start`, où ce mot clôturerait une collecte.
 */
export function buildLotAlert(repo: string, feature: LotFeature): LotAlert | null {
  const head = `${repo}/${feature.slug}`;
  if (feature.state === "waiting") {
    if (feature.waitKind === "specs") {
      return { text: `[pipeline] ${head} : spécifications prêtes, attend ta validation — v dans /pipelines`, tone: "warning" };
    }
    if (feature.waitKind === "review") {
      return {
        text: `[pipeline] ${head} : revue propre, attend ton accord pour livrer — y dans /pipelines`,
        tone: "warning",
      };
    }
    const prompt = feature.waitPrompt ? `\n${clipTail(feature.waitPrompt, LOT_ALERT_PROMPT_MAX)}` : "";
    return {
      text: `[pipeline] ${head} attend ta réponse (maillon /${feature.phase}) — /pipelines${prompt}`,
      tone: "warning",
    };
  }
  if (feature.state === "blocked") {
    return { text: `[pipeline] ${head} bloqué : ${feature.stopReason ?? "raison inconnue"} — /pipelines`, tone: "error" };
  }
  if (feature.state === "failed") {
    return { text: `[pipeline] ${head} échoué : ${feature.stopReason ?? "raison inconnue"} — /pipelines`, tone: "error" };
  }
  if (feature.state === "done") {
    return { text: `[pipeline] ${head} terminé — ${feature.prUrl ? `PR ${feature.prUrl}` : "PR non confirmée"}`, tone: "info" };
  }
  return null;
}

// --- plafond, sortie de run, timeouts : bornes et lecture d'environnement -----

export const LOT_TICK_MS = 2000;
export const LOT_RUN_TIMEOUT_MS = 3_600_000;
export const PIPELINE_REVIEW_CAP_DEFAULT = 3;
/** Le texte d'un run est borné : le panneau en montre la fin (les questions y sont). */
export const LOT_WAIT_PROMPT_MAX = 1200;
export const LOT_ALERT_PROMPT_MAX = 400;
/** Un motif de panne tient dans un rang de panneau et dans une alerte (S-4). */
export const LOT_REASON_MAX = 200;
/** Budget de l'éditeur en ligne du panneau (S-7). */
export const LOT_EDITOR_MAX = 4000;

/** Entier d'environnement borné, ou le défaut (une variable absente ou vide). */
function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = (raw ?? "").trim();
  if (text === "") return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** `MEM0_PIPELINE_REVIEW_CAP` : plafond des tours de correction (défaut 3). */
export function lotReviewCap(env: Record<string, string | undefined> = process.env): number {
  return envInt(env.MEM0_PIPELINE_REVIEW_CAP, PIPELINE_REVIEW_CAP_DEFAULT, 1, 20);
}

/** `MEM0_PIPELINE_RUN_TIMEOUT_MS` : budget d'un run (défaut 1 h). */
export function lotRunTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return envInt(env.MEM0_PIPELINE_RUN_TIMEOUT_MS, LOT_RUN_TIMEOUT_MS, 10_000, 86_400_000);
}

/** `MEM0_PIPELINE_OMP_BIN` : binaire `omp` des runs, sinon `omp` du PATH. */
export function lotOmpBin(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.MEM0_PIPELINE_OMP_BIN ?? "").trim();
  return raw === "" ? "omp" : raw;
}

/**
 * `MEM0_PIPELINE_ARCHIVE_DIR` (absolu ou `~`) sinon `~/.omp/pipeline-archive` :
 * même famille que `worktreesBaseDir`, un chemin relatif est ignoré.
 */
export function lotArchiveBaseDir(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
): string {
  const raw = (env.MEM0_PIPELINE_ARCHIVE_DIR ?? "").trim();
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  if (path.isAbsolute(raw)) return raw;
  return path.join(home, ".omp", "pipeline-archive");
}

// --- la chaîne : une décision pure, appliquée par le pilote (S-4, S-5) --------

export type ChainOutcome = "ok" | "error";
export type ChainAction =
  | { kind: "run"; phase: PipelinePhase; fix: boolean }
  | { kind: "wait"; waitKind: LotWaitKind }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "done" };

/**
 * Le maillon suivant, décidé par le seul contrat (+ l'issue du run et les
 * compteurs du plafond). Pure : c'est la même décision pour une feature de lot et
 * pour une feature ouverte par /req (AC-4), et c'est elle que les tests figent.
 *
 * Les deux jalons de l'utilisateur sont ici : `specs` produit ⇒ `wait specs`
 * (AC-8), revue propre ⇒ `wait review` (AC-9). La boucle de correction est bornée
 * par `cap` (AC-7).
 */
export function nextChainAction(input: {
  phase: PipelinePhase;
  outcome: ChainOutcome;
  contract: string;
  fixes: number;
  reviewRuns: number;
  cap: number;
}): ChainAction {
  const { phase, outcome, contract, fixes, reviewRuns, cap } = input;
  // La raison précise est attachée par le pilote (dernière ligne de stderr,
  // dépassement, binaire absent) : ici on ne connaît que l'issue.
  if (outcome === "error") return { kind: "failed", reason: "exécution en échec" };
  const hasSpecs = contractHasSection(contract, "Spécifications");
  switch (phase) {
    case "req": {
      const closed =
        contractHasSection(contract, "Besoins") && contractHasSection(contract, "Critères d'acceptation");
      // Collecte close (les deux sections sont écrites) ⇒ specs ; sinon le run a
      // posé ses questions et l'utilisateur doit répondre (AC-12).
      return closed ? { kind: "run", phase: "specs", fix: false } : { kind: "wait", waitKind: "answer" };
    }
    case "specs":
      return hasSpecs
        ? { kind: "wait", waitKind: "specs" }
        : { kind: "blocked", reason: "aucune spécification écrite par /specs" };
    case "impl":
      return hasSpecs
        ? { kind: "run", phase: "review", fix: false }
        : { kind: "blocked", reason: "le contrat n'a plus de section ## Spécifications" };
    case "review": {
      const verdict = reviewVerdict(contract);
      if (verdict === "clean") return { kind: "wait", waitKind: "review" };
      if (verdict === "blockers") {
        if (fixes < cap) return { kind: "run", phase: "impl", fix: true };
        return { kind: "blocked", reason: `plafond de ${cap} tours de correction atteint, revue toujours bloquante` };
      }
      if (reviewRuns <= cap) return { kind: "run", phase: "review", fix: false };
      return { kind: "blocked", reason: `verdict de revue illisible après ${cap + 1} passes` };
    }
    case "release":
      return { kind: "done" };
  }
}

/**
 * Un run interrompu (pilote disparu) se juge sur le seul indice disponible : le
 * contrat a-t-il bougé ? Modifié ⇒ le maillon a fait son travail, la chaîne
 * reprend ; inchangé ⇒ rien n'a été produit, la feature échoue et reste
 * relançable (S-1).
 */
export function reconcileInterrupted(input: {
  contractHashAtStart: string | null;
  currentContractHash: string | null;
}): "continue" | "failed" {
  if (input.currentContractHash !== null && input.currentContractHash !== input.contractHashAtStart) return "continue";
  return "failed";
}

/** sha1 du contrat d'un worktree, `null` s'il n'existe pas encore. */
export function contractHashOf(worktree: string): string | null {
  try {
    return crypto.createHash("sha1").update(fs.readFileSync(contractPathFor(worktree), "utf8")).digest("hex");
  } catch {
    return null;
  }
}

/** Contenu du contrat d'un worktree, `""` s'il est absent ou illisible. */
export function readContractText(worktree: string): string {
  try {
    return fs.readFileSync(contractPathFor(worktree), "utf8");
  } catch {
    return "";
  }
}

// --- le run : un processus `omp` par maillon (S-13) --------------------------

/** Ce qu'un runner de run rend : la sortie du mode print et son issue. */
export type LotRunnerResult = { code: number; killed: boolean; stdout: string; stderr: string };
export type LotRunnerInput = { argv: string[]; cwd: string; timeout: number; signal: AbortSignal };
export type LotRunner = (input: LotRunnerInput) => Promise<LotRunnerResult>;

export type LotRunSpec = {
  ompBin: string;
  worktree: string;
  prompt: string;
  lotId: string;
  slug: string;
  phase: PipelinePhase;
  stateDir: string;
  sessionFile?: string | null;
  selfPath?: string | null;
};

/**
 * L'argv exact d'un run. Le prompt suit `--` (positionnel littéral, cf.
 * `## Documentation` §2) : un prompt qui commence par `-` ne peut pas être pris
 * pour un drapeau. `--auto-approve` est nécessaire — sans lui les approbations
 * d'outils sont fail-closed en headless (`## Documentation` §1).
 */
export function buildLotRunArgv(spec: LotRunSpec): string[] {
  const argv = [
    spec.ompBin,
    "--cwd",
    spec.worktree,
    "-p",
    "--auto-approve",
    "--pipeline-lot",
    spec.lotId,
    "--pipeline-feature",
    spec.slug,
    "--pipeline-phase",
    spec.phase,
    "--pipeline-state-dir",
    spec.stateDir,
  ];
  if (spec.sessionFile) argv.push("--resume", spec.sessionFile);
  if (spec.selfPath) argv.push("-e", spec.selfPath);
  argv.push("--", spec.prompt);
  return argv;
}

/**
 * Le chemin de CETTE extension, pour qu'un run enfant charge exactement le code
 * qui vient de le lancer (en dev : le worktree de la feature). `null` si l'URL du
 * module n'est pas un fichier : l'enfant se rabat alors sur la découverte des
 * plugins — les chemins d'extension sont dédupliqués par chemin résolu, donc
 * passer les deux est sûr (`## Documentation` §2).
 */
export function selfExtensionArg(metaUrl: string | undefined): string | null {
  if (typeof metaUrl !== "string" || !metaUrl.startsWith("file://")) return null;
  try {
    const file = decodeURIComponent(new URL(metaUrl).pathname);
    return path.isAbsolute(file) ? file : null;
  } catch {
    return null;
  }
}

/** L'URL de ce module, quand le runtime en expose une (ESM) — sinon `undefined`. */
const SELF_MODULE_URL: string | undefined = (() => {
  try {
    return (import.meta as { url?: string }).url;
  } catch {
    return undefined;
  }
})();

export type LotPromptKind = "collecte" | "phase" | "answer" | "relaunch";

/**
 * Le préambule de tout run de lot. Deux règles non négociables : l'outil `ask`
 * n'existe pas en headless (l'agent finit son tour avec ses questions EN TEXTE,
 * cf. `## Documentation` §1) et la chaîne n'appartient pas à l'agent — le pilote
 * la décide (`nextChainAction`).
 */
export const LOT_WORKER_DIRECTIVE = `Mode lot : tu tournes dans un pipeline, sans interface.
- L'outil \`ask\` n'est pas disponible. Termine ton tour par tes questions bloquantes EN TEXTE, numérotées et actionnables : elles s'affichent dans le panneau du lot et l'utilisateur y répond ; sa réponse te reviendra au tour suivant.
- N'annonce aucune commande et n'enchaîne aucun maillon de toi-même : la chaîne est pilotée par le lot.
- Le contrat de cette feature vit dans .omp/pipeline/contract.md, relatif à ton répertoire de travail.`;

/** La graine d'un maillon : les quatre existantes, plus la livraison. */
function phaseSeed(input: { phase: PipelinePhase; slug: string; fix: boolean; focus: string }): string {
  switch (input.phase) {
    case "specs":
      return buildSpecsSeed(input.focus);
    case "impl":
      return buildImplSeed(input.focus, input.fix);
    case "review":
      return buildReviewSeed(input.focus);
    case "release":
      return buildReleaseSeed({ slug: input.slug, branch: branchFor(input.slug) });
    case "req":
      return `[req] Collecte des besoins de la feature « ${input.slug} ».`;
  }
}

/**
 * Le prompt d'un run (S-13). `collecte` est préfixé `[req]` : le préambule d'un
 * run n'est pas une entrée de l'utilisateur, et le détecteur de clôture
 * (`saysFin`) ne doit jamais s'y appliquer — seule une réponse tapée par
 * l'utilisateur clôt une collecte.
 */
export function buildLotPrompt(input: {
  kind: LotPromptKind;
  phase: PipelinePhase;
  slug: string;
  description?: string;
  text?: string;
  focus?: string;
  fix?: boolean;
}): string {
  const seed = phaseSeed({ phase: input.phase, slug: input.slug, fix: input.fix === true, focus: input.focus ?? "" });
  if (input.kind === "collecte") {
    const intent = (input.description ?? "").trim();
    return `[req] Feature « ${input.slug} »${intent ? ` — intention déclarée : ${intent}` : ""}\n\n${LOT_WORKER_DIRECTIVE}`;
  }
  if (input.kind === "answer") {
    return (
      `[réponse de l'utilisateur] ${(input.text ?? "").trim()}\n\n` +
      `Maillon courant : /${input.phase}. Lis le contrat .omp/pipeline/contract.md pour l'état de la feature.\n\n` +
      LOT_WORKER_DIRECTIVE
    );
  }
  if (input.kind === "relaunch") {
    return (
      "[reprise] Le maillon est relancé par l'utilisateur : reprends où tu t'es arrêté, " +
      `sans élargir le périmètre.\n\n${seed}\n\n${LOT_WORKER_DIRECTIVE}`
    );
  }
  return `${seed}\n\n${LOT_WORKER_DIRECTIVE}`;
}

/**
 * Dernière ligne non vide d'un texte : la plus informative d'un échec de
 * commande, et la raison consignée dans le lot.
 */
export function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 ? (lines[lines.length - 1] as string) : "";
}

// --- la livraison : un run d'agent, puis deux commandes mécaniques (S-6/BR-7) -

/**
 * La directive du maillon `release`. L'agent prépare le commit et le corps de la
 * PR ; le PILOTE pousse et ouvre la PR (URL HTTPS + `gh`, cf. `## Documentation`
 * §4 et §5) — parce que ces deux étapes doivent être déterministes, et parce que
 * le chemin de poussée de cette machine passe par le token de `gh`, jamais par
 * une clé SSH.
 */
export const RELEASE_DIRECTIVE = `Tu es l'agent de livraison. La revue est propre et l'utilisateur a accepté la fin du cycle : tu prépares le commit et le corps de la PR. Le pilotage du lot poussera la branche et ouvrira la PR juste après toi.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat .omp/pipeline/contract.md : Besoins (B-<n>), Critères d'acceptation (AC-<n>), Spécifications (S-<n>), Lots (BR-<n>) et le verdict de \`## Revue\`. Si \`## Revue\` est absente ou consigne des BLOQUANTS, ARRÊTE-toi et dis-le : il n'y a rien à livrer.
2. \`git status --porcelain\`. Si l'arbre est VIDE, la feature est déjà commitée : ne recommite pas (idempotence) et passe à l'étape 5.
3. Sinon, fais UN SEUL commit avec tout le travail de la feature (\`git add -A\` puis \`git commit\`). Message en français, conventionnel : un titre \`type(scope): sujet\` (les scopes nomment les composants touchés ; les versions livrées vont entre parenthèses si tu en bumpes), puis un corps qui porte la cause racine, les décisions et leurs raisons, les preuves réellement exécutées avec leurs chiffres, les versions bumpées et le verdict de revue. N'invente aucune preuve : reprends celles du contrat et des commandes que tu as lancées.
4. Bumpe les versions SI ET SEULEMENT SI la feature modifie un plugin du dépôt : les QUATRE fichiers alignés (les deux package.json et les deux catalogues, identiques octet pour octet — règle de PUBLISHING.md, section « Mettre à jour »). Si tu bumpes après avoir commité, refais un commit unique : un seul commit par feature.
5. Écris le corps de la PR dans .omp/pipeline/pr-body.md : le résumé de la feature (ses besoins), la liste des critères d'acceptation avec la preuve de chacun (fichier de test), les décisions techniques notables et le verdict de revue. Ce fichier est ignoré par git : il ne doit pas entrer dans le commit.
6. NE POUSSE PAS et N'OUVRE PAS de PR : le pilotage du lot s'en charge (\`git push\` vers l'URL HTTPS, puis \`gh pr create\`). N'appelle ni l'un ni l'autre.
7. Termine par exactement une ligne : \`commit <sha> — <sujet du commit>\`.`;

export function buildReleaseSeed(feature: { slug: string; branch: string }): string {
  return (
    `[release] Livraison de la feature « ${feature.slug} » (branche ${feature.branch}).\n\n` + RELEASE_DIRECTIVE
  );
}

export type ReleaseTarget = { pushUrl: string | null; base: string | null };

/** `gh repo view --json url,defaultBranchRef` → URL HTTPS de push et base de PR. */
export function releaseTarget(raw: unknown): ReleaseTarget {
  if (!raw || typeof raw !== "object") return { pushUrl: null, base: null };
  const rec = raw as Record<string, unknown>;
  const url =
    typeof rec.url === "string" && rec.url.startsWith("https://") ? `${rec.url.replace(/\.git$/, "")}.git` : null;
  const ref = rec.defaultBranchRef;
  const base =
    ref && typeof ref === "object" && typeof (ref as Record<string, unknown>).name === "string"
      ? String((ref as Record<string, unknown>).name)
      : null;
  return { pushUrl: url, base };
}

/** Les deux commandes mécaniques de la livraison, dans l'ordre (S-6). */
export function releaseArgs(input: {
  pushUrl: string;
  branch: string;
  base: string;
  title: string;
  bodyFile?: string | null;
  body?: string | null;
}): { push: string[]; pr: string[] } {
  const pr = ["pr", "create", "-B", input.base, "-H", input.branch, "-t", input.title];
  if (input.bodyFile) pr.push("-F", input.bodyFile);
  else pr.push("-b", input.body ?? "");
  return { push: ["push", "-u", input.pushUrl, input.branch], pr };
}

/** L'URL de PR imprimée par `gh pr create` sur stdout (`## Documentation` §4). */
export function parsePrUrl(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const m = /^(https:\/\/\S*\/pull\/\d+)$/.exec(line.trim());
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * L'URL de la PR d'une branche, lue dans la charge de `gh pr view <branche> --json
 * url` (S-6). C'est une forme DIFFÉRENTE de celle de `gh pr create` : du JSON
 * (`{"url":"https://…/pull/<n>"}`) et non l'URL nue — la reprise après un push
 * réussi lit celle-ci (`parsePrUrl` seul n'y reconnaît rien).
 */
export function prUrlOfView(stdout: string): string | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const url = raw && typeof raw === "object" ? (raw as Record<string, unknown>).url : null;
  return typeof url === "string" ? parsePrUrl(url) : null;
}

// --- annulation : le devenir du worktree (S-9) -------------------------------

export type WorktreeFate = "keep" | "archive" | "delete";
export type FateResult = { ok: true; message: string } | { ok: false; message: string };

/** Chemins ignorés par git (lignes `!! …`) d'un `git status --porcelain --ignored`. */
export function ignoredPaths(statusOutput: string): string[] {
  const out: string[] = [];
  for (const line of statusOutput.split("\n")) {
    if (!line.startsWith("!! ")) continue;
    const rel = line.slice(3).trim();
    if (rel !== "" && rel !== ".git" && !rel.startsWith(".git/")) out.push(rel);
  }
  return out;
}

/**
 * Applique le devenir choisi pour le worktree d'une feature annulée (AC-14) :
 * `keep` ne touche à rien, `archive` copie d'abord les fichiers IGNORÉS (le
 * contrat, les caches locaux) dans l'archive du dépôt puis retire le worktree,
 * `delete` retire directement. Dans les deux derniers cas les modifications non
 * commitées sont perdues — le libellé du choix le dit — et la branche reste.
 */
export async function applyWorktreeFate(input: {
  fate: WorktreeFate;
  feature: { slug: string; branch: string; worktree: string };
  repoRoot: string;
  archiveBase: string;
  currentCwd: string;
  run: GitRunner;
}): Promise<FateResult> {
  const { fate, feature, repoRoot, archiveBase, currentCwd, run } = input;
  const worktree = realpathOr(feature.worktree);
  const branchKept = `branche ${feature.branch} conservée`;
  if (fate === "keep") return { ok: true, message: `worktree conservé en place : ${worktree} (${branchKept})` };
  if (!fs.existsSync(worktree)) {
    return { ok: true, message: `worktree introuvable — rien à retirer (${branchKept})` };
  }
  const cwd = realpathOr(currentCwd);
  if (cwd === worktree || isUnder(cwd, worktree)) {
    return { ok: true, message: `worktree de la session courante — conservé (${branchKept})` };
  }
  // Un worktree en HEAD détaché n'est plus celui de la branche annoncée : le
  // retirer avec `--force` perdrait les modifications d'une autre branche — même
  // règle que `reapDecision` (S-9).
  const head = await run(["rev-parse", "--abbrev-ref", "HEAD"], worktree);
  if (head.code === 0 && head.stdout.trim() === "HEAD") {
    return { ok: true, message: `worktree en HEAD détaché — conservé (${branchKept})` };
  }
  let archived: string | null = null;
  if (fate === "archive") {
    const status = await run(["status", "--porcelain", "--ignored"], worktree);
    if (status.code !== 0) {
      return { ok: false, message: `lecture des fichiers ignorés refusée : ${lastLine(status.stderr)}` };
    }
    archived = worktreePathFor(archiveBase, repoRoot, feature.slug);
    try {
      for (const rel of ignoredPaths(status.stdout)) {
        fs.cpSync(path.join(worktree, rel), path.join(archived, rel), { recursive: true });
      }
    } catch (err) {
      return { ok: false, message: `archivage impossible : ${(err as Error).message}` };
    }
  }
  const removed = await run(["worktree", "remove", "--force", worktree], repoRoot);
  if (removed.code !== 0) {
    return { ok: false, message: `retrait du worktree refusé : ${lastLine(removed.stderr)}` };
  }
  return {
    ok: true,
    message: archived
      ? `worktree archivé dans ${archived} puis retiré (${branchKept})`
      : `worktree retiré : ${worktree} (${branchKept})`,
  };
}

// --- mode worker : l'enfant ne décide de rien (S-13) -------------------------

export type WorkerMode = { lotId: string; slug: string; phase: PipelinePhase; stateDir: string | null };
export type FlagReader = { getFlag?: (name: string) => boolean | string | undefined };

/**
 * Les quatre drapeaux d'un run de lot, relus par l'enfant au démarrage. `null`
 * hors d'un run : la session est une session ordinaire, avec ses commandes et ses
 * jalons (un drapeau inconnu du CLI étant une erreur dure, ils sont déclarés au
 * chargement — cf. `## Documentation` §2).
 */
export function workerModeOf(pi: FlagReader): WorkerMode | null {
  if (typeof pi.getFlag !== "function") return null;
  const lotId = pi.getFlag("pipeline-lot");
  const slug = pi.getFlag("pipeline-feature");
  const phase = pi.getFlag("pipeline-phase");
  if (typeof lotId !== "string" || lotId === "") return null;
  if (typeof slug !== "string" || slug === "") return null;
  if (typeof phase !== "string" || !PIPELINE_PHASES.includes(phase as PipelinePhase)) return null;
  const dir = pi.getFlag("pipeline-state-dir");
  return {
    lotId,
    slug,
    phase: phase as PipelinePhase,
    stateDir: typeof dir === "string" && path.isAbsolute(dir) ? dir : null,
  };
}

/** La session du dernier run d'un cwd : celle qu'on reprend pour répondre (AC-12). */
export function latestSessionFile(stateDir: string, cwd: string, sinceMs: number): string | null {
  const real = realpathOr(cwd);
  const snapshot = readStore(stateDir);
  const candidates: Array<{ file: string; at: number }> = [];
  for (const entry of snapshot.running) {
    if (entry.sessionFile && realpathOr(entry.cwd) === real && entry.updatedAt >= sinceMs) {
      candidates.push({ file: entry.sessionFile, at: entry.updatedAt });
    }
  }
  for (const entry of snapshot.history) {
    if (entry.sessionFile && realpathOr(entry.cwd) === real && entry.endedAt >= sinceMs) {
      candidates.push({ file: entry.sessionFile, at: entry.endedAt });
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0]?.file ?? null;
}

/** La racine du dépôt vue depuis `cwd` : le dépôt principal si `cwd` est un worktree. */
export function repoRootOf(cwd: string): string {
  const root = resolveFeatureRoot(cwd);
  return root.primary ?? root.dir;
}

/**
 * Le lot qui pilote encore `cwd` (`null` sinon) : c'est lui qui interdit aux
 * commandes manuelles de réécrire le contrat d'une feature (S-14).
 *
 * Ne compte PAS comme pilotée : la collecte d'une feature ouverte par /req (elle
 * appartient à la session de l'utilisateur), une feature terminale, et une feature
 * dont le lot n'a plus de pilote vivant (l'utilisateur reprend alors à la main).
 */
export function lotDriverFor(stateDir: string, repoRoot: string, cwd: string): Lot | null {
  const lot = readLot(stateDir, lotRepoKey(repoRoot));
  if (!lot) return null;
  const feature = lot.features.find((f) => realpathOr(f.worktree) === realpathOr(cwd));
  if (!feature) return null;
  if (feature.origin === "session" && feature.phase === "req") return null;
  if (lotStateTerminal(feature.state)) return null;
  return pidAlive(lot.owner.pid) ? lot : null;
}

/**
 * Bascule la collecte d'une feature de lot vers le pilote (S-14) : la feature
 * passe au maillon `specs`, en cours, et cette session devient propriétaire du lot
 * (sans quoi la passe du pilote qu'elle vient d'armer refuserait de le conduire).
 * Rend `true` quand la main a été passée — la session de l'utilisateur n'annonce
 * alors plus rien.
 *
 * Un lot conduit par un process VIVANT étranger n'est jamais réécrit ici (S-1,
 * invariant 2) : la bascule n'a pas lieu et la chaîne reste manuelle. Une écriture
 * impossible est signalée par la notice durable de `reportStateWriteFailure` — la
 * bascule n'a pas eu lieu non plus, et l'utilisateur l'apprend au lieu de rester
 * avec une feature figée `req`/en cours, que plus aucune passe ne relèverait.
 */
export function handOverCollecte(input: {
  stateDir: string;
  repoRoot: string;
  cwd: string;
  contract: string;
  sessionFile: string | null;
  now?: number;
  notify?: (text: string) => void;
}): boolean {
  if (!contractHasSection(input.contract, "Besoins")) return false;
  const lot = readLot(input.stateDir, lotRepoKey(input.repoRoot));
  if (!lot) return false;
  if (lot.owner.pid !== process.pid && pidAlive(lot.owner.pid)) return false;
  const feature = lot.features.find(
    (f) => f.origin === "session" && f.phase === "req" && realpathOr(f.worktree) === realpathOr(input.cwd),
  );
  if (!feature || lotStateTerminal(feature.state)) return false;
  const at = input.now ?? Date.now();
  feature.phase = "specs";
  feature.state = "running";
  feature.waitKind = null;
  feature.waitPrompt = null;
  feature.stopReason = null;
  feature.sessionFile = input.sessionFile ?? feature.sessionFile;
  feature.sinceAt = at;
  feature.updatedAt = at;
  lot.owner = { pid: process.pid, sessionFile: feature.sessionFile, sessionId: lot.owner.sessionId };
  try {
    writeLot(input.stateDir, lot);
  } catch (err) {
    // Une écriture impossible ne casse jamais un tour : l'erreur est avalée et
    // signalée au plus une fois par session (S-1, cas limites). La bascule, elle,
    // n'a PAS eu lieu : l'appelant garde l'annonce de la chaîne manuelle.
    reportStateWriteFailure({ notify: input.notify, stateDir: input.stateDir }, err);
    return false;
  }
  return true;
}

// --- le pilote : une passe = lire, décider, lancer (S-2, S-4, S-11) ----------

export type AddFeatureInput = { name: string; description: string; deps: string[] };

/** Ce que le panneau demande au pilote : chaque refus rend son motif, jamais une exception. */
export type LotPanelActions = {
  add(input: AddFeatureInput): Promise<string | null>;
  launch(): Promise<string | null>;
  remove(slug: string): Promise<string | null>;
  answer(slug: string, text: string): Promise<string | null>;
  validate(slug: string): Promise<string | null>;
  accept(slug: string): Promise<string | null>;
  relaunch(slug: string): Promise<string | null>;
  cancel(slug: string, fate: WorktreeFate): Promise<string | null>;
};

export type LotControllerDeps = {
  stateDir: string;
  repoRoot: string;
  run: LotRunner;
  runGit: GitRunner;
  /** `gh`, pour l'URL du dépôt et la PR. Absent ⇒ la livraison est bloquée, sans exception. */
  runGh?: (args: string[], cwd: string) => Promise<GitResult>;
  notify?: (text: string) => void;
  toast?: (text: string, type: "info" | "warning" | "error") => void;
  /** La session du pilote : publiée comme propriétaire (diagnostic et reprise). */
  session?: () => { file: string | null; id: string | null };
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => () => void;
  worktreesBase?: string;
  archiveBase?: string;
  ompBin?: string;
  selfPath?: string | null;
  reviewCap?: number;
  runTimeoutMs?: number;
};

export type LotController = LotPanelActions & {
  read(): Lot | null;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  adopt(): boolean;
  /** Inscription d'une feature créée par /req (sa collecte se déroule en session). Rend le motif d'un refus. */
  enrol(input: { slug: string; name: string; branch: string; worktree: string }): string | null;
};

type PlannedLaunch = { slug: string; phase: PipelinePhase; fix: boolean; kind: LotPromptKind; text?: string; resume: boolean };

/**
 * Le pilote d'un dépôt. Il lit le lot, décide (`nextChainAction`), lance des runs
 * et se réécrit propriétaire. Deux règles structurent tout le reste : un run
 * n'est JAMAIS attendu dans une passe (l'isolation de B-5 tient à ça), et une
 * feature ne bouge que par sa propre entrée — aucune transition ne touche deux
 * features à la fois.
 */
export function createLotController(deps: LotControllerDeps): LotController {
  const { stateDir } = deps;
  const repoKey = lotRepoKey(deps.repoRoot);
  const repo = path.basename(realpathOr(deps.repoRoot)) || realpathOr(deps.repoRoot);
  const now = () => (deps.now ?? Date.now)();
  const cap = deps.reviewCap ?? lotReviewCap();
  const runTimeout = deps.runTimeoutMs ?? lotRunTimeoutMs();
  const ompBin = deps.ompBin ?? lotOmpBin();
  const worktreesBase = deps.worktreesBase ?? worktreesBaseDir();
  const archiveBase = deps.archiveBase ?? lotArchiveBaseDir();
  const inFlight = new Map<string, AbortController>();
  /**
   * Ce que CE pilote sait des runs : `inflight` pendant, `settled` quand la fin a
   * été traitée. C'est ce qui distingue « le maillon n'a jamais tourné » (bascule
   * d'une collecte en session, feature reprise par un autre pilote) de « le run a
   * fini et la chaîne a déjà décidé » — un état purement local, qui ne se confond
   * pas avec l'absence de contrat.
   */
  const watched = new Map<string, "inflight" | "settled">();
  /**
   * Les annulations en cours. Une annulation laisse au run qu'elle tue jusqu'à 10 s
   * pour rendre la main (S-9) : la fin de ce run ne doit donc pas marquer la
   * feature `failed` pendant cette attente — c'est l'annulation qui décide de son
   * sort, et une feature que l'utilisateur annule ne doit pas finir « échouée ».
   */
  const cancelling = new Set<string>();
  let stopLoop: (() => void) | null = null;
  /** La file des passes : une seule à la fois, aucune perdue (cf. `tick`). */
  let tickQueue: Promise<void> = Promise.resolve();
  /** Une seule notice pour un lot qu'un autre process conduit (S-1). */
  let foreignOwnerWarned = false;

  const read = () => readLot(stateDir, repoKey);
  const notify = (text: string) => {
    try {
      deps.notify?.(text);
    } catch {
      /* une notice ne casse jamais un tour */
    }
  };

  /** Le motif d'un refus d'écriture, mot pour mot le même que celui d'`open`. */
  const foreignOwnerReason = (pid: number) => `le lot est piloté par une autre session (pid ${pid})`;

  /**
   * Le pid étranger VIVANT qui conduit ce lot sur le DISQUE, ou `null`. Le pid
   * mort n'est pas un obstacle : c'est la reprise admise (S-1).
   */
  function foreignOwner(): number | null {
    const onDisk = read();
    if (!onDisk || onDisk.owner.pid === process.pid) return null;
    return pidAlive(onDisk.owner.pid) ? onDisk.owner.pid : null;
  }

  /** Un refus d'écriture est dit UNE fois par session — le toast disparaîtrait. */
  function reportForeignOwner(pid: number): void {
    if (foreignOwnerWarned) return;
    foreignOwnerWarned = true;
    notify(`[pipeline] lot ${repo} : ${foreignOwnerReason(pid)} — rien ne lui a été écrit`);
  }

  /**
   * Écrit le lot ENTIER : l'objet passé doit donc venir d'une lecture qui n'a
   * aucun `await` d'écart avec cette écriture (S-1, « un seul écrivain »).
   * La passe sépare pour cela sa phase d'attente (les worktrees) de sa phase de
   * décision, `finishRun` et `finishRelease` ne mutent qu'une relecture, et les
   * actions du panneau — qui attendent `git`, `gh` ou la mort d'un run (jusqu'à
   * 10 s pour une annulation) — relisent le lot APRÈS leur attente, avant de
   * muter. Un lot périmé réécrit ici effacerait les transitions écrites
   * entre-temps : une feature reviendrait au maillon précédent, sa fin de run
   * serait ignorée et elle resterait `running` sans run, sans alerte, hors de
   * portée du panneau (AC-2, AC-19).
   *
   * Le propriétaire est revérifié ICI, sur le disque, quel que soit le chemin qui
   * écrit : un lot conduit par un process VIVANT étranger n'est JAMAIS réécrit
   * (S-1, invariant 2). Sans cette garde, un `/req` d'une seconde session — ou une
   * écriture qui a attendu pendant qu'un autre pilote reprenait le lot — en
   * ferait le propriétaire : deux pilotes sur le même lot, les transitions du
   * premier jetées par la garde de sa passe, et deux runs concurrents dans le
   * même worktree. Un propriétaire MORT ne s'oppose à rien (c'est la reprise) :
   * `adopt`, `open` et `lotForAdd` écrivent après l'avoir constaté.
   *
   * Rend `null` quand le lot a été écrit, sinon le motif du refus — jamais une
   * exception.
   */
  function save(lot: Lot): string | null {
    const foreign = foreignOwner();
    if (foreign !== null) {
      reportForeignOwner(foreign);
      return foreignOwnerReason(foreign);
    }
    const session = deps.session?.() ?? { file: null, id: null };
    lot.owner = { pid: process.pid, sessionFile: session.file, sessionId: session.id };
    try {
      writeLot(stateDir, lot);
    } catch (err) {
      // Même garantie que pour le magasin : avalée, et signalée AU PLUS UNE FOIS
      // par session (le drapeau est celui de `reportStateWriteFailure`).
      reportStateWriteFailure({ notify: deps.notify, stateDir }, err);
      return `écriture du lot impossible : ${err instanceof Error ? err.message : String(err)}`;
    }
    return null;
  }

  /** Entrée dans un nouvel état : `sinceAt` et `updatedAt` avancent ensemble. */
  function touch(feature: LotFeature, at: number): number {
    feature.sinceAt = at;
    feature.updatedAt = at;
    return at;
  }

  /** Une transition qui appelle l'utilisateur est annoncée UNE fois (AC-11). */
  function emit(lot: Lot, feature: LotFeature, before: LotFeatureState): void {
    if (before === feature.state) return;
    const alert = buildLotAlert(repo, feature);
    if (!alert) return;
    notify(alert.text);
    try {
      // Le MÊME texte que le message durable (S-8) : le toast est la visibilité
      // immédiate, et le prompt d'un run est repris en entier.
      deps.toast?.(alert.text, alert.tone);
    } catch {
      /* un toast raté n'a aucune conséquence : le message durable est posté */
    }
  }

  function settle(lot: Lot, feature: LotFeature, state: "blocked" | "failed", reason: string): void {
    const before = feature.state;
    feature.state = state;
    feature.stopReason = reason;
    feature.waitKind = null;
    feature.waitPrompt = null;
    feature.endedAt = touch(feature, now());
    emit(lot, feature, before);
  }

  function freshLot(): Lot {
    const at = now();
    return {
      version: LOT_VERSION,
      id: repoKey,
      repoRoot: realpathOr(deps.repoRoot),
      status: "draft",
      reviewCap: cap,
      recapAt: null,
      owner: { pid: process.pid, sessionFile: null, sessionId: null },
      createdAt: at,
      launchedAt: null,
      features: [],
    };
  }

  /**
   * Le lot prêt à recevoir une nouvelle feature, RELU à l'instant de l'écriture :
   * propriété (refus si un autre pilote vit, reprise s'il est mort), remplacement
   * d'un lot dont plus rien ne tourne (le récap a déjà été posté), puis les
   * validations de S-3 — dans cet ordre, sans rien créer. Rend le motif du refus,
   * ou le lot et ses dépendances normalisées.
   *
   * `add` l'appelle DEUX fois — avant et après l'attente de `branchTaken` : la
   * première passe rend le bon motif tout de suite (l'ordre de S-3), la seconde
   * est celle qui écrit.
   */
  function lotForAdd(slug: string, depsRaw: string[]): { lot: Lot; deps: string[] } | string {
    const existing = read();
    if (existing && existing.owner.pid !== process.pid) {
      if (pidAlive(existing.owner.pid)) return foreignOwnerReason(existing.owner.pid);
      const refusal = save(existing);
      if (refusal) return refusal;
      start();
    }
    const lot = !existing || (existing.features.length > 0 && lotTotals(existing).live === 0) ? freshLot() : existing;
    if (lotFeature(lot, slug)) return `« ${slug} » est déjà dans le lot`;
    const deps: string[] = [];
    for (const raw of depsRaw) {
      // Un slug non normalisable n'est jamais dans le lot : il tombe donc dans
      // le même refus que la dépendance absente (S-3), sans message de plus.
      const dep = toSlug(raw) ?? raw.trim();
      if (dep === slug) return `dépendance circulaire : ${slug}`;
      if (!lotFeature(lot, dep)) return `dépendance inconnue : ${dep}`;
      deps.push(dep);
    }
    return { lot, deps };
  }

  function startRun(lot: Lot, feature: LotFeature, launch: PlannedLaunch): void {
    const prompt = buildLotPrompt({
      kind: launch.kind,
      phase: launch.phase,
      slug: feature.slug,
      description: feature.name,
      text: launch.text,
      fix: launch.fix,
    });
    const sessionFile = launch.resume ? feature.sessionFile : null;
    const argv = buildLotRunArgv({
      ompBin,
      worktree: feature.worktree,
      prompt,
      lotId: lot.id,
      slug: feature.slug,
      phase: launch.phase,
      stateDir,
      sessionFile,
      selfPath: deps.selfPath ?? selfExtensionArg(SELF_MODULE_URL),
    });
    const abort = new AbortController();
    inFlight.set(feature.slug, abort);
    watched.set(feature.slug, "inflight");
    // Le hash du contrat est figé AVANT le lancement, et ÉCRIT avant lui (S-1) :
    // c'est le seul indice dont disposera un pilote qui reprend un run interrompu
    // pour juger si le maillon a travaillé. Les appelants ont déjà sauvegardé leur
    // état, donc cette écriture est la leur, augmentée du hash — la poser après
    // leur sauvegarde (comme avant) la laissait en mémoire et jamais sur le disque.
    // `""` note « aucun contrat au démarrage », à distinguer de `null` : « aucun
    // run n'a été lancé pour cette feature » (bascule d'une collecte, S-14).
    feature.contractHash = contractHashOf(feature.worktree) ?? "";
    // Le lot n'est pas écrit (propriétaire étranger vivant, écriture impossible) :
    // aucun run ne part — un maillon lancé sans que son lot le sache serait un
    // processus orphelin, dans un worktree que le véritable pilote conduit. Le
    // suivi en mémoire est DÉFAIT avec lui : `inFlight` retenu sans run ferait
    // sauter la feature à toutes les passes (`inFlight.has`), donc rester `running`
    // sur le disque sans run et sans réconciliation — la classe de défaut qu'AC-19
    // interdit.
    if (save(lot) !== null) {
      inFlight.delete(feature.slug);
      watched.delete(feature.slug);
      return;
    }
    const startedAt = now();
    // `deps.run` peut jeter AVANT de rendre sa promesse (argv inexploitable,
    // spawn refusé) : l'échec appartient alors à CETTE feature, jamais à la passe.
    let launched: Promise<LotRunnerResult>;
    try {
      launched = Promise.resolve(
        deps.run({ argv, cwd: feature.worktree, timeout: runTimeout, signal: abort.signal }),
      );
    } catch (err) {
      launched = Promise.reject(err);
    }
    void launched
      .catch((err: unknown) => ({
        code: 127,
        killed: false,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      }))
      .then((result: LotRunnerResult) => finishRun(feature.slug, launch.phase, result, startedAt));
  }

  /** La raison consignée quand un run ne rend pas `ok` (S-4). */
  function failureReason(result: LotRunnerResult): string {
    if (result.killed) return `délai dépassé (${Math.round(runTimeout / 60_000)} min)`;
    if (result.code === 127) return "binaire omp introuvable (code 127)";
    // 200 caractères : un motif de panne tient dans une ligne de panneau et dans
    // une alerte ; une trace entière n'y tient pas et noierait le reste.
    const reason = lastLine(result.stderr) || lastLine(result.stdout) || `sortie non nulle (code ${result.code})`;
    return reason.length > LOT_REASON_MAX ? `${reason.slice(0, LOT_REASON_MAX - 1)}…` : reason;
  }

  /** Le run a rendu la main : la chaîne décide de la suite, pour CETTE feature. */
  function finishRun(slug: string, phase: PipelinePhase, result: LotRunnerResult, startedAt: number): void {
    inFlight.delete(slug);
    watched.set(slug, "settled");
    // Une annulation en cours décide SEULE du sort de sa feature (S-9) : le run
    // qu'elle vient de tuer ne la marque pas `failed`.
    if (cancelling.has(slug)) return;
    const lot = read();
    if (!lot) return;
    if (lot.owner.pid !== process.pid) return; // un autre pilote a repris : ne rien écrire
    const feature = lotFeature(lot, slug);
    if (!feature || feature.state !== "running" || feature.phase !== phase) return;
    const outcome: ChainOutcome = result.code === 0 && !result.killed ? "ok" : "error";
    if (outcome === "ok") {
      // La session du run sert à répondre (AC-12) et à rejoindre la ligne.
      const session = latestSessionFile(stateDir, feature.worktree, startedAt);
      if (session) feature.sessionFile = session;
    }
    const routed = route(lot, feature, { outcome, stdout: result.stdout, reason: failureReason(result) });
    // Rien n'a été écrit : la chaîne ne part pas, et le marqueur `settled` est
    // retiré — sans lui, la passe croirait la fin de ce run déjà traitée et
    // laisserait la feature `running` sans run, alors que la réconciliation par
    // le hash du contrat (S-1) saurait, elle, décider (reprise ou `failed`
    // relançable).
    if (save(lot) !== null) {
      watched.delete(slug);
      return;
    }
    for (const launch of routed.launches) startRun(lot, feature, launch);
    if (routed.release) void finishRelease(feature);
    void Promise.resolve().then(() => tick().catch(() => undefined));
  }

  /**
   * Applique la décision de la chaîne à UNE feature et rend ce qu'il reste à
   * faire APRÈS la sauvegarde : les runs à lancer et, pour la livraison, les deux
   * commandes mécaniques. Rien n'est lancé ici : un run qui rend la main aussitôt
   * écrirait sa transition sur un lot plus vieux que celui qu'on vient de calculer.
   */
  function route(
    lot: Lot,
    feature: LotFeature,
    result: { outcome: ChainOutcome; stdout: string; reason: string },
  ): { launches: PlannedLaunch[]; release: boolean } {
    const out: { launches: PlannedLaunch[]; release: boolean } = { launches: [], release: false };
    const before = feature.state;
    const contract = readContractText(feature.worktree);
    const action = nextChainAction({
      phase: feature.phase,
      outcome: result.outcome,
      contract,
      fixes: feature.fixes,
      reviewRuns: feature.reviewRuns,
      // Le plafond est celui FIGÉ dans le lot au premier lancement (S-5) : un
      // pilote qui reprend le lot avec un autre environnement ne doit pas
      // changer la borne en cours de route.
      cap: lot.reviewCap,
    });
    if (action.kind === "run") {
      feature.fixes += action.fix ? 1 : 0;
      feature.reviewRuns += action.phase === "review" ? 1 : 0;
      feature.phase = action.phase;
      feature.state = "running";
      feature.waitKind = null;
      feature.waitPrompt = null;
      feature.stopReason = null;
      feature.endedAt = null;
      touch(feature, now());
      out.launches.push({
        slug: feature.slug,
        phase: action.phase,
        fix: action.fix,
        kind: "phase",
        resume: false,
      });
      return out;
    }
    if (action.kind === "wait") {
      feature.state = "waiting";
      feature.waitKind = action.waitKind;
      feature.waitPrompt = action.waitKind === "answer" ? clipTail(result.stdout.trim(), LOT_WAIT_PROMPT_MAX) || null : null;
      feature.stopReason = null;
      feature.endedAt = null;
      touch(feature, now());
      emit(lot, feature, before);
      return out;
    }
    if (action.kind === "failed") {
      settle(lot, feature, "failed", result.reason || action.reason);
      return out;
    }
    if (action.kind === "blocked") {
      settle(lot, feature, "blocked", action.reason);
      return out;
    }
    // `done` : la seule route qui y mène est la fin d'un run de livraison — les
    // deux commandes mécaniques restent à passer (elles sont asynchrones).
    out.release = true;
    return out;
  }

  /**
   * Les deux commandes de la livraison (S-6) : pousser vers l'URL HTTPS du dépôt
   * puis ouvrir la PR avec `gh`, dont la sortie porte l'URL. Tout échec rend la
   * feature `blocked` avec le motif de la commande — jamais un demi-succès.
   *
   * Cette étape ATTEND (git, gh, plusieurs secondes) : elle réapplique donc son
   * seul changement sur une lecture FRAÎCHE du lot, pour ne rien écraser des
   * transitions qui auraient eu lieu entre-temps — et si la feature a été
   * annulée ou relancée pendant l'attente, elle ne touche plus à rien.
   */
  async function finishRelease(feature: LotFeature): Promise<void> {
    const commit = (state: "blocked" | "done", prUrl: string | null, reason: string | null) => {
      const fresh = read();
      // Le lot peut avoir changé de main pendant les attentes (git, gh) : la
      // transition n'est écrite — et annoncée — que si CE pilote le conduit encore
      // (S-1). `emit` avant la garde aurait annoncé un état que personne n'écrit.
      if (!fresh || fresh.owner.pid !== process.pid) return;
      const target = lotFeature(fresh, feature.slug);
      if (!target || target.state !== "running") return;
      const before = target.state;
      target.state = state;
      target.prUrl = prUrl;
      target.stopReason = reason;
      target.waitKind = null;
      target.waitPrompt = null;
      target.endedAt = touch(target, now());
      emit(fresh, target, before);
      maybeRecap(fresh);
      save(fresh);
    };
    const fail = (reason: string) => commit("blocked", null, reason);
    const gh = deps.runGh;
    if (!gh) {
      fail("gh introuvable — installe GitHub CLI puis relance la livraison");
      return;
    }
    const view = await gh(["repo", "view", "--json", "url,defaultBranchRef"], feature.worktree);
    if (view.code !== 0) {
      // `pi.exec` JETTE quand le binaire est absent (spawn ENOENT) ; le runner
      // câblé en production le mappe en `code 127`. C'est LE signal d'un `gh`
      // absent du PATH : s'en remettre au seul `deps.runGh` manquant rendait ce
      // libellé inatteignable hors des tests, et une machine sans GitHub CLI
      // lisait `gh indisponible : spawn gh ENOENT` au lieu de la marche à suivre.
      // Un dépassement de délai (`killed`, code 124) n'est PAS un binaire absent :
      // il garde son motif, qui dit la vérité.
      fail(
        view.code === 127
          ? "gh introuvable — installe GitHub CLI puis relance la livraison"
          : `gh indisponible : ${lastLine(view.stderr) || `code ${view.code}`}`,
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(view.stdout);
    } catch {
      parsed = null;
    }
    const target = releaseTarget(parsed);
    if (!target.pushUrl) {
      fail("URL HTTPS du dépôt introuvable (gh repo view)");
      return;
    }
    const subject = await deps.runGit(["log", "-1", "--format=%s"], feature.worktree);
    const title = subject.code === 0 && subject.stdout.trim() !== "" ? subject.stdout.trim() : feature.branch;
    const bodyFile = path.join(contractPathFor(feature.worktree), "..", "pr-body.md");
    const body = await deps.runGit(["log", "-1", "--format=%b"], feature.worktree);
    const args = releaseArgs({
      pushUrl: target.pushUrl,
      branch: feature.branch,
      base: target.base ?? "main",
      title,
      bodyFile: fs.existsSync(bodyFile) ? bodyFile : null,
      body: lastLine(body.stdout),
    });
    const push = await deps.runGit(args.push, feature.worktree);
    if (push.code !== 0) {
      fail(`push refusé : ${lastLine(push.stderr) || `code ${push.code}`}`);
      return;
    }
    const pr = await gh(args.pr, feature.worktree);
    let url = parsePrUrl(pr.stdout);
    if (pr.code !== 0 && !url) {
      // Une PR peut déjà exister (relance après un push réussi) : la retrouver
      // plutôt que de la déclarer manquante. `gh pr view --json url` imprime du
      // JSON — c'est `prUrlOfView` qui le lit, pas `parsePrUrl`.
      const existing = await gh(["pr", "view", feature.branch, "--json", "url"], feature.worktree);
      url = existing.code === 0 ? prUrlOfView(existing.stdout) : null;
      if (!url) {
        fail(`PR non créée : ${lastLine(pr.stderr) || `code ${pr.code}`}`);
        return;
      }
    }
    commit("done", url, null);
  }

  /** Le worktree d'une feature, créé au moment où elle démarre (S-2). */
  async function ensureWorktree(feature: LotFeature): Promise<string | null> {
    if (feature.worktree !== "") {
      if (!fs.existsSync(feature.worktree)) return "worktree introuvable sur le disque";
      // Un arbre sur disque n'est pas forcément celui de la branche annoncée :
      // relancer dessus écrirait dans un worktree étranger (S-2). Un `git` muet
      // (chemin qui n'est pas un dépôt) n'est pas un motif de refus : il n'y a
      // rien à juger, et le run rapportera lui-même ce qu'il trouve.
      const head = await deps.runGit(["rev-parse", "--abbrev-ref", "HEAD"], feature.worktree);
      if (head.code === 0 && head.stdout.trim() !== feature.branch) return "worktree sans branche";
      return null;
    }
    const created = await createFeatureWorktree({
      run: deps.runGit,
      primaryRoot: deps.repoRoot,
      slug: feature.slug,
      baseDir: worktreesBase,
    });
    if (!created.ok) return created.error;
    feature.worktree = created.path;
    feature.branch = created.branch;
    return null;
  }

  /**
   * Les arbres créés pour une feature que l'utilisateur a reprise pendant la
   * création (annulation) : personne ne les réclame. Les retirer est la seule
   * façon de ne pas laisser d'orphelin derrière une annulation qui vient
   * d'annoncer « jamais créé » (S-9). La BRANCHE est conservée : c'est la règle
   * des trois devenirs (S-9), un arbre retiré ne fait pas disparaître le travail.
   * Ne lève jamais : un retrait refusé est dit, jamais avalé — et l'arbre reste
   * nommé, pour que l'utilisateur sache quoi retirer à la main.
   */
  async function discardWorktrees(paths: string[]): Promise<void> {
    for (const dir of paths) {
      try {
        const removed = await deps.runGit(["worktree", "remove", "--force", dir], deps.repoRoot);
        if (removed.code === 0) continue;
        notify(
          `[pipeline] worktree créé puis abandonné — retrait refusé : ${
            lastLine(removed.stderr) || `code ${removed.code}`
          } — arbre à retirer à la main : ${dir}`,
        );
      } catch (err) {
        notify(
          `[pipeline] worktree créé puis abandonné — retrait refusé : ${
            err instanceof Error ? err.message : String(err)
          } — arbre à retirer à la main : ${dir}`,
        );
      }
    }
  }

  /** Le récap de fin de lot (AC-15) : posté une fois, quand plus rien ne tourne. */
  function maybeRecap(lot: Lot): boolean {
    if (lot.features.length === 0 || lotTotals(lot).live > 0 || lot.recapAt !== null) return false;
    lot.recapAt = now();
    notify(buildLotRecap(repo, lot));
    return true;
  }

  /**
   * Une passe. Deux passes concurrentes créeraient deux fois le même worktree
   * (la seconde échouerait sur le `git` de la première et la feature serait
   * marquée `failed` pour rien) : les appels sont donc SÉRIALISÉS — un tick
   * demandé pendant une passe n'est jamais perdu, il attend la fin de celle-ci.
   */
  function tick(): Promise<void> {
    const next = tickQueue.then(() => pass(), () => pass());
    tickQueue = next.catch(() => undefined);
    return next;
  }

  async function pass(): Promise<void> {
    const initial = read();
    if (!initial) return;
    if (initial.owner.pid !== process.pid) {
      stop();
      return;
    }
    // PHASE A — les worktrees manquants. C'est le SEUL moment où la passe attend :
    // aucune mutation en mémoire ne l'a précédée, donc rien ne sera écrit sur un
    // lot périmé (une fin de run peut tomber pendant l'attente du git).
    const created: Array<{ slug: string; result: { path: string; branch: string } | { error: string } }> = [];
    if (initial.status === "running") {
      for (const feature of initial.features) {
        if (feature.state !== "pending" || feature.worktree !== "" || !runnable(initial, feature)) continue;
        // L'arbre est déjà là mais la branche `feat/<slug>` n'existe pas : ce n'est
        // pas le worktree de cette feature, et git refuserait de le recréer — le
        // diagnostic est nommé plutôt que rendu par le message brut de git (S-2).
        const target = worktreePathFor(worktreesBase, deps.repoRoot, feature.slug);
        if (fs.existsSync(target)) {
          const branch = await deps.runGit(
            ["rev-parse", "--verify", "--quiet", `refs/heads/${feature.branch}`],
            deps.repoRoot,
          );
          if (branch.code !== 0) {
            created.push({ slug: feature.slug, result: { error: "worktree sans branche" } });
            continue;
          }
        }
        const made = await createFeatureWorktree({
          run: deps.runGit,
          primaryRoot: deps.repoRoot,
          slug: feature.slug,
          baseDir: worktreesBase,
        });
        created.push({
          slug: feature.slug,
          result: made.ok ? { path: made.path, branch: made.branch } : { error: made.error },
        });
      }
    }

    // PHASE B — lecture fraîche, décisions, écriture : AUCUNE attente ici, pour
    // qu'une transition concurrente ne soit jamais écrasée par un état périmé.
    const lot = read();
    if (!lot) return;
    if (lot.owner.pid !== process.pid) {
      stop();
      return;
    }
    const launches: PlannedLaunch[] = [];
    const releases: LotFeature[] = [];
    /**
     * Les arbres créés pendant que l'utilisateur reprenait leur feature : plus
     * personne ne les réclame, et les laisser derrière ferait mentir l'annulation
     * qui vient d'annoncer « jamais créé » (S-9, AC-14). Retirés APRÈS l'écriture.
     */
    const orphans: string[] = [];
    let changed = false;

    for (const item of created) {
      const feature = lotFeature(lot, item.slug);
      // L'ACTION DE L'UTILISATEUR PRIME (S-1, AC-14) : pendant la création du
      // worktree (phase A, la seule qui attend), la feature a pu être annulée —
      // une annulation n'attend rien quand son worktree est vide. Appliquer ici
      // une décision périmée la ressusciterait `failed` après la notice `annulé`
      // (et après son récap), et lui écrirait le chemin d'un arbre créé APRÈS
      // l'annulation : un orphelin que cette notice dit « jamais créé », hors de
      // portée de `cancel` (une feature terminale) comme de `remove` (une feature
      // démarrée). Rien n'est donc appliqué, et l'arbre sans propriétaire est
      // retiré — la branche, elle, reste (même règle que les trois devenirs S-9).
      if (!feature || feature.state !== "pending") {
        if ("path" in item.result) orphans.push(item.result.path);
        continue;
      }
      if ("error" in item.result) {
        settle(lot, feature, "failed", item.result.error);
      } else {
        feature.worktree = item.result.path;
        feature.branch = item.result.branch;
      }
      changed = true;
    }

    // 1. Les features en cours sans run suivi : un maillon jamais lancé (bascule
    // d'une collecte en session, pilote repris) démarre ici ; un run interrompu se
    // juge sur le contrat (modifié = le maillon a travaillé).
    for (const feature of lot.features) {
      if (feature.state !== "running" || inFlight.has(feature.slug)) continue;
      if (feature.origin === "session" && feature.phase === "req") continue; // collecte en session
      if (feature.worktree === "") continue;
      // La fin de ce run a déjà été traitée par ce pilote : la chaîne a décidé.
      if (watched.get(feature.slug) === "settled") continue;
      // Aucun hash : aucun pilote n'a lancé de run pour cette feature — c'est le
      // cas d'une feature dont la collecte vient de basculer (S-14). Un run
      // interrompu, lui, a laissé sa marque sur le disque : le hash du contrat au
      // démarrage du run, `""` s'il n'y en avait pas encore (S-1).
      if (feature.contractHash === null) {
        launches.push({
          slug: feature.slug,
          phase: feature.phase,
          fix: false,
          kind: feature.phase === "req" ? "collecte" : "phase",
          resume: false,
        });
        changed = true;
        continue;
      }
      const verdict = reconcileInterrupted({
        contractHashAtStart: feature.contractHash,
        currentContractHash: contractHashOf(feature.worktree),
      });
      if (verdict === "continue") {
        const routed = route(lot, feature, { outcome: "ok", stdout: "", reason: "" });
        launches.push(...routed.launches);
        if (routed.release) releases.push(feature);
      } else {
        settle(lot, feature, "failed", "exécution interrompue (pilote disparu)");
      }
      changed = true;
    }

    // 2. Les dépendances fautives bloquent leurs dépendantes (AC-17).
    for (const feature of lot.features) {
      if (feature.state !== "pending") continue;
      const reason = dependencyBlock(lot, feature);
      if (reason) {
        settle(lot, feature, "blocked", reason);
        changed = true;
      }
    }

    // 3. Les features runnables démarrent, toutes dans la même passe (AC-18).
    for (const feature of lot.features) {
      if (lot.status !== "running" || feature.state !== "pending") continue;
      if (!runnable(lot, feature) || feature.worktree === "") continue;
      feature.state = "running";
      feature.waitKind = null;
      feature.stopReason = null;
      touch(feature, now());
      launches.push({
        slug: feature.slug,
        phase: feature.phase,
        fix: false,
        kind: feature.phase === "req" ? "collecte" : "phase",
        resume: false,
      });
      changed = true;
    }

    if (maybeRecap(lot)) changed = true;
    // Le lot n'a pas pu être écrit : aucun run ne part (cf. `startRun`), et la
    // passe rend la main — le véritable pilote conduira ce lot.
    if (changed && save(lot) !== null) return;
    // Les lancements viennent APRÈS la sauvegarde : un run qui rend la main
    // aussitôt n'écrit jamais sur un lot plus vieux que celui qu'on vient d'écrire.
    for (const launch of launches) {
      const feature = lotFeature(lot, launch.slug);
      if (feature) startRun(lot, feature, launch);
    }
    for (const feature of releases) void finishRelease(feature);
    // Dernier acte de la passe, APRÈS l'écriture : c'est un `await` (`git`), il ne
    // décide plus rien — l'arbre abandonné n'appartient à aucune feature du lot.
    await discardWorktrees(orphans);
  }

  /** Démarre la boucle (une passe par `LOT_TICK_MS`) et se réécrit propriétaire. */
  function start(): void {
    if (stopLoop) return;
    stopLoop = (deps.schedule ?? defaultSchedule)(() => {
      void tick().catch(() => undefined);
    }, LOT_TICK_MS);
    void tick().catch(() => undefined);
  }

  function stop(): void {
    stopLoop?.();
    stopLoop = null;
  }

  /** Reprend un lot dont le pilote a disparu (S-1) — jamais un lot qui vit encore. */
  function adopt(): boolean {
    const lot = read();
    if (!lot || lot.status !== "running" || lotTotals(lot).live === 0) return false;
    if (lot.owner.pid === process.pid || pidAlive(lot.owner.pid)) return false;
    if (save(lot) !== null) return false;
    notify(`[pipeline] lot ${repo} repris par cette session (pilote précédent disparu)`);
    return true;
  }

  /**
   * Une action du panneau qui démarre un run : l'état change, puis le run part.
   * Rend le motif du refus quand le lot n'a pas pu être écrit (rien ne partirait).
   */
  function startPlanned(lot: Lot, feature: LotFeature, launch: PlannedLaunch): string | null {
    feature.phase = launch.phase;
    feature.state = "running";
    feature.waitKind = null;
    feature.waitPrompt = null;
    feature.stopReason = null;
    feature.endedAt = null;
    touch(feature, now());
    // Sauvegarde AVANT le lancement : un run qui rend la main tout de suite ne
    // doit pas écrire sa transition sur un lot plus vieux que celui-ci — et rien
    // ne part si le lot n'a pas pu être écrit.
    const refusal = save(lot);
    if (refusal) return refusal;
    startRun(lot, feature, launch);
    return null;
  }

  /**
   * Ouvre le lot pour une action : refuse si une AUTRE session vivante le pilote
   * (un seul pilote), reprend la main si son pilote est mort. Rend un motif de
   * refus, ou le lot (et la feature demandée).
   */
  function open(slug?: string): { lot: Lot; feature?: LotFeature } | string {
    const lot = read();
    if (!lot) return "aucun lot pour ce dépôt";
    if (lot.owner.pid !== process.pid) {
      if (pidAlive(lot.owner.pid)) return foreignOwnerReason(lot.owner.pid);
      const refusal = save(lot);
      if (refusal) return refusal;
      start();
    }
    if (slug === undefined) return { lot };
    const feature = lotFeature(lot, slug);
    if (!feature) return `« ${slug} » n'est pas dans le lot`;
    return { lot, feature };
  }

  return {
    read,
    start,
    stop,
    tick,
    adopt,

    enrol(input) {
      const existing = read();
      // Un lot conduit par une session VIVANTE n'est jamais réécrit (S-1,
      // invariant 2) : ce `/req` n'y inscrit rien — sa feature garde la chaîne
      // manuelle (S-14), et le lot de l'autre session est intact. Un pilote MORT,
      // lui, se reprend : c'est la seule reprise admise.
      if (existing && existing.owner.pid !== process.pid) {
        if (pidAlive(existing.owner.pid)) {
          reportForeignOwner(existing.owner.pid);
          return foreignOwnerReason(existing.owner.pid);
        }
        const taken = save(existing);
        if (taken) return taken;
        start();
      }
      const lot =
        !existing || (existing.features.length > 0 && lotTotals(existing).live === 0) ? freshLot() : existing;
      if (lotFeature(lot, input.slug)) return null;
      const at = now();
      lot.features.push({
        slug: input.slug,
        name: input.name,
        branch: input.branch,
        worktree: input.worktree,
        deps: [],
        origin: "session",
        state: "running",
        phase: "req",
        waitKind: null,
        waitPrompt: null,
        sessionFile: deps.session?.().file ?? null,
        prUrl: null,
        stopReason: null,
        fixes: 0,
        reviewRuns: 0,
        contractHash: null,
        addedAt: at,
        sinceAt: at,
        updatedAt: at,
        endedAt: null,
      });
      if (lot.status === "draft") {
        lot.status = "running";
        lot.launchedAt = at;
        lot.reviewCap = cap;
      }
      return save(lot);
    },

    async add(input) {
      const slug = toSlug(input.name);
      if (!slug) {
        return `nom invalide : « ${input.name} » — lettres minuscules, chiffres et tirets (ex. isolation-worktree)`;
      }
      // Les refus qui ne demandent aucun `git` sont rendus tout de suite, dans
      // l'ordre de S-3.
      const early = lotForAdd(slug, input.deps);
      if (typeof early === "string") return early;
      const branch = branchFor(slug);
      if (await branchTaken(deps.runGit, deps.repoRoot, branch)) {
        return `la branche ${branch} existe déjà — choisis un autre nom`;
      }
      // `branchTaken` a ATTENDU : le lot est donc relu ici, et l'ajout s'écrit
      // dans la foulée sans aucun `await` (S-1). Écrire le lot lu avant l'attente
      // écraserait une transition tombée entre-temps (AC-2 : les pipelines en
      // cours ne bougent pas).
      const opened = lotForAdd(slug, input.deps);
      if (typeof opened === "string") return opened;
      const { lot, deps: depsSlugs } = opened;
      const at = now();
      lot.features.push({
        slug,
        name: input.description.trim(),
        branch,
        worktree: "",
        deps: depsSlugs,
        origin: "panneau",
        state: "pending",
        phase: "req",
        waitKind: null,
        waitPrompt: null,
        sessionFile: null,
        prUrl: null,
        stopReason: null,
        fixes: 0,
        reviewRuns: 0,
        contractHash: null,
        addedAt: at,
        sinceAt: at,
        updatedAt: at,
        endedAt: null,
      });
      const refusal = save(lot);
      if (refusal) return refusal;
      // Un lot lancé avance par sa boucle : la nouvelle feature démarre à la
      // passe qui suit, sans autre action de l'utilisateur (AC-2) et sans que
      // les autres pipelines soient touchés.
      if (lot.status === "running") {
        start();
        await tick();
      }
      return null;
    },

    async launch() {
      const opened = open();
      if (typeof opened === "string") return opened;
      const { lot } = opened;
      if (lot.features.length === 0) return "lot vide — a pour ajouter une feature";
      if (lot.status === "draft") {
        lot.status = "running";
        lot.launchedAt = now();
        lot.reviewCap = cap;
        const refusal = save(lot);
        if (refusal) return refusal;
      }
      // Le lot tourne : sa boucle est armée (S-11). Sans elle, un lot né du
      // panneau n'avancerait qu'à la fin d'un run — une feature devenue runnable
      // pendant qu'aucun run n'est en vol resterait `pending` indéfiniment.
      start();
      await tick();
      return null;
    },

    async remove(slug) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (feature.state !== "pending") return `« ${slug} » a déjà démarré — c pour annuler`;
      const dependent = lot.features.find((other) => other.state === "pending" && other.deps.includes(slug));
      if (dependent) return `retrait refusé : ${dependent.slug} en dépend`;
      lot.features = lot.features.filter((other) => other.slug !== slug);
      return save(lot);
    },

    async answer(slug, text) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (feature.origin === "session" && feature.phase === "req") {
        return "la collecte se déroule dans ta session — réponds-y directement";
      }
      if (feature.state !== "waiting" || feature.waitKind !== "answer") return "rien à répondre sur cette ligne";
      const trimmed = text.trim();
      if (trimmed === "") return "réponse vide";
      return startPlanned(lot, feature, {
        slug,
        phase: feature.phase,
        fix: false,
        kind: "answer",
        text: trimmed,
        resume: true,
      });
    },

    async validate(slug) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (feature.state !== "waiting" || feature.waitKind !== "specs") {
        return "rien à valider : la feature n'est pas au jalon des specs";
      }
      return startPlanned(lot, feature, { slug, phase: "impl", fix: false, kind: "phase", resume: false });
    },

    async accept(slug) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (feature.state !== "waiting" || feature.waitKind !== "review") {
        return "rien à accepter : la revue n'est pas propre";
      }
      return startPlanned(lot, feature, { slug, phase: "release", fix: false, kind: "phase", resume: false });
    },

    async relaunch(slug) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { lot, feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (feature.state !== "blocked" && feature.state !== "failed") {
        return "relance possible sur une feature bloquée ou échouée";
      }
      // Une dépendance non satisfaite garde la feature à l'arrêt (S-10) : la
      // relancer ouvrirait un run pour une feature dont l'amont a échoué.
      const unmet = feature.deps.map((dep) => lotFeature(lot, dep)).find((up) => up?.state !== "done");
      if (!runnable(lot, feature) && unmet) {
        const refusal = `dépendance ${unmet.slug} non terminée (${lotStateLabel(unmet.state)})`;
        // `settle` alerte lui-même si l'état CHANGE (échouée → bloquée) : une
        // feature déjà bloquée n'a pas de transition, donc pas d'alerte en double.
        settle(lot, feature, "blocked", refusal);
        const written = save(lot);
        return written ?? refusal;
      }
      // La préparation du worktree ATTEND (`git`) : elle travaille sur un brouillon
      // jetable, jamais sur le lot — l'écriture se fera après la relecture.
      const draft: LotFeature = { ...feature };
      const worktreeError = await ensureWorktree(draft);
      if (worktreeError) return worktreeError;
      const prepared = draft.worktree;
      const preparedBranch = draft.branch;
      // La préparation du worktree a ATTENDU (`git`) : le lot est relu ici, et la
      // relance s'écrit dans la foulée sans aucun `await` (S-1).
      const fresh = read();
      if (!fresh) return "aucun lot pour ce dépôt";
      if (fresh.owner.pid !== process.pid) {
        return foreignOwnerReason(fresh.owner.pid);
      }
      const target = lotFeature(fresh, slug);
      if (!target) return `« ${slug} » n'est pas dans le lot`;
      if (target.state !== "blocked" && target.state !== "failed") {
        return "relance possible sur une feature bloquée ou échouée";
      }
      // Le worktree préparé est un fait du DISQUE : il se consigne même si la
      // feature a bougé entre-temps — c'est le chemin qu'un run utiliserait.
      target.worktree = prepared;
      target.branch = preparedBranch;
      // Le plafond est une borne par tentative : relancer ouvre un nouveau crédit.
      target.fixes = 0;
      target.reviewRuns = 0;
      const fix = target.phase === "impl" && reviewVerdict(readContractText(target.worktree)) === "blockers";
      return startPlanned(fresh, target, { slug, phase: target.phase, fix, kind: "relaunch", resume: false });
    },

    async cancel(slug, fate) {
      const opened = open(slug);
      if (typeof opened === "string") return opened;
      const { feature } = opened;
      if (!feature) return `« ${slug} » n'est pas dans le lot`;
      if (lotStateTerminal(feature.state)) return `annulation impossible : la feature est ${lotStateLabel(feature.state)}`;
      // Une annulation ATTEND : la mort du run (jusqu'à 10 s, c'est ce qu'elle
      // attend) puis `git` pour le sort du worktree. Elle n'écrit donc RIEN avant
      // d'avoir relu le lot (S-1) : la transition d'une AUTRE feature tombée dans
      // cette fenêtre doit survivre — S-9 promet de ne pas y toucher, et AC-19
      // qu'un pipeline fautif ne freine pas les autres.
      cancelling.add(slug);
      try {
        const abort = inFlight.get(slug);
        if (abort) {
          abort.abort();
          const deadline = Date.now() + 10_000;
          while (inFlight.has(slug) && Date.now() < deadline) await sleep(50);
          inFlight.delete(slug);
        }
        // Le chemin du worktree vient du DISQUE, pas d'un lot lu avant l'attente.
        const known = read();
        const subject = (known ? lotFeature(known, slug) : undefined) ?? feature;
        let message = "worktree conservé (jamais créé)";
        if (subject.worktree !== "") {
          const applied = await applyWorktreeFate({
            fate,
            feature: subject,
            repoRoot: deps.repoRoot,
            archiveBase,
            currentCwd: process.cwd(),
            run: deps.runGit,
          });
          if (!applied.ok) {
            const lot = read();
            const target = lot ? lotFeature(lot, slug) : undefined;
            // Une feature devenue terminale pendant l'attente (son run a fini
            // avant de mourir) n'est plus touchée : le refus est alors rendu sans
            // écriture — pas plus qu'un lot repris entre-temps par un pilote
            // vivant, dont cette session n'écrit plus rien (S-1).
            if (lot && lot.owner.pid === process.pid && target && !lotStateTerminal(target.state)) {
              settle(lot, target, "blocked", applied.message);
              save(lot);
            }
            return applied.message;
          }
          message = applied.message;
        }
        // Relecture, mutation, écriture : sans aucun `await` entre elles.
        const lot = read();
        if (!lot) return "aucun lot pour ce dépôt";
        if (lot.owner.pid !== process.pid) return foreignOwnerReason(lot.owner.pid);
        const target = lotFeature(lot, slug);
        if (!target) return `« ${slug} » n'est pas dans le lot`;
        if (lotStateTerminal(target.state)) {
          return `annulation impossible : la feature est ${lotStateLabel(target.state)}`;
        }
        // Un run a pu partir pendant l'attente (passe déclenchée par une autre
        // feature) : une feature annulée n'en laisse aucun tourner.
        inFlight.get(slug)?.abort();
        const before = target.state;
        target.state = "cancelled";
        target.waitKind = null;
        target.waitPrompt = null;
        target.stopReason = null;
        target.endedAt = touch(target, now());
        emit(lot, target, before);
        notify(`[pipeline] ${slug} annulé — ${message}`);
        maybeRecap(lot);
        return save(lot);
      } finally {
        cancelling.delete(slug);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Panneau des pipelines — un plein écran, pilotable au clavier ET à la souris.
// ---------------------------------------------------------------------------
// C'est un `ctx.ui.custom` avec `overlay: true` et `fullscreen: true` : le seul
// point de montage d'un composant maison en TUI (cf. `## Documentation` §1). Le
// plein écran emprunte le buffer alterné — le chat n'est plus visible derrière, et
// rien de l'écran normal n'est modifié. L'overlay prend le FOCUS : aucune touche
// n'atteint l'éditeur tant qu'il est ouvert, et `done` est le seul moyen de rendre
// le focus et le texte de l'éditeur.
//
// Le plein écran ouvre la SOURIS : `pi-tui` capture les rapports dès que l'overlay
// visible du dessus est plein écran et que `mouseTracking` n'est pas désactivé, et
// les remet à `handleInput` en SGR. Le décodage est local (`parseSgrMouse`, aucun
// import de valeur `@oh-my-pi/*`) et la résolution rang → rang sélectionnable passe
// par `PanelRow.target`, posé par le constructeur de rangs : la correspondance
// n'est jamais devinée à l'écran. Conséquence assumée : tant que le panneau est
// ouvert, la sélection de texte native du terminal est capturée par le panneau.
//
// La mise en page est une fonction PURE de rangs `{text, tone}` (aucun état, aucun
// accès disque), construite hors du composant et testable avec des glyphes ASCII —
// même séparation que `renderRecallRows` du plugin mémoire. Le composant ne fait
// que colorier EN BLOC : un rang, une couleur, donc aucun calcul ANSI — et il
// remplit la hauteur de l'écran, ce que le constructeur de rangs ne fait pas (son
// contrat « au plus `budget` rangs » est verrouillé par les tests).
//
// Le panneau est STRICTEMENT lecteur du magasin et du lot : il n'écrit ni entrée,
// ni lot, et n'arrête aucun run (hors `c`, l'annulation explicite).

export type PanelTone = "border" | "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text";
export type PanelRow = {
  text: string;
  tone: PanelTone;
  /**
   * L'index de SÉLECTION que ce rang représente (S-4) : posé par le constructeur
   * de rangs sur les rangs sélectionnables (feature du lot, entrée en cours,
   * entrée d'historique), absent partout ailleurs (cadre, titres, marqueurs,
   * notice, rangs de saisie, pied). Le clic résout sa cible par ce champ : la
   * correspondance rang → ligne n'est jamais devinée à l'écran.
   */
  target?: number;
};

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
  /**
   * Les entrées en cours NON appariées à une feature du lot : les runs d'autres
   * dépôts, les sessions hors lot. Une entrée appariée n'est pas ici — elle est
   * absorbée par le rang de sa feature (`live`), pour qu'une feature n'occupe
   * qu'une seule ligne.
   */
  running: RunningEntry[];
  /**
   * Les entrées en cours APPARIÉES à une feature du lot, indexées par
   * `feature.slug` : c'est le run qui écrit la session de ce rang, et c'est lui
   * qui lui donne son maillon, son état et son temps (S-1).
   */
  live: Record<string, RunningEntry>;
  history: HistoryEntry[];
  /**
   * Le lot du dépôt de la session, `null` s'il n'y en a pas : dans ce cas le
   * panneau rend exactement ce qu'il rendait avant les lots.
   */
  lot?: Lot | null;
  /** Le mode de saisie courant (`browse` : aucune saisie en cours). */
  mode?: LotPanelMode;
  /**
   * Index sur la liste concaténée
   * `[...features du lot, ...running NON appariés, ...history]`, borné, `-1` si vide.
   */
  selection: number;
  notice: string | null;
  unreadable: number;
};

/** Les modes du panneau : consulter, ajouter, répondre, choisir le sort d'un worktree. */
export type LotPanelMode =
  | { kind: "browse" }
  | {
      kind: "add";
      step: "name" | "description" | "deps";
      draft: { name: string; description: string; deps: string };
      buffer: string;
    }
  | { kind: "answer"; slug: string; buffer: string }
  | { kind: "cancel"; slug: string };

export const PANEL_REFRESH_MS = 1000;
export const PANEL_MIN_ROWS = 8;

/**
 * Le panneau occupe tout l'écran (S-4) : le budget est la hauteur du terminal,
 * sans plafond ni facteur — le TUI n'a plus rien à couper puisque le cadre EST
 * l'écran. Le plancher reste : sous `PANEL_MIN_ROWS`, le contenu déborde et c'est
 * le TUI qui coupe par le bas (dégradation admise, terminal minuscule). Un
 * `rows` absent, nul ou non fini retombe sur 24.
 */
export function panelBudget(terminalRows: number): number {
  const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : 24;
  return Math.max(PANEL_MIN_ROWS, Math.floor(rows));
}

/**
 * La hauteur du cadre, en rangs : celle du terminal, ou le repli de 24. C'est elle
 * que le composant remplit de rangs vides (S-4) — le constructeur de rangs, lui,
 * ne connaît que son budget.
 */
export function panelHeight(tui: PanelTui): number {
  const rows = tui.terminal?.rows;
  return Number.isFinite(rows) && (rows as number) > 0 ? Math.floor(rows as number) : 24;
}

/**
 * Complète la hauteur : tant que le contenu n'occupe pas l'écran, des rangs vides
 * s'insèrent IMMÉDIATEMENT AVANT le dernier rang — la règle basse reste ainsi sur
 * le dernier rang de l'écran. Au-delà de la hauteur, rien n'est inséré : le TUI
 * coupe par le bas, comme avant (terminal plus court que le cadre).
 */
export function fillPanelHeight(rows: PanelRow[], width: number, height: number): PanelRow[] {
  if (rows.length === 0 || rows.length >= height) return rows;
  const blanks: PanelRow[] = Array.from({ length: height - rows.length }, () => ({
    text: " ".repeat(width),
    tone: "dim" as const,
  }));
  return [...rows.slice(0, -1), ...blanks, rows[rows.length - 1]!];
}

/** Rapport SGR de souris décodé (S-4) : `row`/`col` sont 0-based et indexent les rangs rendus. */
export type SgrMouseEvent = {
  row: number;
  col: number;
  /** -1 = vers le haut, 1 = vers le bas, `null` = pas une molette verticale. */
  wheel: -1 | 1 | null;
  leftClick: boolean;
  motion: boolean;
  release: boolean;
};

/** `ESC [ < bouton ; colonne ; ligne M|m` — la seule forme émise par `pi-tui`. */
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Décodage LOCAL d'un rapport de souris (## Documentation §1) : le dépôt interdit
 * tout import de VALEUR depuis `@oh-my-pi/*`, donc le format et les bitwise de
 * `pi-tui/src/mouse.ts` sont réimplémentés ici, en fonction pure. `null` pour
 * toute autre donnée : le clavier suit alors son chemin normal.
 *
 * Les molettes HORIZONTALES (boutons 66/67) ne sont pas une direction : `wheel`
 * reste `null`, et le rapport est ignoré.
 */
export function parseSgrMouse(data: string): SgrMouseEvent | null {
  const match = SGR_MOUSE.exec(data);
  if (!match) return null;
  const button = Number(match[1]);
  const release = match[4] === "m";
  const wheel = (button & 64) !== 0 && (button & 2) === 0 ? ((button & 1) !== 0 ? 1 : -1) : null;
  return {
    row: Number(match[3]) - 1,
    col: Number(match[2]) - 1,
    wheel,
    motion: (button & 32) !== 0 && wheel === null,
    leftClick: !release && wheel === null && (button & 32) === 0 && (button & 3) === 0,
    release,
  };
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
 * lecture du lot du dépôt de la session, appariement lot ↔ entrées en cours, puis
 * borne de la sélection. C'est la seule fonction qui touche le disque (deux petits
 * fichiers : le magasin et le lot).
 */
export function readPanelModel(input: {
  stateDir: string;
  /** Racine du dépôt : absente, il n'y a pas de lot à afficher (rendu d'avant les lots). */
  repoRoot?: string;
  selection?: number;
  notice?: string | null;
  mode?: LotPanelMode;
}): PanelModel {
  const snapshot = reconcileStore(input.stateDir);
  const lotPath = input.repoRoot ? lotPathFor(input.stateDir, lotRepoKey(input.repoRoot)) : null;
  const lot = input.repoRoot ? readLot(input.stateDir, lotRepoKey(input.repoRoot)) : null;
  // Un fichier de lot PRÉSENT mais rejeté (JSON tronqué, `version` étrangère,
  // champ manquant) est un fichier illisible comme un autre : le panneau le dit
  // au lieu de retomber silencieusement sur son rendu d'avant les lots (S-1).
  const lotUnreadable = lot === null && lotPath !== null && fs.existsSync(lotPath) ? 1 : 0;
  const features = lot?.features ?? [];
  // APPARIEMENT (S-1) : l'entrée en cours du worktree d'une feature est absorbée
  // par son rang de lot — une feature n'occupe qu'une ligne, à tout instant de sa
  // vie. `worktree !== ""` n'est pas cosmétique : `realpathOr("")` vaut le cwd du
  // process, donc une feature `pending` (worktree vide) absorberait l'entrée du
  // dépôt principal et la ferait disparaître de la section « en cours ».
  // Au plus une entrée par feature (un fichier d'entrée par cwd) : si deux
  // features pointaient le même worktree, la première absorbe et l'entrée n'est
  // rendue qu'une fois.
  const live: Record<string, RunningEntry> = {};
  const running: RunningEntry[] = [];
  // Les worktrees réels sont calculés UNE fois (c'est un appel disque chacun) : le
  // panneau se rafraîchit à la seconde, un `realpathOr` par entrée × feature se
  // paierait à chaque passe pour rien.
  const worktrees = features
    .filter((f) => f.worktree !== "")
    .map((f) => ({ slug: f.slug, real: realpathOr(f.worktree) }));
  for (const entry of snapshot.running) {
    const real = realpathOr(entry.cwd);
    const feature = worktrees.find((w) => w.real === real);
    if (feature && !(feature.slug in live)) live[feature.slug] = entry;
    else running.push(entry);
  }
  const count = features.length + running.length + snapshot.history.length;
  return {
    running,
    live,
    history: snapshot.history,
    lot,
    mode: input.mode ?? { kind: "browse" },
    selection: clampSelection(input.selection ?? 0, count),
    notice: input.notice ?? null,
    unreadable: snapshot.unreadable + lotUnreadable,
  };
}

// --- le rang sélectionnable : sa session, son cwd, la vivacité de son écrivain --

/** Un rang SÉLECTIONNABLE du panneau : une feature du lot, ou une entrée du magasin. */
export type PanelRowRef = LotFeature | RunningEntry | HistoryEntry;

/** Une feature du lot se reconnaît à son worktree ; une entrée du magasin a un `cwd`. */
function isLotFeature(row: PanelRowRef): row is LotFeature {
  return "worktree" in row;
}

/** Le nombre de rangs sélectionnables : features du lot, puis entrées non appariées, puis historique. */
export function panelRowCount(model: PanelModel): number {
  return (model.lot?.features.length ?? 0) + model.running.length + model.history.length;
}

/** Le rang sélectionnable d'index `selection`, dans l'ordre de la liste. Pur, sans allocation. */
export function panelRowAt(model: PanelModel, selection: number): PanelRowRef | undefined {
  if (selection < 0) return undefined;
  const features = model.lot?.features ?? [];
  if (selection < features.length) return features[selection];
  const index = selection - features.length;
  if (index < model.running.length) return model.running[index];
  return model.history[index - model.running.length];
}

/** Le cwd d'un rang : le worktree de la feature, le cwd de l'entrée. `null` si indéterminé. */
function rowCwd(row: PanelRowRef): string | null {
  if (!isLotFeature(row)) return asStringOrNull(row.cwd);
  return row.worktree === "" ? null : row.worktree;
}

/**
 * La session COURANTE d'un rang, quelle que soit sa section (S-1) : celle du run
 * apparié quand il y en a un, sinon celle portée par la feature, sinon celle de
 * l'entrée. `null` = ce rang n'a aucune session à montrer.
 */
export function rowSessionFile(model: PanelModel, row: PanelRowRef): string | null {
  if (!isLotFeature(row)) return asStringOrNull(row.sessionFile);
  return asStringOrNull(model.live[row.slug]?.sessionFile) ?? asStringOrNull(row.sessionFile);
}

/**
 * Un run VIVANT écrit-il la session de ce rang ? (S-1) C'est la question dont
 * dépendent les deux gardes de `o` et la mention « run en cours » de la vue : un
 * run d'un AUTRE process — le nôtre ne se concurrence pas lui-même — qui vise le
 * même fichier de session, ou, quand le run ne publie pas de fichier, le même cwd
 * (refus par prudence : c'est le worktree d'un run vivant).
 */
export function hasLiveWriter(model: PanelModel, row: PanelRowRef): boolean {
  const file = rowSessionFile(model, row);
  const cwd = rowCwd(row);
  for (const entry of [...model.running, ...Object.values(model.live)]) {
    if (entry.owner.pid === process.pid || !pidAlive(entry.owner.pid)) continue;
    const target = asStringOrNull(entry.sessionFile);
    if (target !== null) {
      if (file !== null && realpathOr(target) === realpathOr(file)) return true;
      continue;
    }
    if (cwd !== null && realpathOr(entry.cwd) === realpathOr(cwd)) return true;
  }
  return false;
}

/**
 * Le libellé d'un rang, tel que le panneau l'écrit : la ligne du lot, ou celle de
 * l'entrée du magasin.
 */
function rowLabel(row: PanelRowRef): string {
  return isLotFeature(row) ? lotFeatureLabel(row) : row.label;
}

/** Le maillon d'un rang : celui du run apparié quand il y en a un, sinon le sien. */
function rowPhase(model: PanelModel, row: PanelRowRef): PipelinePhase {
  return isLotFeature(row) ? (model.live[row.slug]?.phase ?? row.phase) : row.phase;
}

/** L'état d'un rang, dans les mots du panneau (S-1) : jamais un état inventé. */
function rowStateLabel(model: PanelModel, row: PanelRowRef): string {
  if (isLotFeature(row)) {
    const live = model.live[row.slug];
    if (live) return live.state === "waiting" ? "attend" : "tourne";
    return lotWaitLabel(row.waitKind) ?? lotStateLabel(row.state);
  }
  if ("finalState" in row) return row.finalState === "done" ? "terminé" : "échoué";
  return row.state === "waiting" ? "attend" : "tourne";
}

/** La notice d'un rang sans session (S-2) : le texte existant, par section. */
function noSessionNotice(row: PanelRowRef): string {
  return isLotFeature(row)
    ? "cette feature n'a pas encore de session — attends son premier maillon"
    : "session introuvable — entrée non reprenable";
}

// --- la section « Lot » du panneau ------------------------------------------

/**
 * Rang de titre de section : le cadre s'ouvre sur le titre, comme `topRule`, et
 * le rang fait exactement `width` colonnes.
 */
function sectionRule(glyphs: PanelGlyphs, title: string, width: number): string {
  const head = `${glyphs.teeLeft}─ ${clip(title, Math.max(0, width - 6))} `;
  return fit(head + glyphs.horizontal.repeat(Math.max(0, width - head.length - 1)) + glyphs.teeRight, width);
}

/** `<slug> ← deps` : la ligne d'une feature dit de quoi elle dépend. */
function lotFeatureLabel(feature: LotFeature): string {
  return feature.deps.length > 0 ? `${feature.slug} ← ${feature.deps.join(",")}` : feature.slug;
}

/** La colonne de droite : maillon, état (le jalon nommé quand il y en a un), temps. */
function lotFeatureRight(feature: LotFeature, now: number): string {
  const state = lotWaitLabel(feature.waitKind) ?? lotStateLabel(feature.state);
  return `/${feature.phase} · ${state} · ${elapsedLabel((feature.endedAt ?? now) - feature.sinceAt)}`;
}

/**
 * La colonne de droite d'une ENTRÉE en cours : même format que celle d'un rang de
 * lot, pour qu'une feature appariée à son run ne change pas de forme (S-1).
 */
function entryRight(entry: { phase: PipelinePhase; state: PipelineRunState; phaseStartedAt: number }, now: number): string {
  return `/${entry.phase} · ${entry.state === "waiting" ? "attend" : "tourne"} · ${elapsedLabel(now - entry.phaseStartedAt)}`;
}

function lotStateTone(state: LotFeatureState): PanelTone {
  switch (state) {
    case "running":
      return "success";
    case "waiting":
      return "warning";
    case "blocked":
    case "failed":
      return "error";
    case "cancelled":
      return "muted";
    default:
      return "dim";
  }
}

function lotSectionTitle(lot: Lot): string {
  return `Lot · ${path.basename(lot.repoRoot)} · ${lot.features.length} features`;
}

/**
 * Les rangs d'un mode de saisie : le champ courant (tampon + curseur) et son
 * aide, ou la question du devenir du worktree. `browse` n'ajoute rien.
 */
function lotModeRows(mode: LotPanelMode, glyphs: PanelGlyphs, width: number, innerW: number): PanelRow[] {
  if (mode.kind === "browse") return [];
  if (mode.kind === "cancel") {
    // Deux rangs : le panneau fait 64 colonnes et les trois devenirs ne tiennent
    // pas sur un seul rang avec leur conséquence.
    return [
      {
        text: frame(glyphs, `Annuler ${mode.slug} ? worktree : 1 gardé · 2 archivé · 3 supprimé`, width, innerW),
        tone: "warning",
      },
      {
        text: frame(glyphs, "la branche reste · 2 copie les ignorés · Échap annuler", width, innerW),
        tone: "dim",
      },
    ];
  }
  if (mode.kind === "answer") {
    return [
      { text: frame(glyphs, `Réponse à ${mode.slug} : ${mode.buffer}▏`, width, innerW), tone: "text" },
      { text: frame(glyphs, "Entrée envoyer · Échap annuler", width, innerW), tone: "dim" },
    ];
  }
  const field =
    mode.step === "name"
      ? "Nom"
      : mode.step === "description"
        ? "Description"
        : "Dépendances (slugs séparés par des virgules)";
  const next = mode.step === "deps" ? "créer la feature" : "champ suivant";
  return [
    { text: frame(glyphs, `${field} : ${mode.buffer}▏`, width, innerW), tone: "text" },
    { text: frame(glyphs, `Entrée ${next} · Échap annuler`, width, innerW), tone: "dim" },
  ];
}

/** Les touches qui s'appliquent à la ligne sélectionnée, dans l'ordre du pied. */
export function lotFooterActions(features: LotFeature[], selection: number): string {
  const feature = selection >= 0 && selection < features.length ? features[selection] : undefined;
  if (!feature) return "aucune action";
  // La collecte d'une feature de lot se répond DANS la session, jamais au panneau
  // (`answer` refuse cet état) : l'annoncer serait une touche morte.
  const collecte = feature.origin === "session" && feature.phase === "req";
  const actions: string[] = [];
  if (!collecte && feature.state === "waiting" && feature.waitKind === "answer") actions.push("i répondre");
  if (feature.state === "waiting" && feature.waitKind === "specs") actions.push("v valider");
  if (feature.state === "waiting" && feature.waitKind === "review") actions.push("y accepter");
  if (feature.state === "blocked" || feature.state === "failed") actions.push("R relancer");
  if (feature.state === "pending") actions.push("x retirer");
  if (!lotStateTerminal(feature.state)) actions.push("c annuler");
  return actions.length > 0 ? actions.join(" · ") : "aucune action";
}

/**
 * La seconde ligne du pied : ce qui s'applique à la LIGNE SÉLECTIONNÉE, quelle
 * qu'elle soit. Un rang de lot passe par `lotFooterActions` ; une entrée
 * d'historique est le seul rang que `d` supprime ; un rang « en cours » n'offre
 * aucune action de ligne — et une sélection vide n'annonce rien. La bascule `o`
 * s'ajoute à la fin dès que le rang a une session (S-3) : elle existe sur les
 * trois sections, elle doit donc s'annoncer partout où elle mène quelque part.
 */
function panelFooterActions(model: PanelModel, runningCount: number): string {
  const features = model.lot?.features.length ?? 0;
  const selection = model.selection;
  const base =
    selection < features
      ? lotFooterActions(model.lot?.features ?? [], selection)
      : selection < features + runningCount
        ? "aucune action"
        : selection < features + runningCount + model.history.length
          ? "d supprimer"
          : "aucune action";
  const row = panelRowAt(model, selection);
  if (!row || rowSessionFile(model, row) === null) return base;
  // « aucune action » n'est pas une action : la ligne ne se contredit pas en
  // annonçant la bascule à côté d'un « aucune action ».
  return base === "aucune action" ? "o rejoindre" : `${base} · o rejoindre`;
}

function fit(text: string, width: number): string {
  if (text.length === width) return text;
  return text.length > width ? clip(text, width) : text + " ".repeat(width - text.length);
}

function clip(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length > n ? (n > 1 ? `${s.slice(0, n - 1)}…` : s.slice(0, n)) : s;
}

/**
 * Les `n` DERNIERS caractères (S-4) : dans la sortie d'un maillon, ce qui compte
 * est la fin — l'agent y pose ses questions et sa conclusion —, pas l'en-tête du
 * récapitulatif qui la précède.
 */
function clipTail(s: string, n: number): string {
  if (n <= 0) return "";
  return s.length > n ? (n > 1 ? `…${s.slice(-(n - 1))}` : s.slice(-n)) : s;
}

/**
 * La fenêtre d'une section tronquée : celle qui CONTIENT le rang sélectionné, au
 * plus près (S-4). `sel` est l'index de la sélection DANS la section (`-1` quand
 * elle n'y est pas) : une section tronquée ne cache jamais la ligne qu'on regarde,
 * et les autres sections gardent leur début.
 */
function windowStart(sel: number, shown: number, count: number): number {
  if (sel < 0 || shown >= count) return 0;
  return Math.min(Math.max(sel - shown + 1, 0), Math.max(0, count - shown));
}

/** L'index de la sélection DANS une section, ou `-1` si elle porte sur une autre. */
function sectionSelection(selection: number, offset: number, count: number): number {
  return selection >= 0 && selection < count ? selection + offset : -1;
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
 * Le panneau tient dans `budget` rangs — le pied compris, c'est lui que le TUI
 * couperait par le bas. Le budget paie d'abord le cadre (titre, séparateur, pied,
 * notice, rangs de saisie, titre de la section lot), puis un rang minimum par
 * section non vide — son entrée, ou son marqueur `… <n> de plus` quand elle est
 * tronquée : aucune section non vide ne disparaît en silence. Le surplus va par
 * priorité au lot (la salle de contrôle), puis aux pipelines en cours (vivants),
 * puis à l'historique, la plus récente d'abord.
 */
export function buildPanelRows(
  model: PanelModel,
  opts: { width: number; budget: number; glyphs: PanelGlyphs; now: number },
): PanelRow[] {
  const width = Math.max(1, Math.floor(opts.width));
  const glyphs = opts.glyphs;
  const innerW = Math.max(0, width - 4);
  const rows: PanelRow[] = [];
  const lot = model.lot ?? null;
  const mode = model.mode ?? { kind: "browse" };
  const notice = noticeText(model);
  const modeRows = lotModeRows(mode, glyphs, width, innerW);
  const runningCount = model.running.length;

  // Le titre annonce les PROCESS vivants : les entrées appariées sont absorbées
  // par un rang de lot, mais elles tournent toujours.
  rows.push({
    text: topRule(glyphs, `Pipelines · ${runningCount + Object.keys(model.live).length} en cours`, width),
    tone: "accent",
  });

  // Les rangs du lot, dans l'ordre d'ajout : la salle de contrôle vient en tête.
  const lotBody: PanelRow[] = [];
  let lotOffset = 0;
  if (lot) {
    if (lot.features.length === 0) {
      lotBody.push({ text: frame(glyphs, "aucune feature — a ajouter", width, innerW), tone: "muted" });
    } else {
      if (lot.status === "draft") {
        lotBody.push({ text: frame(glyphs, "lot non lancé — l lancer", width, innerW), tone: "muted" });
      }
      // Les rangs de tête (état vide, lot non lancé) précèdent les features : la
      // fenêtre d'une section tronquée compte en rangs, la sélection en features.
      lotOffset = lotBody.length;
      lot.features.forEach((feature, index) => {
        // Une feature appariée à son run prend son maillon, son état, son temps ET
        // son ton (S-1) : c'est le run qui travaille, c'est lui qui se lit.
        const live = model.live[feature.slug];
        const content = entryLine(
          lotFeatureLabel(feature),
          live ? entryRight(live, opts.now) : lotFeatureRight(feature, opts.now),
          model.selection === index,
          glyphs,
          innerW,
        );
        lotBody.push({
          text: frame(glyphs, content, width, innerW),
          tone: live ? (live.state === "waiting" ? "warning" : "success") : lotStateTone(feature.state),
          target: index,
        });
      });
    }
  }

  const features = lot?.features.length ?? 0;
  const historyCount = model.history.length;
  // Le budget paie d'abord ce qui est TOUJOURS rendu : titre, séparateur, pied
  // (deux rangs de touches avec un lot, plus « Échap fermer » — c'est lui que le
  // budget protège du rognage par le bas), notice, rangs de saisie et titre de la
  // section lot.
  const footRows = lot ? 3 : 2;
  const frameRows = 1 + footRows + 1 + (notice ? 1 : 0) + modeRows.length + (lot ? 1 : 0);

  /**
   * Répartit une section dans `room` rangs : toutes ses entrées si elles tiennent,
   * sinon autant d'entrées que possible en gardant le DERNIER rang pour le
   * marqueur `… n de plus` — une section tronquée le dit toujours, elle ne
   * disparaît jamais en silence (S-7). `room` à 0 ne rend rien.
   */
  const take = (count: number, room: number): { shown: number; marker: boolean } =>
    count <= room ? { shown: count, marker: false } : { shown: Math.max(0, room - 1), marker: room > 0 };

  let left = Math.max(0, opts.budget - frameRows);
  const credit = (want: number): number => {
    const paid = Math.min(want, Math.max(0, left));
    left -= paid;
    return paid;
  };

  // 1. Le minimum de chaque section NON VIDE : un rang — son entrée, ou son
  //    marqueur. Réservé avant de servir la première section, le budget servait
  //    auparavant les entrées du lot jusqu'à laisser la section « en cours »
  //    sans un rang ni un marqueur : un pipeline vivant disparaissait de l'écran
  //    alors que le titre en annonçait le compte (BLOQUANT 4 de la revue n°3).
  const minLot = credit(lotBody.length > 0 ? 1 : 0);
  const minRunning = credit(runningCount > 0 ? 1 : 0);
  const minHistory = credit(historyCount > 0 ? 1 : 0);
  // 2. Le surplus, par priorité : le lot (la salle de contrôle), puis les
  //    pipelines en cours (vivants), puis l'historique.
  const lotShown = take(lotBody.length, minLot + credit(Math.max(0, lotBody.length - minLot)));
  const runningShown = take(runningCount, minRunning + credit(Math.max(0, runningCount - minRunning)));
  const historyShown = take(historyCount, minHistory + credit(Math.max(0, historyCount - minHistory)));
  // 3. Les rangs d'ÉTAT VIDE (« aucune pipeline en cours », « aucun historique »)
  //    se paient comme les autres : ce sont eux qui, oubliés du calcul, faisaient
  //    dépasser le budget d'un rang par section vide et coupaient le pied
  //    (BLOQUANT 3 de la revue n°3). Sans budget pour eux, le titre de section dit
  //    déjà l'essentiel.
  const runningEmpty = runningCount === 0 && credit(1) === 1;
  const historyEmpty = historyCount === 0 && credit(1) === 1;

  if (lot) {
    rows.push({ text: sectionRule(glyphs, lotSectionTitle(lot), width), tone: "accent" });
    const start = windowStart(sectionSelection(model.selection, lotOffset, lot.features.length), lotShown.shown, lotBody.length);
    for (const row of lotBody.slice(start, start + lotShown.shown)) rows.push(row);
    if (lotShown.marker) {
      rows.push({ text: frame(glyphs, `… ${lotBody.length - lotShown.shown} de plus`, width, innerW), tone: "dim" });
    }
  }

  if (runningCount === 0) {
    if (runningEmpty) rows.push({ text: frame(glyphs, "aucune pipeline en cours", width, innerW), tone: "muted" });
  } else {
    const start = windowStart(sectionSelection(model.selection - features, 0, runningCount), runningShown.shown, runningCount);
    for (let i = start; i < start + runningShown.shown; i++) {
      const entry = model.running[i]!;
      rows.push({
        text: frame(glyphs, entryLine(entry.label, entryRight(entry, opts.now), model.selection === features + i, glyphs, innerW), width, innerW),
        tone: entry.state === "waiting" ? "warning" : "success",
        target: features + i,
      });
    }
    if (runningShown.marker) {
      rows.push({
        text: frame(glyphs, `… ${runningCount - runningShown.shown} de plus`, width, innerW),
        tone: "dim",
      });
    }
  }

  rows.push({ text: separatorRule(glyphs, width), tone: "border" });

  if (historyCount === 0) {
    if (historyEmpty) rows.push({ text: frame(glyphs, "aucun historique", width, innerW), tone: "muted" });
  } else {
    const start = windowStart(
      sectionSelection(model.selection - features - runningCount, 0, historyCount),
      historyShown.shown,
      historyCount,
    );
    for (let i = start; i < start + historyShown.shown; i++) {
      const entry = model.history[i]!;
      const final = entry.finalState === "done" ? "terminé" : "échoué";
      const right = `/${entry.phase} · ${final}`;
      const selected = model.selection === features + runningCount + i;
      rows.push({
        text: frame(glyphs, entryLine(entry.label, right, selected, glyphs, innerW), width, innerW),
        tone: entry.finalState === "done" ? "dim" : "error",
        target: features + runningCount + i,
      });
    }
    if (historyShown.marker) {
      rows.push({
        text: frame(glyphs, `… ${historyCount - historyShown.shown} de plus`, width, innerW),
        tone: "dim",
      });
    }
  }

  if (notice) rows.push({ text: frame(glyphs, notice, width, innerW), tone: "warning" });
  for (const row of modeRows) rows.push(row);

  // Le pied : les touches de la salle de contrôle quand un lot est là, sinon le
  // pied d'avant, augmenté de l'unique touche qui crée un lot. Avec un lot, la
  // seconde ligne dit ce qui s'applique à la LIGNE SÉLECTIONNÉE : c'est elle qui
  // annonce `x` sur un rang de lot, et `d` sur une entrée d'historique — le seul
  // rang où `d` agit. Annoncer `d` sur un rang de lot serait une touche morte.
  rows.push({
    text: frame(
      glyphs,
      lot
        ? "a ajouter · l lancer · Entrée session"
        : "↑↓ naviguer · Entrée session · d supprimer · a ajouter",
      width,
      innerW,
    ),
    tone: "dim",
  });
  if (lot) {
    rows.push({ text: frame(glyphs, panelFooterActions(model, runningCount), width, innerW), tone: "dim" });
  }
  rows.push({ text: bottomRule(glyphs, "Échap fermer", width), tone: "border" });

  return rows.map((row) => ({ ...row, text: fit(row.text, width) }));
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

// --- la vue de session : lire un JSONL de session, borné et sans jamais écrire --

/**
 * Borne de lecture de la vue : les 256 DERNIERS Kio d'un fichier de session
 * suffisent à voir où en est un run, et le panneau se rafraîchit à la seconde —
 * une session de plusieurs mégaoctets ne coûte pas plus cher qu'une petite.
 */
export const SESSION_VIEW_READ_BYTES = 256 * 1024;
/** Borne du nombre d'entrées rendues ; au-delà, l'en-tête « début tronqué » le dit. */
export const SESSION_VIEW_MAX_ENTRIES = 500;

/** Une entrée de session RENDABLE : tout le reste du JSONL ne produit aucun rang. */
export type SessionViewEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "toolCall"; name: string; text: string }
  | { kind: "toolResult"; name: string; text: string }
  | { kind: "custom"; customType: string }
  | { kind: "customMessage"; customType: string; text: string };

/** Le contenu lisible d'un fichier de session, ou le chemin en erreur (absent/illisible). */
export type SessionView = { entries: SessionViewEntry[]; truncated: boolean } | { error: string };

/** La première ligne NON VIDE d'un texte : ce qu'un rang de transcription peut montrer. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/** Le texte d'un contenu de message : une chaîne, ou les blocs `text` d'un tableau. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.join(" ");
}

/**
 * Une entrée du JSONL → zéro ou plusieurs entrées de vue (S-2). Pure : une entrée
 * technique (`title`, `model_usage`, `label`, …) ou inconnue ne rend RIEN, et rien
 * ici ne peut lever — un fichier en cours d'écriture est lu ligne par ligne.
 */
function sessionViewEntries(raw: unknown): SessionViewEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  if (rec.type === "custom_message") {
    const customType = asStringOrNull(rec.customType);
    if (!customType) return [];
    return [{ kind: "customMessage", customType, text: firstLine(textOfContent(rec.content)) }];
  }
  if (rec.type === "custom") {
    const customType = asStringOrNull(rec.customType);
    return customType ? [{ kind: "custom", customType }] : [];
  }
  if (rec.type !== "message" || !rec.message || typeof rec.message !== "object") return [];
  const message = rec.message as Record<string, unknown>;
  if (message.role === "user") return [{ kind: "user", text: firstLine(textOfContent(message.content)) }];
  if (message.role === "toolResult") {
    return [
      {
        kind: "toolResult",
        name: asStringOrNull(message.toolName) ?? "?",
        text: firstLine(textOfContent(message.content)),
      },
    ];
  }
  if (message.role !== "assistant") return [];
  const out: SessionViewEntry[] = [];
  // Un rang vide n'apprend rien : un tour qui n'a produit que des appels d'outil
  // se lit par ses appels, pas par une ligne « agent : » sans texte.
  const text = firstLine(textOfContent(message.content));
  if (text !== "") out.push({ kind: "assistant", text });
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      const call = block as Record<string, unknown>;
      if (call.type !== "toolCall") continue;
      out.push({
        kind: "toolCall",
        name: asStringOrNull(call.name) ?? "?",
        text: firstLine(JSON.stringify(call.arguments ?? {})),
      });
    }
  }
  return out;
}

/** Les `maxBytes` derniers octets d'un fichier, ou `null` s'il est absent ou illisible. */
function readTail(file: string, maxBytes: number): { text: string; fromTail: boolean } | null {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, start);
      return { text: buf.subarray(0, read).toString("utf8"), fromTail: start > 0 };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Lecture BORNÉE d'un fichier de session pour la vue (S-2) : au plus les 256
 * derniers Kio et au plus 500 entrées, lignes mal formées ignorées, aucune
 * exception. La première ligne d'une lecture partielle est une ligne tronquée :
 * elle ne parse pas et tombe donc d'elle-même.
 */
export function readSessionView(file: string): SessionView {
  const tail = readTail(file, SESSION_VIEW_READ_BYTES);
  if (tail === null) return { error: file };
  const entries: SessionViewEntry[] = [];
  for (const line of tail.text.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // ligne vide, tronquée par la borne, ou JSON mal formé
    }
    for (const entry of sessionViewEntries(parsed)) entries.push(entry);
  }
  let truncated = tail.fromTail;
  if (entries.length > SESSION_VIEW_MAX_ENTRIES) {
    entries.splice(0, entries.length - SESSION_VIEW_MAX_ENTRIES);
    truncated = true;
  }
  return { entries, truncated };
}

/**
 * Les rangs d'une vue de session (S-2), du plus ancien au plus récent : un rang par
 * entrée, tronqué à la largeur reçue, et les états rendus EXPLICITEMENT — jamais
 * déduits d'une absence de rang.
 *
 * La liste rendue est COMPLÈTE (bornée par la lecture : ≤ 500 entrées) : c'est le
 * composant qui en découpe la fenêtre visible et qui borne son défilement sur sa
 * longueur. `budget` est la hauteur de la vue — titre, mention de run vivant et
 * pied compris — donc l'arithmétique de la fenêtre reste au même endroit.
 */
export function buildSessionRows(
  view: SessionView,
  opts: { width: number; budget: number; glyphs: PanelGlyphs },
): PanelRow[] {
  const width = Math.max(1, Math.floor(opts.width));
  const innerW = Math.max(0, width - 4);
  const row = (content: string, tone: PanelTone): PanelRow => ({
    text: frame(opts.glyphs, content, width, innerW),
    tone,
  });
  if ("error" in view) return [row(`aucune entrée lisible — ${view.error}`, "warning")];
  if (view.entries.length === 0) return [row("aucune entrée à afficher", "muted")];
  const rows: PanelRow[] = [];
  if (view.truncated) rows.push(row("… début tronqué", "dim"));
  for (const entry of view.entries) {
    switch (entry.kind) {
      case "user":
        rows.push(row(`▸ toi : ${entry.text}`, "text"));
        break;
      case "assistant":
        rows.push(row(`▸ agent : ${entry.text}`, "accent"));
        break;
      case "toolCall":
        rows.push(row(`→ ${entry.name} ${entry.text}`, "dim"));
        break;
      case "toolResult":
        rows.push(row(`← ${entry.name} ${entry.text}`, "dim"));
        break;
      case "customMessage":
        rows.push(row(`· ${entry.customType} : ${entry.text}`, "dim"));
        break;
      case "custom":
        rows.push(row(`· ${entry.customType}`, "dim"));
        break;
    }
  }
  return rows;
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
/**
 * Surface de `KeybindingsManager` réellement utilisée par le panneau. Le nom du
 * keybinding est DÉRIVÉ de la signature de l'hôte (jamais réinventé) : un
 * paramètre plus large rendrait la fabrique non assignable à `ctx.ui.custom`.
 */
type HostKeybinding = Parameters<KeybindingsManager["matches"]>[1];
export type PanelKeybindings = { matches?: (data: string, keybinding: HostKeybinding) => boolean };

export type PanelComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
  /** Relecture du magasin — c'est exactement ce que déclenche le rafraîchissement périodique. */
  refresh(): void;
  dispose(): void;
};

export type PipelinesPanelDeps = {
  stateDir: string;
  /** Racine du dépôt : c'est elle qui identifie le lot que le panneau pilote. */
  repoRoot?: string;
  /** Les actions du lot ; absentes, le panneau reste en consultation (comportement d'avant les lots). */
  lot?: LotPanelActions;
  /** Horloge du temps écoulé : injectée, le temps affiché est donc testable. */
  now?: () => number;
  /** Ordonnanceur du rafraîchissement ; renvoie de quoi l'arrêter. */
  schedule?: (callback: () => void, ms: number) => () => void;
  /**
   * Rejoint la session d'un rang (feature du lot, entrée en cours, historique) :
   * la bascule réelle de `o`, qui ne reçoit qu'un fichier de session.
   */
  join: (entry: { sessionFile?: string | null }, close: () => void, showNotice: (message: string) => void) => void;
  /**
   * Le fichier de la session COURANTE de ce process (`ctx.sessionManager`), capturé
   * au montage : viser sa propre session est refusé (S-3, garde 2), parce que
   * `switchSession` avorte le tour courant avant même de regarder la cible. Absent
   * (contexte dégradé), la garde ne se déclenche pas.
   */
  currentSessionFile?: string | null;
};

/**
 * La sélection du panneau, mémorisée par RACINE DE DÉPÔT (S-5) : fermer puis
 * rouvrir rend le panneau sur la même ligne, sans commande à retaper. En mémoire
 * de process seulement — aucun fichier, aucune config, aucun partage entre
 * process — et l'index est re-borné au montage, donc une liste qui a changé ne
 * casse rien.
 */
const panelSelections = new Map<string, number>();

/** L'état de vue du panneau : la liste, ou la transcription d'une session (S-2). */
type PanelView =
  | { kind: "list" }
  | {
      kind: "session";
      sessionFile: string;
      label: string;
      phase: string;
      state: string;
      /** `hasLiveWriter` au moment du rendu : un run écrit-il cette session ? */
      live: boolean;
      /** Rangs remontés depuis la fin de la transcription : 0 = les plus récents. */
      scroll: number;
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
    /** La clé de la sélection mémorisée : une racine de dépôt, un état (S-5). */
    const selectionKey = deps.repoRoot ?? "";
    let notice: string | null = null;
    let mode: LotPanelMode = { kind: "browse" };
    // La VUE repart toujours de la liste : elle ne se quitte que par Échap, donc un
    // panneau fermé n'a jamais été fermé depuis la vue (S-5).
    let view: PanelView = { kind: "list" };
    /** Les rangs du DERNIER rendu : le clic y résout sa cible par index (S-4). */
    let drawn: PanelRow[] = [];
    /** Les rangs de CONTENU de la vue ouverte : leur nombre borne le défilement. */
    let drawnContent: PanelRow[] = [];
    let model = readPanelModel({
      stateDir: deps.stateDir,
      repoRoot: deps.repoRoot,
      selection: panelSelections.get(selectionKey) ?? 0,
      notice,
      mode,
    });

    /** Fige la sélection courante : c'est elle que le prochain montage restaurera (S-5). */
    const remember = () => panelSelections.set(selectionKey, model.selection);

    const paint = () => {
      model = readPanelModel({
        stateDir: deps.stateDir,
        repoRoot: deps.repoRoot,
        selection: model.selection,
        notice,
        mode,
      });
      // Une vue ouverte suit l'instant présent : le run peut avancer, se terminer,
      // ou la ligne changer de section pendant qu'on la regarde (S-2).
      if (view.kind === "session") {
        const row = rowForSession(view.sessionFile);
        if (row) {
          view = {
            ...view,
            label: rowLabel(row),
            phase: rowPhase(model, row),
            state: rowStateLabel(model, row),
            live: hasLiveWriter(model, row),
          };
        }
      }
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
    const setMode = (next: LotPanelMode) => {
      mode = next;
      notice = null;
      paint();
      tui.requestRender?.();
    };
    const isKey = (data: string, keybinding: HostKeybinding) => keybindings?.matches?.(data, keybinding) === true;

    // Le lot occupe la TÊTE de la liste sélectionnable : les rangs machine suivent.
    const features = (): LotFeature[] => model.lot?.features ?? [];
    const selectedFeature = (): LotFeature | undefined => {
      const index = model.selection;
      return index >= 0 && index < features().length ? features()[index] : undefined;
    };
    /** Le rang sélectionné, quelle que soit sa section — la seule façon d'atteindre une feature appariée. */
    const selectedRow = (): PanelRowRef | undefined => panelRowAt(model, model.selection);
    /** Le rang qui porte ce fichier de session : la vue le suit d'un rendu à l'autre. */
    const rowForSession = (file: string): PanelRowRef | undefined => {
      for (let i = 0; i < panelRowCount(model); i++) {
        const row = panelRowAt(model, i);
        if (row && rowSessionFile(model, row) === file) return row;
      }
      return undefined;
    };
    // Le déplacement efface la notice : elle décrit un rang, pas le panneau.
    const move = (delta: number) => {
      notice = null;
      model = {
        ...model,
        notice: null,
        selection: moveSelection(model.selection, panelRowCount(model), delta),
      };
      remember();
      tui.requestRender?.();
    };

    const remove = () => {
      const index = model.selection - features().length;
      // Un rang de lot ne se supprime pas : `x` le retire du lot (S-3) — le dire
      // vaut mieux qu'une touche muette. Une sélection vide reste muette.
      if (index < 0) {
        if (selectedFeature()) showNotice("seules les entrées d'historique se suppriment");
        return;
      }
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

    /**
     * Une action du lot : elle ne jette jamais. Son motif de refus devient la
     * notice du panneau ; un succès redessine (l'état affiché vient des fichiers).
     * `keep` est le mode de saisie à REPOSER tel quel — S-7 : « chaque action
     * refusée par le modèle (nom invalide, etc.) laisse le mode et affiche le motif
     * dans le rang de notice ». Refermer l'éditeur avant de soumettre ferait
     * retaper les trois champs d'un ajout pour un simple « déjà dans le lot ».
     */
    const act = (run: () => Promise<string | null>, keep?: LotPanelMode) => {
      const settle = (reason: string | null) => {
        if (reason === null) {
          if (keep) setMode({ kind: "browse" }); // un succès ferme la saisie
          else {
            notice = null;
            redraw();
          }
          return;
        }
        if (keep) setMode(keep);
        showNotice(reason);
      };
      void run()
        .then(settle)
        .catch((err: unknown) => settle(err instanceof Error ? err.message : String(err)));
    };

    /**
     * `Entrée` (S-2) : la VUE de session du rang sélectionné — jamais la bascule.
     * Un rang sans session garde la notice existante, et aucune vue ne s'ouvre.
     */
    const openView = () => {
      const row = selectedRow();
      if (!row) return;
      const file = rowSessionFile(model, row);
      if (!file) {
        showNotice(noSessionNotice(row));
        return;
      }
      // La notice n'est pas effacée : au retour, la liste est celle qu'on a quittée.
      view = {
        kind: "session",
        sessionFile: file,
        label: rowLabel(row),
        phase: rowPhase(model, row),
        state: rowStateLabel(model, row),
        live: hasLiveWriter(model, row),
        scroll: 0,
      };
      tui.requestRender?.();
    };

    /**
     * `o` (S-3) : la bascule RÉELLE dans la session du rang, sous deux gardes qui
     * répondent à la même question — le fichier visé est-il VIVANT ? Un run qui
     * l'écrit (deux écrivains sur un fichier de session, c'est une
     * `SessionWriteConflictError` garantie) ou notre propre session courante
     * (`switchSession` avorte le tour courant AVANT de regarder la cible).
     */
    const join = () => {
      const row = selectedRow();
      if (!row) return;
      if (hasLiveWriter(model, row)) {
        showNotice("run en cours — la session s'ouvre en lecture seule (Entrée) ; o attend la fin du maillon");
        return;
      }
      const file = rowSessionFile(model, row);
      const current = deps.currentSessionFile ?? null;
      if (file !== null && current !== null && realpathOr(file) === realpathOr(current)) {
        showNotice("la collecte se déroule dans ta session — réponds-y directement");
        return;
      }
      if (file === null) {
        showNotice(noSessionNotice(row));
        return;
      }
      deps.join({ sessionFile: file }, () => done(), showNotice);
    };

    /** Le nombre de rangs de contenu qu'une vue affiche : son titre et son pied sont payés. */
    const viewRoom = (height: number, live: boolean) => Math.max(1, height - 2 - (live ? 1 : 0));

    /** Défilement de la vue, borné aux rangs rendus : un cran en butée ne change rien. */
    const scrollView = (delta: number) => {
      if (view.kind !== "session") return;
      const max = Math.max(0, drawnContent.length - viewRoom(panelHeight(tui), view.live));
      view = { ...view, scroll: Math.min(Math.max(view.scroll + delta, 0), max) };
      tui.requestRender?.();
    };

    /**
     * Les touches de la VUE (S-2) : `Échap` revient à la liste telle qu'elle était,
     * `↑`/`k` et `↓`/`j` défilent, tout le reste est ignoré — aucune action de lot
     * n'est déclenchable depuis la vue, et elle ne ferme pas le panneau.
     */
    const handleViewKey = (data: string): void => {
      if (isKey(data, "tui.select.cancel")) {
        view = { kind: "list" };
        tui.requestRender?.();
        return;
      }
      // La fenêtre est ancrée sur la FIN (le run en cours se voit avancer) : monter
      // remonte le temps, descendre revient au présent.
      if (isKey(data, "tui.select.up") || data === "k") scrollView(1);
      else if (isKey(data, "tui.select.down") || data === "j") scrollView(-1);
    };

    /**
     * Un rapport de souris est toujours CONSOMMÉ (S-4) : ce n'est jamais du clavier.
     * Dans la liste, le clic gauche prend la ligne visée (`PanelRow.target`, posé par
     * le constructeur de rangs) et la molette vaut ±1 cran ; en mode de saisie,
     * l'éditeur en ligne garde le clavier ; dans la vue, seule la molette agit.
     */
    const handleMouse = (event: SgrMouseEvent): void => {
      if (view.kind === "session") {
        if (event.wheel !== null) scrollView(-event.wheel);
        return;
      }
      if (mode.kind !== "browse") return;
      if (event.wheel !== null) {
        move(event.wheel);
        return;
      }
      if (!event.leftClick) return;
      const target = drawn[event.row]?.target;
      // Cadre, titre, séparateur, marqueur, notice, pied, rang de remplissage : rien.
      if (target === undefined) return;
      notice = null;
      model = { ...model, notice: null, selection: target };
      remember();
      tui.requestRender?.();
    };

    /** L'éditeur en ligne : les caractères imprimables s'ajoutent, retour arrière efface. */
    const edit = (data: string, buffer: string): string | null => {
      if (data === "\x7f" || data === "\b") return buffer.slice(0, -1);
      if (data.length === 1 && data >= " " && buffer.length < LOT_EDITOR_MAX) return buffer + data;
      return null;
    };

    /** Les trois modes de saisie. Rend `true` quand la touche est consommée. */
    const handleMode = (data: string): boolean => {
      if (mode.kind === "browse") return false;
      if (isKey(data, "tui.select.cancel")) {
        setMode({ kind: "browse" });
        return true;
      }
      const lot = deps.lot;
      if (!lot) {
        showNotice("lot indisponible dans cette session");
        setMode({ kind: "browse" });
        return true;
      }
      const confirm = isKey(data, "tui.select.confirm");
      if (mode.kind === "cancel") {
        const fate: WorktreeFate | null = data === "1" ? "keep" : data === "2" ? "archive" : data === "3" ? "delete" : null;
        if (!fate) return true; // toute autre touche est ignorée : 1, 2, 3 ou Échap
        const slug = mode.slug;
        act(() => lot.cancel(slug, fate), mode);
        return true;
      }
      if (mode.kind === "answer") {
        if (confirm) {
          const text = mode.buffer.trim();
          if (text === "") {
            showNotice("réponse vide");
            return true;
          }
          const slug = mode.slug;
          act(() => lot.answer(slug, text), mode);
          return true;
        }
        const next = edit(data, mode.buffer);
        if (next !== null) setMode({ ...mode, buffer: next });
        return true;
      }
      if (confirm) {
        const draft = mode.draft;
        if (mode.step === "name") {
          if (mode.buffer.trim() === "") {
            showNotice("nom de feature requis");
            return true;
          }
          setMode({ kind: "add", step: "description", draft: { ...draft, name: mode.buffer.trim() }, buffer: "" });
          return true;
        }
        if (mode.step === "description") {
          setMode({ kind: "add", step: "deps", draft: { ...draft, description: mode.buffer.trim() }, buffer: "" });
          return true;
        }
        const input: AddFeatureInput = {
          name: draft.name,
          description: draft.description,
          deps: mode.buffer
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part !== ""),
        };
        act(() => lot.add(input), mode);
        return true;
      }
      const next = edit(data, mode.buffer);
      if (next !== null) setMode({ ...mode, buffer: next });
      return true;
    };

    const handleBrowse = (data: string): void => {
      // Fermer : Échap (`app.interrupt`) ou Ctrl+C, les deux du select.cancel d'OMP.
      if (isKey(data, "tui.select.cancel")) {
        done();
        return;
      }
      if (isKey(data, "tui.select.up") || data === "k") {
        move(-1);
        return;
      }
      if (isKey(data, "tui.select.down") || data === "j") {
        move(1);
        return;
      }
      if (data === "d") {
        remove();
        return;
      }
      if (isKey(data, "tui.select.confirm")) {
        openView();
        return;
      }
      if (data === "o") {
        join();
        return;
      }
      const lot = deps.lot;
      // Toute action du lot exige le pilote : sans lui, le panneau reste en lecture.
      const requireLot = (): LotPanelActions | null => {
        if (lot) return lot;
        showNotice("lot indisponible dans cette session");
        return null;
      };
      if (data === "a") {
        const actions = requireLot();
        if (!actions) return;
        setMode({ kind: "add", step: "name", draft: { name: "", description: "", deps: "" }, buffer: "" });
        return;
      }
      if (data === "l") {
        const actions = requireLot();
        if (actions) act(() => actions.launch());
        return;
      }
      if (data === "x") {
        const feature = selectedFeature();
        if (!feature) {
          showNotice("retrait possible sur une feature qui n'a pas démarré");
          return;
        }
        const actions = requireLot();
        if (actions) act(() => actions.remove(feature.slug));
        return;
      }
      if (data === "i") {
        const feature = selectedFeature();
        if (!feature || feature.state !== "waiting" || feature.waitKind !== "answer") {
          showNotice("rien à répondre sur cette ligne");
          return;
        }
        if (feature.origin === "session" && feature.phase === "req") {
          showNotice("la collecte se déroule dans ta session — réponds-y directement");
          return;
        }
        const actions = requireLot();
        if (actions) setMode({ kind: "answer", slug: feature.slug, buffer: "" });
        return;
      }
      if (data === "v") {
        const feature = selectedFeature();
        if (!feature || feature.state !== "waiting" || feature.waitKind !== "specs") {
          showNotice("rien à valider : la feature n'est pas au jalon des specs");
          return;
        }
        const actions = requireLot();
        if (actions) act(() => actions.validate(feature.slug));
        return;
      }
      if (data === "y") {
        const feature = selectedFeature();
        if (!feature || feature.state !== "waiting" || feature.waitKind !== "review") {
          showNotice("rien à accepter : la revue n'est pas propre");
          return;
        }
        const actions = requireLot();
        if (actions) act(() => actions.accept(feature.slug));
        return;
      }
      if (data === "R") {
        const feature = selectedFeature();
        if (!feature || (feature.state !== "blocked" && feature.state !== "failed")) {
          showNotice("relance possible sur une feature bloquée ou échouée");
          return;
        }
        const actions = requireLot();
        if (actions) act(() => actions.relaunch(feature.slug));
        return;
      }
      if (data === "c") {
        const feature = selectedFeature();
        if (!feature) {
          showNotice("annulation impossible : sélectionne une feature du lot");
          return;
        }
        if (lotStateTerminal(feature.state)) {
          showNotice(`annulation impossible : la feature est ${lotStateLabel(feature.state)}`);
          return;
        }
        const actions = requireLot();
        if (actions) setMode({ kind: "cancel", slug: feature.slug });
        return;
      }
    };

    const stop = schedule(() => redraw(), PANEL_REFRESH_MS);

    /**
     * Les rangs de la VUE de session (S-2) : titre remplacé par le rang du rang
     * regardé, mention de run vivant s'il y en a un, transcription du fichier — relue
     * à chaque rendu, donc au rythme du rafraîchissement — puis le pied de la vue.
     * La fenêtre est ancrée sur la FIN : un run en cours se voit avancer sans rien
     * toucher, et remonter (molette, `↑`) révèle le plus ancien.
     */
    const renderView = (width: number, height: number): PanelRow[] => {
      if (view.kind !== "session") return [];
      const innerW = Math.max(0, width - 4);
      const rows: PanelRow[] = [
        {
          text: topRule(
            glyphs,
            `${view.label} · /${view.phase} · ${view.state} · session ${path.basename(view.sessionFile)}`,
            width,
          ),
          tone: "accent",
        },
      ];
      if (view.live) {
        rows.push({ text: frame(glyphs, "run en cours — lecture seule", width, innerW), tone: "warning" });
      }
      const content = buildSessionRows(readSessionView(view.sessionFile), { width, budget: height, glyphs });
      drawnContent = content;
      const room = viewRoom(height, view.live);
      const start = Math.max(0, content.length - room - view.scroll);
      for (const row of content.slice(start, start + room)) rows.push(row);
      rows.push({ text: bottomRule(glyphs, "↑↓/molette défiler · Échap revenir au panneau", width), tone: "border" });
      return rows;
    };

    return {
      render(width: number): string[] {
        const height = panelHeight(tui);
        const rows =
          view.kind === "session"
            ? renderView(width, height)
            : buildPanelRows(model, { width, budget: panelBudget(height), glyphs, now: now() });
        // Le remplissage est le fait du COMPOSANT : le constructeur de rangs, lui,
        // tient toujours dans son budget (contrat verrouillé par les tests).
        drawn = fillPanelHeight(rows, width, height);
        return drawn.map((row) => theme.fg(row.tone, row.text));
      },
      handleInput(data: string): void {
        // La souris d'abord : un rapport SGR n'est jamais du clavier (S-4). Puis la
        // VUE, avant les modes et la liste : aucune touche du panneau ne l'atteint.
        const mouse = parseSgrMouse(data);
        if (mouse) {
          handleMouse(mouse);
          return;
        }
        if (view.kind === "session") {
          handleViewKey(data);
          return;
        }
        if (handleMode(data)) return;
        handleBrowse(data);
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

export type PipelinePhase = "req" | "specs" | "impl" | "review" | "release";
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
    // La livraison est le DERNIER maillon : plus rien à annoncer après elle (le
    // push et la PR sont faits par le pilote du lot, cf. `releaseArgs`).
    case "release":
      return { kind: "cycle-end" };
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

  const pipelineDeps = (ctx: PipelineCtx): PublishDeps => ({ ctx, notify: notifyDurable, stateDir: storeDir() });

  // `gh` : même doctrine que git (jamais node:child_process, runner câblé sur
  // `pi.exec`), avec un budget plus large — c'est du réseau, pas une commande
  // locale (cf. `## Documentation` §4).
  const GH_TIMEOUT_MS = 60_000;
  const runGh = async (args: string[], cwd: string): Promise<GitResult> => {
    try {
      const res = await pi.exec("gh", args, { cwd, timeout: GH_TIMEOUT_MS });
      return {
        code: res.killed ? 124 : res.code,
        stdout: res.stdout ?? "",
        stderr: res.killed ? `gh ${args[0]} : délai dépassé (${GH_TIMEOUT_MS} ms)` : (res.stderr ?? ""),
      };
    } catch (err) {
      return { code: 127, stdout: "", stderr: (err as Error).message };
    }
  };

  // --- drapeaux du mode worker, et pilote du lot ----------------------------
  // Les drapeaux sont déclarés AU CHARGEMENT : un drapeau inconnu du CLI est une
  // erreur dure, et un run de lot est lancé avec ces quatre-là (`buildLotRunArgv`,
  // cf. `## Documentation` §2).
  pi.registerFlag("pipeline-lot", { type: "string", description: "Lot propriétaire de ce run (mode worker)" });
  pi.registerFlag("pipeline-feature", { type: "string", description: "Feature de ce run (mode worker)" });
  pi.registerFlag("pipeline-phase", {
    type: "string",
    description: "Maillon de ce run : req, specs, impl, review ou release",
  });
  pi.registerFlag("pipeline-state-dir", {
    type: "string",
    description: "Répertoire du magasin d'état des pipelines",
  });

  // Mode worker : ce process EST un maillon du lot. Il publie son état, exécute le
  // prompt reçu en argv et n'annonce rien — la chaîne appartient au pilote.
  //
  // Les drapeaux sont relus À CHAQUE FOIS, jamais au chargement : le CLI applique
  // les drapeaux d'extension APRÈS avoir chargé les extensions (`## Documentation`
  // §2), donc un `pi.getFlag` évalué à l'import rend toujours `undefined`.
  const workerMode = (): WorkerMode | null => workerModeOf(pi);

  /**
   * Le magasin d'état de CE process : le drapeau d'un run de lot fait autorité
   * (le pilote peut avoir un magasin que l'environnement de l'enfant ne dit pas),
   * sinon `MEM0_PIPELINE_STATE_DIR` puis `~/.omp/agent/pipeline`. Toutes les
   * écritures du registre passent par ici — sans quoi un run de lot publierait
   * dans le magasin par défaut de la machine au lieu de celui de son lot.
   */
  const storeDir = (): string => workerMode()?.stateDir ?? pipelineStateDir();

  let lotController: { repoRoot: string; controller: LotController } | null = null;

  /**
   * Le pilote du dépôt de cette session, un par process : le lot n'a qu'un
   * écrivain. Deux sessions du même dépôt ne se marchent pas dessus — la seconde
   * ne reprend la main que si le pid de la première est mort.
   */
  const controllerFor = (ctx: ExtensionContext): LotController => {
    const root = resolveFeatureRoot(ctx.cwd);
    const repoRoot = root.primary ?? root.dir;
    if (lotController && lotController.repoRoot === repoRoot) return lotController.controller;
    lotController?.controller.stop();
    const controller = createLotController({
      stateDir: storeDir(),
      repoRoot,
      run: async ({ argv, cwd, timeout, signal }) => {
        const res = await pi.exec(argv[0] ?? "omp", argv.slice(1), { cwd, timeout, signal });
        return {
          code: res.killed ? 124 : res.code,
          killed: res.killed === true,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
        };
      },
      runGit: run,
      runGh,
      notify: notifyDurable,
      toast: (text, tone) => ctx.ui?.notify?.(text, tone),
      session: () => ({ file: sessionFileOf(ctx as PipelineCtx), id: sessionIdOf(ctx as PipelineCtx) }),
      selfPath: selfExtensionArg(SELF_MODULE_URL),
      schedule: (callback, ms) => {
        // Minuterie GÉRÉE : nettoyée au `session_shutdown`, jamais orpheline. Un
        // contexte dégradé (hors OMP complet) n'a pas de minuterie : le pilote
        // tourne alors à la demande (chaque action relance une passe).
        if (typeof ctx.setInterval !== "function" || typeof ctx.clearTimer !== "function") return () => {};
        const timer = ctx.setInterval(callback, ms);
        return () => ctx.clearTimer(timer);
      },
    });
    lotController = { repoRoot, controller };
    return controller;
  };

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
      stateDir: storeDir(),
      repoRoot: (() => {
        const root = resolveFeatureRoot(ctx.cwd);
        return root.primary ?? root.dir;
      })(),
      lot: workerMode() ? undefined : controllerFor(ctx),
      // La session VIVANTE de ce process : viser sa propre session est refusé (S-3).
      currentSessionFile: sessionFileOf(ctx as PipelineCtx),
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
          // Plein écran ET souris (S-4) : plus d'ancre, plus de largeur, plus de
          // hauteur maximale — le cadre EST l'écran, et `mouseTracking` est ce qui
          // fait émettre les rapports de clic et de molette.
          overlayOptions: { fullscreen: true, mouseTracking: true },
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
    // Un run de lot arme SON maillon et le publie : il apparaît dans /pipelines
    // dès le démarrage, et un maillon `req` reçoit la directive de collecte.
    const mode = workerMode();
    if (mode) {
      stateOfCwd(ctx.cwd).reqMode = mode.phase === "req";
      armPipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, mode.phase);
      return;
    }
    // Session ordinaire : si le lot de ce dépôt n'a plus de pilote, on le reprend.
    const controller = controllerFor(ctx);
    if (controller.adopt()) controller.start();
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

      // La feature entre dans le lot du dépôt AVANT la relocalisation : sa collecte
      // se déroule dans cette session (`origin: "session"`), et le pilote prend la
      // main à sa clôture (S-14). Si la collecte n'aboutit pas, la feature reste
      // visible dans le panneau, en attente de cette session.
      const lotDriver = controllerFor(ctx);
      const refused = lotDriver.enrol({ slug, name: typed || slug, branch: created.branch, worktree: created.path });
      // Un lot conduit par une session vivante ne s'écrit pas (S-1) : la feature
      // n'y entre pas, et cette session le dit au lieu de laisser croire qu'elle
      // est pilotée par le lot de l'autre (elle garde la chaîne manuelle, S-14).
      if (refused) ctx.ui?.notify?.(`[req] ${refused} — cette feature garde la chaîne manuelle.`, "warning");

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
      // Le pilote tourne : les AUTRES features du lot (s'il y en a) avancent
      // pendant cette collecte, et celle-ci sera prise en charge à sa clôture.
      // Une feature refusée n'appartient à aucun lot : aucun pilote à faire tourner.
      if (!refused) lotDriver.start();
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
      // Un seul acteur écrit un contrat à la fois : si le lot pilote cette feature,
      // la commande manuelle s'efface (S-14).
      const driving = lotDriverFor(storeDir(), repoRootOf(ctx.cwd), ctx.cwd);
      if (driving) {
        ctx.ui?.notify?.(
          `[specs] cette feature est pilotée par le lot ${path.basename(driving.repoRoot)} — ` +
            "pilote-la depuis /pipelines (ou annule-la pour reprendre à la main).",
          "warning",
        );
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
      const driving = lotDriverFor(storeDir(), repoRootOf(ctx.cwd), ctx.cwd);
      if (driving) {
        ctx.ui?.notify?.(
          `[impl] cette feature est pilotée par le lot ${path.basename(driving.repoRoot)} — ` +
            "pilote-la depuis /pipelines (ou annule-la pour reprendre à la main).",
          "warning",
        );
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
      const driving = lotDriverFor(storeDir(), repoRootOf(ctx.cwd), ctx.cwd);
      if (driving) {
        ctx.ui?.notify?.(
          `[review] cette feature est pilotée par le lot ${path.basename(driving.repoRoot)} — ` +
            "pilote-la depuis /pipelines (ou annule-la pour reprendre à la main).",
          "warning",
        );
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
      // Une notice n'est pas une entrée de l'utilisateur : jamais de clôture sur
      // son contenu — mais la directive reste due, le mode collecte étant actif.
      return { systemPrompt: [...event.systemPrompt, SYSTEM_DIRECTIVE_REQ] };
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
      // Un run de lot : le maillon a rendu la main. Il clôt son entrée du magasin
      // et n'annonce RIEN — la chaîne appartient au pilote (S-13).
      if (workerMode()) {
        try {
          closePipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "done");
        } catch (err) {
          reportStateWriteFailure(pipelineDeps(ctx as PipelineCtx), err);
        }
        return;
      }
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

      // BASCULE VERS LE LOT (S-14) : la collecte d'une feature de lot est close
      // (besoins écrits) — le pilote prend la main sur /specs, et cette session
      // n'annonce plus rien pour elle.
      const controller = controllerFor(ctx);
      const handed = handOverCollecte({
        stateDir: storeDir(),
        repoRoot: repoRootOf(ctx.cwd),
        cwd: ctx.cwd,
        contract,
        sessionFile: sessionFileOf(ctx as PipelineCtx),
        notify: notifyDurable,
      });
      if (handed) {
        try {
          closePipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "done");
        } catch (err) {
          reportStateWriteFailure(pipelineDeps(ctx as PipelineCtx), err);
        }
        controller.start();
        pi.sendMessage(
          {
            customType: "pipeline",
            content: "[pipeline] la chaîne du lot prend la main — avancement dans /pipelines",
            display: true,
            attribution: "user",
          },
          { triggerTurn: false },
        );
        return;
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
