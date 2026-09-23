// Worktrees de feature : création, résolution, balayage.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONTRACT_PATH } from "./contract.ts";



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
export function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}


// Strictement sous : `<base>` lui-même n'est pas un candidat.
export function isUnder(child: string, parent: string): boolean {
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


export const LINK_GATE_REFUSAL =
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
