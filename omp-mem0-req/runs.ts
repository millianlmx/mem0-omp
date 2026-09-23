// Runs : argv d'un maillon, prompts, livraison, devenir du worktree.
import * as fs from "node:fs";
import * as path from "node:path";
import { contractHasSection } from "./contract.ts";
import type { PipelinePhase } from "./contract.ts";
import { branchFor, isUnder, realpathOr, resolveFeatureRoot, worktreePathFor } from "./git.ts";
import type { GitRunner } from "./git.ts";
import { lotRepoKey, lotStateTerminal, readLot, writeLot } from "./lot.ts";
import type { Lot } from "./lot.ts";
import type { SessionProbe } from "./panelSession.ts";
import { reportStateWriteFailure } from "./publish.ts";
import { buildImplSeed, buildReviewSeed, buildSpecsSeed } from "./seeds.ts";
import { PIPELINE_PHASES, pidAlive, readStore } from "./store.ts";



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
  /**
   * La boîte du run (S-6) : le dossier que l'enfant consomme pour recevoir un
   * message en cours de tour et une réponse `ask`. Absente (création impossible),
   * le run part NON armé — exactement comme un run d'une version antérieure.
   */
  inbox?: string | null;
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
  if (spec.inbox) argv.push("--panel-inbox", spec.inbox);
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
export const SELF_MODULE_URL: string | undefined = (() => {
  try {
    return (import.meta as { url?: string }).url;
  } catch {
    return undefined;
  }
})();


export type LotPromptKind = "collecte" | "phase" | "answer" | "relaunch";


/** Ce qu'un run de conversation reprend (S-9) : un rang du panneau, sa session, sa boîte. */
export type ConversationRunTarget = {
  cwd: string;
  sessionFile: string;
  label: string;
  phase: PipelinePhase;
  inbox: string;
};


/**
 * L'argv exact d'un run de conversation (S-9) : `--resume` continue LE MÊME
 * fichier de session — la réponse et la suite s'ajoutent à la conversation
 * ouverte —, le texte de l'utilisateur suit `--` sans préfixe, et
 * `--panel-inbox` arme le run pour qu'un second message l'atteigne en cours de
 * tour. `--pipeline-phase` porte le maillon du rang : le run publie son entrée
 * sous ce maillon, sans être un worker (aucun `--pipeline-lot`, donc aucune
 * chaîne à conduire).
 */
export function buildConversationRunArgv(spec: {
  ompBin: string;
  target: ConversationRunTarget;
  stateDir: string;
  prompt: string;
  selfPath?: string | null;
}): string[] {
  const argv = [
    spec.ompBin,
    "--cwd",
    spec.target.cwd,
    "-p",
    "--auto-approve",
    "--resume",
    spec.target.sessionFile,
    "--pipeline-phase",
    spec.target.phase,
    "--pipeline-state-dir",
    spec.stateDir,
    "--panel-inbox",
    spec.target.inbox,
  ];
  if (spec.selfPath) argv.push("-e", spec.selfPath);
  argv.push("--", spec.prompt);
  return argv;
}


/**
 * Les deux pré-contrôles d'un run de conversation (S-9), décidés SANS rien lancer :
 * un cwd disparu ou une session introuvable serait un run qui échoue après coup,
 * alors que le motif se lit tout de suite dans la zone du panneau.
 */
export function conversationRefusal(target: ConversationRunTarget, probe: SessionProbe): string | null {
  if (!probe.isDirectory(target.cwd)) return "écriture impossible : le répertoire de travail du rang n'existe plus";
  if (!probe.isSessionFile(target.sessionFile)) return "écriture impossible : la session du rang est introuvable";
  return null;
}


/**
 * Le préambule de tout run de lot. Trois règles non négociables : la question
 * bloquante passe par l'outil `ask` quand le run en dispose (un run lancé par le
 * panneau est armé, S-7) et par un texte numéroté sinon (S-8 §1), et la chaîne
 * n'appartient pas à l'agent — le pilote la décide (`nextChainAction`).
 */
export const LOT_WORKER_DIRECTIVE = `Mode lot : tu tournes dans un pipeline, sans interface.
- L'outil \`ask\` EST disponible dans ce run : pose-lui tes questions bloquantes, UNE à la fois, avec 1 à 9 options ; la question s'affiche dans le panneau de la pipeline et l'utilisateur y répond, dans le tour en cours. Si l'outil refuse (plusieurs questions, multi-sélection) ou si tu préfères le texte, termine ton tour par tes questions numérotées et actionnables : elles s'affichent aussi dans le panneau, et la réponse te reviendra au tour suivant. Quand une question propose des choix, écris-les une par ligne sous la forme \`- (1) <libellé du choix>\` : c'est cette forme, et elle seule, que le panneau rend sélectionnable.
- N'annonce aucune commande et n'enchaîne aucun maillon de toi-même : la chaîne est pilotée par le lot.
- Le contrat de cette feature vit dans .omp/pipeline/contract.md, relatif à ton répertoire de travail.`;


/** La graine d'un maillon : les quatre existantes, plus la livraison. */
export function phaseSeed(input: { phase: PipelinePhase; slug: string; fix: boolean; focus: string }): string {
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
 *
 * `messages` (S-5) sont les textes mis en file depuis le panneau : ils s'ajoutent
 * APRÈS le prompt, un bloc par message, dans l'ordre — et aucun préfixe existant
 * ne bouge (`isPipelineNotice` et `saysFin` gardent leurs déclenchements).
 */
export function buildLotPrompt(input: {
  kind: LotPromptKind;
  phase: PipelinePhase;
  slug: string;
  description?: string;
  text?: string;
  focus?: string;
  fix?: boolean;
  messages?: string[];
}): string {
  const seed = phaseSeed({ phase: input.phase, slug: input.slug, fix: input.fix === true, focus: input.focus ?? "" });
  let prompt: string;
  if (input.kind === "collecte") {
    const intent = (input.description ?? "").trim();
    prompt = `[req] Feature « ${input.slug} »${intent ? ` — intention déclarée : ${intent}` : ""}\n\n${LOT_WORKER_DIRECTIVE}`;
  } else if (input.kind === "answer") {
    prompt =
      `[réponse de l'utilisateur] ${(input.text ?? "").trim()}\n\n` +
      `Maillon courant : /${input.phase}. Lis le contrat .omp/pipeline/contract.md pour l'état de la feature.\n\n` +
      LOT_WORKER_DIRECTIVE;
  } else if (input.kind === "relaunch") {
    prompt =
      "[reprise] Le maillon est relancé par l'utilisateur : reprends où tu t'es arrêté, " +
      `sans élargir le périmètre.\n\n${seed}\n\n${LOT_WORKER_DIRECTIVE}`;
  } else {
    prompt = `${seed}\n\n${LOT_WORKER_DIRECTIVE}`;
  }
  const queued = (input.messages ?? []).map((message) => message.trim()).filter((message) => message !== "");
  if (queued.length === 0) return prompt;
  const blocks = queued.map((message) => `[message de l'utilisateur, envoyé depuis /pipelines]\n${message}`);
  return `${prompt}\n\n${blocks.join("\n\n")}`;
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
