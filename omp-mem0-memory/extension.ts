// omp-mem0-memory — mémoire mem0 (Qdrant + oMLX) intégrée nativement dans OMP.
//
// Ce que ça fait, et rien de plus :
//   1. Au premier contact avec un projet : pose le brief mémoire tout seul —
//      écrit .omp/mem0-brief.md et cite ce fichier dans AGENTS.md. Idempotent,
//      une seule fois par projet, rien à installer à la main.
//   2. Rappel à CHAQUE tour : recherche sur le prompt brut, filtrée par un
//      plancher de score, injectée silencieusement dans le même tour. Le
//      sommaire exhaustif de la mémoire du projet part dans le system prompt,
//      donc la consultation cesse d'être spéculative.
//   3. Agrafage : le souvenir qui concerne les arguments d'un read/grep/glob/
//      lsp/edit/write est posé en tête du résultat de l'outil, sans amputer
//      ce résultat et sans aucun appel réseau.
//   4. Aucune écriture automatique : c'est l'agent qui écrit. Une relance
//      unique en fin de session le rappelle quand il a modifié des fichiers
//      sans rien mémoriser.
//   5. Quatre tools explicites : mem0_search / mem0_add / mem0_update / mem0_forget.
//
// La mémoire est scopée PAR PROJET (agent_id = nom du projet), avec un scope
// "global" séparé pour les préférences transverses. Les deux sont interrogés en
// parallèle au recall.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MEM0_HTTP_URL = process.env.MEM0_HTTP_URL || "http://localhost:8321";
const MEM0_HTTP_TOKEN = process.env.MEM0_HTTP_TOKEN || "";

// Budgets par opération. `add` avec infer=true déclenche DEUX passes LLM côté
// serveur (extraction de faits + fusion avec l'existant) : sur qwen3-8b en local
// c'est couramment 10 à 60 s. Un budget global de quelques secondes ferait
// échouer silencieusement toutes les écritures.
// Le budget de recherche doit couvrir un premier appel à froid : l'embedding
// local (oMLX) charge son modèle à la première requête de la session. 3 s
// suffisaient à faire échouer TOUS les rappels en silence.
const TIMEOUT = { search: 20_000, write: 120_000, other: 10_000 };

const RECALL_LIMIT = 5; // souvenirs projet injectés par tour
const RECALL_GLOBAL_LIMIT = 2; // + préférences transverses
const RECALL_MIN_PROMPT = 12; // en dessous ("ok", "continue"), on ne cherche pas
// Plancher envoyé au serveur. ATTENTION à la sémantique, vérifiée dans le source de
// mem0 2.0.20 (`score_and_rank`) : `threshold` filtre le score SÉMANTIQUE brut avant
// fusion, alors que le `score` renvoyé dans les résultats est le score COMBINÉ
// (sémantique + bm25 + boost entités) divisé par le nombre de signaux actifs. Les deux
// ne sont donc pas comparables : on ne calibre pas ce plancher sur les scores affichés.
// Mesuré sur la base réelle : à 0.4, les cinq requêtes pertinentes de contrôle
// renvoient toutes des résultats et "quelle est la couleur du bouton de connexion"
// n'en renvoie aucun ; à 0.45 une vraie question ("à quoi sert EMBEDDING_DIMS") est
// déjà perdue. C'est le sommaire exhaustif, pas le seuil, qui rattrape un rappel qui rate.
const RECALL_THRESHOLD = 0.4;
// Plancher du search EXPLICITE (tool mem0_search). Sans lui, mem0 applique son
// défaut 0.1 = « renvoie tout » : une requête hors-sujet ramène les souvenirs les
// plus proches quand même (mesuré : « recette de tarte… » → 8 résultats bruités à
// 0.1, → 0 à 0.4). Même sémantique de gate sémantique brut que RECALL_THRESHOLD ;
// constante séparée pour la régler indépendamment du rappel.
const SEARCH_THRESHOLD = 0.4;
const RECALL_LINE_CHARS = 100; // aperçu d'un souvenir dans le transcript, une ligne
const RECALL_MESSAGE_TYPE = "mem0-recall";
// Le bloc de rappel est visible par défaut : un rappel muet ne se distingue pas d'un rappel absent.
const RECALL_DISPLAY = process.env.MEM0_QUIET !== "1";
const INDEX_MAX_ENTRIES = 60; // au-delà, sommaire tronqué aux plus récents
const INDEX_LINE_CHARS = 100; // longueur d'une ligne de sommaire

// Agrafage d'un souvenir au résultat d'un outil d'exploration.
const PIN_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, lsp: true, edit: true, write: true };
const PIN_MIN_RATIO = 0.5; // part des tokens de l'argument retrouvés dans le souvenir
const PIN_COMMON_RATIO = 0.4; // au-delà, un token est trop répandu pour être informatif
const PIN_TEXT_CHARS = 700; // longueur du souvenir agrafé

// Compteurs par outil : ce qui compte comme exploration, ce qui compte comme
// modification. `mutations > 0 && adds === 0` en fin de session déclenche la relance.
const EXPLORE_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, lsp: true };
const MUTATE_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, apply_patch: true };

// ---------------------------------------------------------------------------
// Checkpoint exploration — déclenche un rappel d'écriture quand l'agent explore
// trop sans écrire. Une phase enregistrée active compresse le seuil.
// ---------------------------------------------------------------------------

const CHECKPOINT_THRESHOLD_NORMAL = 15;
const CHECKPOINT_MESSAGE_TYPE = "mem0-checkpoint";
// Session de pure discussion (needs, specs, archi) : aucune édition de fichier,
// donc le nudge de fin fondé sur `mutations` ne tire jamais. Au-delà de ce
// nombre de tours substantiels sans écriture mémoire, on relance une fois en
// fin de session pour capturer ce qui a été décidé.
const DISCUSSION_MIN_TURNS = 4;

function nudgeText(mutations: number): string {
  return (
    `[mem0] Cette session a modifié ${mutations} fichier(s) et n'a rien écrit en mémoire. ` +
    `Avant de conclure : un fait de cette session sera-t-il encore vrai dans six mois — décision ` +
    `d'architecture et sa raison, bug avec sa cause racine et son correctif, convention du dépôt, ` +
    `exigence non négociable ? Si oui, appelle mem0_add maintenant : un fait par appel, autoportant, ` +
    `en nommant fichiers et symboles. Si non, dis en une phrase qu'il n'y a rien à retenir et termine.`
  );
}

function discussionNudgeText(turns: number): string {
  return (
    `[mem0] Cette session a échangé ${turns} tour(s) substantiel(s) sans modifier de fichier ` +
    `ni rien écrire en mémoire. Une discussion de besoins, de specs ou d'architecture produit ` +
    `souvent du durable : besoin arrêté, décision et sa raison, contrainte non négociable, ` +
    `convention retenue. Si c'est le cas, appelle mem0_add maintenant — un fait par appel, ` +
    `autoportant, en nommant fichiers et symboles. Si la session n'a rien décidé de permanent, ` +
    `dis-le en une phrase et termine.`
  );
}

/**
 * Politique de relance de fin de session — pure et exportée pour être testée
 * hors runtime. Rend le message à injecter, ou null s'il n'y a rien à capturer.
 * L'idempotence (`nudged`) reste au handler ; cette fonction ne décide que du
 * QUOI, pas du COMBIEN DE FOIS. Priorité : rien si déjà écrit (adds), sinon le
 * travail de code (mutations), sinon la discussion substantielle sans édition.
 */
export function pickSessionStopNudge(input: {
  adds: number;
  mutations: number;
  substantiveTurns: number;
}): string | null {
  if (input.adds > 0) return null;
  if (input.mutations > 0) return nudgeText(input.mutations);
  if (input.substantiveTurns >= DISCUSSION_MIN_TURNS) return discussionNudgeText(input.substantiveTurns);
  return null;
}

// Dedup à l'écriture. Le `score` sur lequel on filtre est celui renvoyé par mem0,
// donc le score COMBINÉ (sémantique + bm25 normalisé) / nombre de signaux : depuis
// l'activation de fastembed il n'est plus un cosinus, et un texte qui reprend les
// mêmes mots-clés qu'un souvenir voisin y monte très haut sans dire la même chose.
// 0.55 attrape les reformulations ; DEDUP_SCORE_LONG relève le plancher sur les
// paragraphes, où deux faits sans rapport atteignent facilement 0.60-0.79 juste
// parce qu'ils parlent d'architecture du même projet (constaté deux fois en audit).
// Le garde-fou qui porte réellement est lexical : sans recouvrement de tokens, pas
// de concaténation, quel que soit le score.
const DEDUP_SCORE = 0.55;
const DEDUP_CANDIDATES = 5;
const DEDUP_CONTAINED = 0.9; // couverture lexicale au-delà de laquelle un fait en absorbe un autre
const DEDUP_LONG_CHARS = 400;
const DEDUP_SCORE_LONG = 0.75;
const DEDUP_MERGE_MIN_COVERAGE = 0.35;
// Le nettoyage rétroactif (/mem0-dedupe) est plus permissif : il n'a pas le
// filtre vectoriel en amont, il est en simulation par défaut, et les doublons
// déjà en base sont des reformulations qui plafonnent vers 0.75-0.85.
const DEDUPE_SWEEP_CONTAINED = 0.75;
// Aperçu de /mem0-dedupe. Le souvenir SUPPRIMÉ est rendu en entier : c'est lui
// qu'on détruit, un id ne se relit pas. La tête conservée suffit en extrait.
const DEDUPE_PREVIEW_KEEP_CHARS = 240;
const DEDUPE_PREVIEW_LOST_TOKENS = 12;
const MERGED_MAX_CHARS = 1_400;

const GLOBAL_SCOPE = "_global";

// MEM0_AUTOSETUP=0 pour ne jamais écrire dans un dépôt.
const AUTOSETUP = process.env.MEM0_AUTOSETUP !== "0";

// ---------------------------------------------------------------------------
// Phases — rôles nommés qu'on active sur une session (/set-phase). À la fin d'une
// phase (l'agent a rendu la main → session_stop), on cherche en mémoire les
// instructions de la phase et on les DÉLÈGUE à l'agent : l'extension n'édite
// jamais un fichier elle-même. Registry global (partagé entre projets), persisté.
// ---------------------------------------------------------------------------

const PHASES_FILE = path.join(os.homedir(), ".omp", "agent", "phases.json");

type PhaseEntry = { brief: string };

function loadPhases(): Map<string, PhaseEntry> {
  try {
    const raw = fs.readFileSync(PHASES_FILE, "utf8");
    const entries: Record<string, PhaseEntry> = JSON.parse(raw);
    return new Map(Object.entries(entries));
  } catch {
    return new Map();
  }
}

function savePhases(reg: Map<string, PhaseEntry>): void {
  const obj: Record<string, PhaseEntry> = {};
  for (const [name, entry] of reg) obj[name] = entry;
  try {
    fs.mkdirSync(path.dirname(PHASES_FILE), { recursive: true });
    fs.writeFileSync(PHASES_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    /* best-effort : un registry non persistable ne doit pas casser une session */
  }
}

const DEFAULT_PHASES: string[] = ["release", "version-bump", "deploy", "review"];

// Chargé une fois au chargement du module ; muté par /add-phase, /remove-phase, /set-phase --default.
let phases = loadPhases();

// Repère un souvenir qui porte une instruction à exécuter. C'est l'agent qui
// juge et agit ; ce test ne fait que décider quels souvenirs lui présenter.
const EXECUTION_KEYWORDS = ["version", "bump", "commit", "release"];
const EXECUTABLE_RE = /\b(MUST|EXECUTE|TODO|ACTION|DO|RUN)\s*[:：。]/i;

// ---------------------------------------------------------------------------
// Le brief — source de vérité, embarquée ici pour que l'extension reste
// autonome une fois copiée dans ~/.omp/extensions/.
// ---------------------------------------------------------------------------

const BRIEF_VERSION = "v3";
const BRIEF_REF_PATH = path.join(".omp", "mem0-brief.md");
const MARKER_OPEN = `<!-- mem0:brief ${BRIEF_VERSION} -->`;
const MARKER_CLOSE = "<!-- /mem0:brief -->";
const MARKER_ANY = /<!--\s*mem0:brief(?:\s+v(\d+))?\s*-->/;

// Bloc court, collé dans AGENTS.md : il est dans le contexte à chaque tour,
// donc il reste court. Les détails vivent dans le fichier de référence.
const AGENTS_BLOCK = `${MARKER_OPEN}
## Mémoire du projet

Une mémoire persistante (mem0) est branchée sur ce projet. Un rappel automatique
est injecté à chaque tour, mais il est calé sur la formulation de la demande : dès
que la conversation se déplace vers un sujet que ce rappel ne couvre pas, appelle
\`mem0_search\` **avant** de lire le code ou de proposer une solution. C'est moins
cher qu'une exploration de dépôt, et c'est la seule façon de retrouver un bug déjà
corrigé ou une décision déjà tranchée.

Appelle \`mem0_search\` en particulier avant de : débugger quelque chose qui
ressemble à du déjà-vu, trancher une question d'architecture, choisir une
convention de nommage ou de découpage, ou répondre à une question sur "comment on
fait ici".

**Mémorise** (\`mem0_add\`) : stack et choix techniques, décisions d'architecture
*avec leur raison*, conventions du dépôt qui ne sont écrites nulle part, bugs
résolus (symptôme + cause racine + correctif), exigences incontournables d'une
feature, préférences de travail exprimées par l'utilisateur.

**Ne mémorise pas** : l'état courant du code, ce qui est déjà écrit ici ou dans le
README, un raisonnement en cours, un résultat de test, du bavardage, un secret.

Un fait par appel, autoportant, rédigé tel quel — \`mem0_add\` stocke ton texte
sans le reformuler. Avant d'écrire, il cherche un souvenir proche : s'il en trouve
un, il le **complète** au lieu de créer un doublon, et te renvoie la version
fusionnée. Relis-la : si la fusion est mauvaise, réécris l'entrée avec
\`mem0_update\`.

Le dépôt fait toujours autorité contre un souvenir : s'il le contredit, le souvenir
est périmé — corrige-le (\`mem0_update\`) ou supprime-le (\`mem0_forget\`), ne
travaille pas dessus.

- **Checkpoint automatique** — si tu exploras (read, grep, glob, lsp) plus de 5 fichiers
  sans écrire avec \`mem0_add\` pendant une phase détectée ("spécification", "besoin",
  "implémentation", "review", "bug"), un message "mem0 checkpoint" t'est envoyé.
  C'est un appel à écrire : tu as collecté des informations durables, enregistre-les
  immédiatement. Sur session normale, le seuil est 15. Le compteur reset après
  chaque \`mem0_add\`.

Règles complètes et exemples : \`${BRIEF_REF_PATH}\` — lis-le avant ton premier
\`mem0_add\` dans ce projet.
${MARKER_CLOSE}`;

// Directive réinjectée dans le system prompt à CHAQUE tour. Le bloc AGENTS.md
// se noie dans un long contexte ; cette ligne-ci est reposée à chaque requête
// provider, donc elle survit à la compaction et au bruit.
const SYSTEM_DIRECTIVE = `Mémoire mem0 : le sommaire de la mémoire du projet est dans ton contexte système, et les souvenirs pertinents pour la demande en cours sont injectés à chaque tour. Traite-les comme acquis : n'explore pas le dépôt pour revérifier un point que la mémoire couvre déjà. Un sujet absent du sommaire n'est pas en mémoire — explore, puis appelle mem0_add. Appelle mem0_search uniquement pour déplier une entrée du sommaire dont le rappel n'a pas donné le texte complet. Un fait par appel, autoportant ; mem0_add déduplique tout seul. Si le dépôt contredit un souvenir, le dépôt gagne : corrige avec mem0_update. Un checkpoint peut t'être envoyé (message "mem0 checkpoint") quand tu explores trop sans écrire — c'est un signal d'écriture, pas d'erreur : appelle mem0_add immédiatement pour sauver ce que tu as appris. Traite-les comme acquis : n'explore pas le dépôt pour revérifier un point que la mémoire couvre déjà.`;

// Fichier de référence, lu à la demande par l'agent (divulgation progressive).
const BRIEF_REFERENCE = `${MARKER_OPEN}
# Brief mémoire — règles complètes

Généré par le plugin \`omp-mem0-memory\`. Tu peux éditer ce fichier : il ne sera pas
réécrit tant que le marqueur de version en tête reste \`${BRIEF_VERSION}\`.

## Quand chercher

Le rappel automatique de début de tour est construit à partir de ta demande. Il rate
ce qui est formulé autrement. \`mem0_search\` dès que le sujet bouge : avant de
débugger un symptôme qui ressemble à du déjà-vu, avant de trancher une question
d'architecture, avant de choisir une convention, avant de répondre à "comment on
fait ici". Une recherche coûte moins qu'une lecture de dépôt.

## Ce qui mérite d'être mémorisé

- **Stack et choix techniques** — langage, framework, versions imposées, gestionnaire
  de paquets, outil de test, linter, cible de déploiement. Tout ce que tu as dû
  chercher dans le dépôt pour pouvoir travailler, et que tu chercherais encore la
  prochaine fois.
- **Décisions d'architecture** — le choix retenu *et* la raison. Une décision sans sa
  raison sera rouverte dans deux mois.
- **Conventions** — nommage, structure de dossiers, patterns imposés, ce qui est
  interdit dans ce dépôt. Surtout celles qui ne sont écrites nulle part.
- **Bugs résolus** — symptôme, cause racine, correctif. C'est la catégorie qui
  rapporte le plus : un bug qui se reproduit coûte beaucoup plus cher qu'un bug
  inédit.
- **Exigences incontournables d'une feature** — les contraintes qui doivent tenir à
  chaque itération : compatibilité descendante, limite de performance, règle métier
  non négociable, exigence d'accessibilité ou de sécurité.
- **Préférences de travail** — comment l'utilisateur veut que tu procèdes sur ce
  projet. Avec \`scope: "global"\` si c'est vrai pour tous ses projets.

## Ce qu'il ne faut pas mémoriser

L'état courant du code (il change, et le dépôt fait autorité), ce qui est déjà dans
\`AGENTS.md\` ou le README, un raisonnement intermédiaire, une tâche en cours, un
résultat de test, du bavardage. Et jamais de secret, clé, token ou donnée
personnelle — la rédaction automatique existe mais elle est approximative.

## Comment écrire un souvenir

Une idée par appel, autoportante : quelqu'un doit pouvoir la comprendre dans six mois
sans le contexte de cette conversation. Nomme les fichiers, modules et symboles.

Ton texte est stocké **tel quel** : \`mem0_add\` n'appelle pas d'extraction LLM par
défaut. Écris donc la phrase finale, pas une note à retravailler.

- OUI — \`Tests : XCTest, un fichier par type, fixtures dans Tests/Support. Pas de mocks manuels, on passe par des protocoles + implémentations de test.\`
- OUI — \`Bug écran de séance figé : cause = Timer non invalidé au dismiss de la vue. Fix = .onDisappear { timer.invalidate() }. Vérifier ce pattern sur toute vue à timer.\`
- NON — \`On a corrigé le bug du timer.\` (ni symptôme, ni cause, ni fix)
- NON — \`TabataEngine.swift fait 340 lignes.\` (périmé au prochain commit)
- NON — \`L'équipe travaille sur une architecture single-app.\` (vague, non actionnable, et déjà dit ailleurs)

Une méthode réutilisable en plusieurs étapes (déployer, débugger une catégorie
d'erreur, checklist avant release) → \`mem0_add\` avec \`kind: "procedure"\`.

## Déduplication

\`mem0_add\` cherche d'abord un souvenir proche dans le même scope. Trois issues :

- **rien de proche** → nouvelle entrée ;
- **le souvenir existant dit déjà ce que tu apportes** → rien n'est écrit, l'entrée
  existante t'est renvoyée ;
- **ton texte complète ou remplace l'existant** → l'entrée est *mise à jour* et la
  version fusionnée t'est renvoyée.

Relis toujours la fusion renvoyée. Si elle est bancale (deux faits distincts collés,
information perdue), réécris l'entrée avec \`mem0_update\` — c'est prévu pour ça.
Passe \`dedupe: false\` seulement quand tu sais que le fait doit vivre séparément.

## Quand un souvenir est faux

Le dépôt gagne toujours. Si un souvenir contredit le code réel, il est périmé :
réécris-le avec \`mem0_update\`, ou supprime-le avec \`mem0_forget\` s'il est
simplement faux.
`;

// ---------------------------------------------------------------------------
// Identité du projet
// ---------------------------------------------------------------------------

const MANIFESTS: Array<[string, (raw: string) => string | null]> = [
  ["package.json", (raw) => { try { return JSON.parse(raw)?.name ?? null; } catch { return null; } }],
  ["pyproject.toml", (raw) => raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null],
  ["Cargo.toml", (raw) => raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null],
  ["Package.swift", (raw) => raw.match(/\bname:\s*"([^"]+)"/)?.[1] ?? null],
];

type Root = { dir: string; isRepo: boolean };

// Remonte jusqu'à la racine du dépôt. `isRepo` sert de garde-fou : on n'écrit
// jamais de fichier dans un dossier qui n'est manifestement pas un projet
// (omp lancé depuis $HOME, par exemple).
function resolveRoot(cwd: string): Root {
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return { dir, isRepo: true };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Pas de dépôt git : on accepte quand même si un AGENTS.md existe déjà.
  return { dir: cwd, isRepo: fs.existsSync(path.join(cwd, "AGENTS.md")) };
}

const rootCache = new Map<string, Root>();
function rootOf(cwd: string): Root {
  let r = rootCache.get(cwd);
  if (!r) { r = resolveRoot(cwd); rootCache.set(cwd, r); }
  return r;
}

function projectId(cwd: string): string {
  const override = process.env.MEM0_PROJECT_ID;
  if (override) return override;
  const { dir } = rootOf(cwd);
  for (const [file, extract] of MANIFESTS) {
    try {
      const name = extract(fs.readFileSync(path.join(dir, file), "utf8"));
      if (name) return name;
    } catch { /* absent ou illisible */ }
  }
  try {
    const xcode = fs.readdirSync(dir).find((f) => f.endsWith(".xcodeproj"));
    if (xcode) return path.basename(xcode, ".xcodeproj");
  } catch { /* ignore */ }
  return path.basename(dir);
}

// ---------------------------------------------------------------------------
// Provisionnement du brief
// ---------------------------------------------------------------------------

type Provision = "created" | "present" | "outdated" | "skipped" | "failed";
type BriefStatus = { root: string; ref: Provision; agents: Provision; detail?: string };

function versionOf(text: string): string | null {
  const m = text.match(MARKER_ANY);
  return m ? (m[1] ? `v${m[1]}` : "v1") : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Idempotent et volontairement conservateur : on n'écrase jamais un fichier ou
// un bloc existant, même périmé. Une version obsolète est signalée, pas
// remplacée — sinon une édition manuelle du brief se ferait effacer en silence.
// `force` (via /mem0-brief --update) est le seul chemin qui réécrit.
function ensureBrief(cwd: string, force = false): BriefStatus {
  const { dir, isRepo } = rootOf(cwd);
  const status: BriefStatus = { root: dir, ref: "skipped", agents: "skipped" };

  if (!AUTOSETUP && !force) { status.detail = "MEM0_AUTOSETUP=0"; return status; }
  if (!isRepo && !force) { status.detail = "pas un dépôt (ni .git ni AGENTS.md)"; return status; }

  // 1. Fichier de référence
  const refAbs = path.join(dir, BRIEF_REF_PATH);
  try {
    if (fs.existsSync(refAbs)) {
      const current = versionOf(fs.readFileSync(refAbs, "utf8"));
      if (current === BRIEF_VERSION) status.ref = "present";
      else if (force) { fs.writeFileSync(refAbs, BRIEF_REFERENCE, "utf8"); status.ref = "created"; }
      else status.ref = "outdated";
    } else {
      fs.mkdirSync(path.dirname(refAbs), { recursive: true });
      fs.writeFileSync(refAbs, BRIEF_REFERENCE, "utf8");
      status.ref = "created";
    }
  } catch (err) {
    status.ref = "failed";
    status.detail = (err as Error).message;
  }

  // 2. Bloc dans AGENTS.md
  const agentsAbs = path.join(dir, "AGENTS.md");
  try {
    if (fs.existsSync(agentsAbs)) {
      const body = fs.readFileSync(agentsAbs, "utf8");
      const current = versionOf(body);
      if (current === BRIEF_VERSION) {
        status.agents = "present";
      } else if (current) {
        if (force) {
          const block = new RegExp(`<!--\\s*mem0:brief[\\s\\S]*?${escapeRe(MARKER_CLOSE)}`);
          fs.writeFileSync(agentsAbs, body.replace(block, AGENTS_BLOCK), "utf8");
          status.agents = "created";
        } else {
          status.agents = "outdated";
        }
      } else {
        fs.appendFileSync(agentsAbs, `\n\n${AGENTS_BLOCK}\n`, "utf8");
        status.agents = "created";
      }
    } else {
      fs.writeFileSync(agentsAbs, `# AGENTS.md\n\n${AGENTS_BLOCK}\n`, "utf8");
      status.agents = "created";
    }
  } catch (err) {
    status.agents = "failed";
    status.detail = (err as Error).message;
  }

  return status;
}

// ---------------------------------------------------------------------------
// Empreinte technique — amorçage d'un projet préexistant (/mem0-init)
//
// Tout ce qui est déductible du disque est lu ici, pas demandé au modèle : c'est
// gratuit, instantané et exact. Le modèle n'est sollicité que pour ce qui demande
// du jugement (décisions d'archi, conventions réelles, pièges).
// ---------------------------------------------------------------------------

function readIf(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function presentIn(dir: string, names: string[]): string[] {
  return names.filter((n) => fs.existsSync(path.join(dir, n)));
}

const NODE_TOOLS: Record<string, string> = {
  vitest: "tests (Vitest)", jest: "tests (Jest)", mocha: "tests (Mocha)",
  "@playwright/test": "tests e2e (Playwright)", cypress: "tests e2e (Cypress)",
  eslint: "lint (ESLint)", "@biomejs/biome": "lint+format (Biome)",
  prettier: "format (Prettier)", typescript: "typage (TypeScript)",
  vite: "build (Vite)", webpack: "build (webpack)", esbuild: "build (esbuild)",
  next: "framework (Next.js)", react: "UI (React)", vue: "UI (Vue)",
  svelte: "UI (Svelte)", express: "serveur (Express)", fastify: "serveur (Fastify)",
  "@nestjs/core": "framework (NestJS)", prisma: "ORM (Prisma)", drizzle_orm: "ORM (Drizzle)",
};

const PKG_MANAGERS: Array<[string, string]> = [
  ["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"], ["package-lock.json", "npm"],
  ["uv.lock", "uv"], ["poetry.lock", "poetry"], ["Pipfile.lock", "pipenv"],
];

// Retourne une liste de faits courts et autoportants. Un fait par idée : mélanger
// stack, layout et CI dans un seul blob les rendrait tous inatteignables au
// recall, qui classe par similarité sémantique.
function scanStack(dir: string, projectName: string): string[] {
  const facts: string[] = [];
  const add = (s: string) => { if (s.trim()) facts.push(redact(s.trim())); };

  // Détecté en premier : les commandes suggérées plus bas doivent utiliser le
  // bon gestionnaire, sinon on documente une commande que personne ne lance.
  const lock = PKG_MANAGERS.find(([f]) => fs.existsSync(path.join(dir, f)));
  const runner = lock ? (lock[1] === "npm" ? "npm run" : `${lock[1]} run`) : "npm run";

  // --- Écosystème et dépendances
  const pkgRaw = readIf(path.join(dir, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const names = Object.keys(deps);
      const tools = names.map((n) => NODE_TOOLS[n]).filter(Boolean);
      add(`${projectName} : projet Node/JS. Outils détectés : ${tools.length ? tools.join(", ") : "aucun outil standard identifié"}.`);
      const runtime = Object.keys(pkg.dependencies ?? {}).slice(0, 15);
      if (runtime.length) add(`${projectName} — dépendances de production : ${runtime.join(", ")}${Object.keys(pkg.dependencies ?? {}).length > 15 ? ", …" : ""}.`);
      const scripts = Object.keys(pkg.scripts ?? {});
      if (scripts.length) {
        const notable = ["test", "lint", "typecheck", "build", "dev", "start"].filter((s) => scripts.includes(s));
        add(`${projectName} — scripts npm disponibles : ${scripts.join(", ")}.` +
          (notable.length ? ` Les commandes de vérification usuelles sont : ${notable.map((s) => `${runner} ${s}`).join(", ")}.` : ""));
      }
    } catch { /* package.json illisible */ }
  }

  const pyRaw = readIf(path.join(dir, "pyproject.toml"));
  if (pyRaw) {
    const tools = [
      /\[tool\.ruff/.test(pyRaw) && "lint+format (Ruff)",
      /\[tool\.mypy/.test(pyRaw) && "typage (mypy)",
      /\[tool\.pytest/.test(pyRaw) && "tests (pytest)",
      /\[tool\.black/.test(pyRaw) && "format (Black)",
      /\[tool\.poetry/.test(pyRaw) && "packaging (Poetry)",
    ].filter(Boolean) as string[];
    add(`${projectName} : projet Python (pyproject.toml). Outils configurés : ${tools.length ? tools.join(", ") : "aucun outil déclaré dans pyproject"}.`);
  } else if (fs.existsSync(path.join(dir, "requirements.txt"))) {
    add(`${projectName} : projet Python, dépendances gérées par requirements.txt (pas de pyproject.toml).`);
  }

  const cargoRaw = readIf(path.join(dir, "Cargo.toml"));
  if (cargoRaw) {
    const block = cargoRaw.split(/^\[dependencies\]/m)[1]?.split(/^\[/m)[0] ?? "";
    const crates = [...block.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]).slice(0, 15);
    add(`${projectName} : projet Rust (Cargo). ${crates.length ? `Dépendances principales : ${crates.join(", ")}.` : ""}`);
  }

  const swiftRaw = readIf(path.join(dir, "Package.swift"));
  let xcode: string | undefined;
  try { xcode = fs.readdirSync(dir).find((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace")); } catch { /* ignore */ }
  if (swiftRaw || xcode) {
    const platforms = swiftRaw?.match(/platforms:\s*\[([^\]]+)\]/)?.[1]?.replace(/\s+/g, " ").trim();
    const spmDeps = swiftRaw ? [...swiftRaw.matchAll(/\.package\((?:url:)?\s*"([^"]+)"/g)].map((m) => m[1].split("/").pop()?.replace(/\.git$/, "") ?? "").filter(Boolean) : [];
    add(
      `${projectName} : projet Swift${xcode ? ` (${xcode})` : " (SwiftPM)"}.` +
      (platforms ? ` Plateformes cibles : ${platforms}.` : "") +
      (spmDeps.length ? ` Dépendances SPM : ${spmDeps.join(", ")}.` : ""),
    );
  }

  const goRaw = readIf(path.join(dir, "go.mod"));
  if (goRaw) {
    const mod = goRaw.match(/^module\s+(\S+)/m)?.[1];
    const ver = goRaw.match(/^go\s+(\S+)/m)?.[1];
    add(`${projectName} : projet Go${mod ? `, module ${mod}` : ""}${ver ? `, go ${ver}` : ""}.`);
  }

  // --- Gestionnaire de paquets
  if (lock) {
    add(`${projectName} — gestionnaire de paquets : ${lock[1]} (${lock[0]} présent). N'utilise pas un autre gestionnaire, le lockfile ferait foi contre toi.`);
  }

  // --- Fichiers de config (le linter réel, pas celui supposé)
  const configs = presentIn(dir, [
    "tsconfig.json", "biome.json", "biome.jsonc", ".eslintrc.json", ".eslintrc.cjs",
    "eslint.config.js", "eslint.config.mjs", ".prettierrc", ".prettierrc.json",
    "ruff.toml", ".ruff.toml", "setup.cfg", "mypy.ini", ".swiftlint.yml",
    ".swift-format", "rustfmt.toml", "clippy.toml", ".editorconfig",
  ]);
  if (configs.length) add(`${projectName} — fichiers de configuration outillage à la racine : ${configs.join(", ")}. Respecte-les plutôt que les réglages par défaut.`);

  // --- CI et conteneurs
  try {
    const wf = fs.readdirSync(path.join(dir, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f));
    if (wf.length) add(`${projectName} — CI GitHub Actions : ${wf.join(", ")}. Ce qui casse en CI casse la PR.`);
  } catch { /* pas de workflows */ }
  const containers = presentIn(dir, ["Dockerfile", "docker-compose.yml", "compose.yaml", "docker-compose.yaml"]);
  if (containers.length) add(`${projectName} — conteneurisation : ${containers.join(", ")} à la racine.`);

  // --- Layout
  try {
    const dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !["node_modules", "vendor", "target", "dist", "build", "__pycache__", ".build"].includes(d.name))
      .map((d) => d.name).slice(0, 14);
    if (dirs.length) add(`${projectName} — dossiers de premier niveau : ${dirs.join(", ")}.`);
  } catch { /* ignore */ }

  // --- Documentation d'agent déjà présente
  const docs = presentIn(dir, ["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "ARCHITECTURE.md"]);
  if (docs.length) add(`${projectName} — documentation de référence à lire avant de coder : ${docs.join(", ")}.`);

  // --- Git
  const head = readIf(path.join(dir, ".git", "HEAD"));
  const branch = head?.match(/ref:\s*refs\/heads\/(\S+)/)?.[1];
  if (branch) add(`${projectName} — branche de travail au moment de l'amorçage : ${branch}.`);

  return facts;
}

function initPrompt(projectName: string, factCount: number): string {
  return `[mem0-init] Amorçage de la mémoire du projet "${projectName}".

L'empreinte technique du dépôt (écosystème, outillage, gestionnaire de paquets,
configs, CI, layout) vient d'être enregistrée automatiquement : ${factCount} fait(s).
Ne la refais pas, elle est déjà en mémoire.

Ta tâche maintenant, en une passe, sans écrire ni modifier de code :

1. Lis README.md, AGENTS.md, CONTRIBUTING.md, et docs/ ou adr/ s'ils existent.
2. Regarde \`git log --oneline -40\` pour repérer les chantiers récents et le style
   de commit.
3. Ouvre deux ou trois fichiers représentatifs du cœur du projet pour vérifier les
   conventions réellement appliquées — elles contredisent souvent la doc, et dans
   ce cas c'est le code qui a raison.

Puis enregistre avec \`mem0_add\`, un appel par idée, **12 souvenirs maximum** :

- l'objet du projet en une phrase : ce qu'il fait, pour qui ;
- les décisions d'architecture visibles, avec leur raison quand elle est écrite
  quelque part ;
- les conventions réelles du dépôt qui ne sont documentées nulle part (nommage,
  découpage, patterns imposés, ce qui est manifestement interdit ici) ;
- les contraintes et exigences non négociables que tu repères ;
- les pièges connus : workarounds commentés, TODO/FIXME récurrents, modules que
  les commits récents corrigent en boucle.

N'enregistre pas l'état courant du code, ni ce que l'empreinte technique couvre
déjà, ni une supposition que tu n'as pas vérifiée dans le dépôt. Dans le doute,
n'enregistre rien : un souvenir faux coûte plus cher qu'une mémoire incomplète,
parce qu'il sera rappelé avec la même autorité qu'un souvenir juste.

Termine par la liste de ce que tu as enregistré, une ligne par souvenir.`;
}

// ---------------------------------------------------------------------------
// Client HTTP
// ---------------------------------------------------------------------------

async function mem0Fetch(route: string, init: RequestInit = {}, budgetMs = TIMEOUT.other): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const res = await fetch(`${MEM0_HTTP_URL}${route}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(MEM0_HTTP_TOKEN ? { "X-Mem0-Token": MEM0_HTTP_TOKEN } : {}),
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`mem0-http ${res.status}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const mem0 = {
  add: (text: string, scope: string, opts: { tags?: string; infer?: boolean; procedure?: boolean } = {}) =>
    mem0Fetch(
      opts.procedure ? "/memory/add_procedure" : "/memory/add",
      {
        method: "POST",
        body: JSON.stringify(
          opts.procedure
            ? { steps: text, agent_id: scope }
            : { text, agent_id: scope, tags: opts.tags, infer: opts.infer === true },
        ),
      },
      TIMEOUT.write,
    ),

  search: (query: string, scope: string, limit: number, threshold?: number) =>
    mem0Fetch(
      "/memory/search",
      {
        method: "POST",
        body: JSON.stringify({ query, agent_id: scope, limit, threshold: threshold ?? null, filters: null }),
      },
      TIMEOUT.search,
    ),

  update: (id: string, text: string) =>
    mem0Fetch(
      `/memory/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify({ text }) },
      TIMEOUT.write,
    ),

  getAll: (scope: string) => mem0Fetch(`/memory/all?agent_id=${encodeURIComponent(scope)}`),

  delete: (id: string) => mem0Fetch(`/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

function rows(result: any): any[] {
  return Array.isArray(result) ? result : (result?.results ?? []);
}

function memoryLine(m: any): string {
  return String(m?.memory ?? m?.text ?? JSON.stringify(m));
}

// ---------------------------------------------------------------------------
// Déduplication à l'écriture
//
// Deux niveaux, volontairement : le score vectoriel de mem0 dit "ça parle du
// même sujet", la couverture lexicale dit "et ça n'apporte rien de plus". Le
// score seul fusionnerait deux décisions voisines mais distinctes ; la
// couverture seule raterait toute reformulation.
// ---------------------------------------------------------------------------

type Similar = { id: string; text: string; score: number };

function foldForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Mots de 4 lettres et plus : les articles et prépositions gonflent la
// couverture sans rien dire du contenu.
function contentTokens(s: string): Set<string> {
  return new Set(foldForCompare(s).split(" ").filter((w) => w.length > 3));
}

/** Part des tokens de `a` présents dans `b`, dans [0,1]. */
function coverage(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 1;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / a.size;
}

/** Tokens de `a` absents de `b` — ce qu'une suppression de `a` ferait perdre. */
function lostTokens(a: Set<string>, b: Set<string>): string[] {
  const lost: string[] = [];
  for (const t of a) if (!b.has(t)) lost.push(t);
  return lost;
}

// ---------------------------------------------------------------------------
// Nettoyage rétroactif (/mem0-dedupe)
//
// Regroupement et rendu sont des fonctions pures, sorties du handler : c'est ce
// qui les rend exécutables sans OMP ni serveur mem0, donc vérifiables.
// ---------------------------------------------------------------------------

export type DedupeEntry = { id: string; text: string; tokens: Set<string> };
export type DedupePair = { keep: DedupeEntry; drop: DedupeEntry; cov: number };

/**
 * Regroupe les quasi-doublons autour d'une tête plutôt que par paires : trié
 * par longueur décroissante, le premier souvenir non absorbé d'un groupe est
 * toujours le plus informatif, et une tête ne peut plus être supprimée par une
 * paire évaluée plus tard. `entries` n'est pas muté.
 */
export function planDedupe(entries: DedupeEntry[], threshold: number): DedupePair[] {
  const ranked = [...entries].sort((x, y) => y.text.length - x.text.length);
  const absorbed = new Set<string>();
  const pairs: DedupePair[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const head = ranked[i]!;
    if (absorbed.has(head.id)) continue;
    for (let j = i + 1; j < ranked.length; j++) {
      const other = ranked[j]!;
      if (absorbed.has(other.id)) continue;
      // `other` est le plus court : c'est sa couverture par la tête qui dit s'il
      // n'apporte rien. L'inverse serait une inclusion large, pas un doublon.
      // Le score est conservé : c'est lui qui justifie la suppression à l'écran.
      const cov = coverage(other.tokens, head.tokens);
      if (cov < threshold) continue;
      pairs.push({ keep: head, drop: other, cov });
      absorbed.add(other.id);
    }
  }
  return pairs;
}

/**
 * Un bloc par paire. Un id ne se vérifie pas : ce qui se vérifie, c'est le
 * texte INTÉGRAL de ce qui part, le score qui a déclenché la paire, et les mots
 * du supprimé que la tête ne reprend pas — liste vide = suppression sans perte
 * de vocabulaire. La liste des paires n'est jamais tronquée : masquer une paire
 * dans un aperçu d'audit retire précisément ce qu'on vient vérifier.
 */
export function renderDedupePreview(pairs: DedupePair[], threshold: number): string {
  return pairs
    .map((p, i) => {
      const lost = lostTokens(p.drop.tokens, p.keep.tokens);
      const shown = lost.slice(0, DEDUPE_PREVIEW_LOST_TOKENS).join(", ");
      const lostLine = lost.length
        ? `${lost.length} mot(s) hors du gardé : ${shown}${lost.length > DEDUPE_PREVIEW_LOST_TOKENS ? ", …" : ""}`
        : "aucune, tout le vocabulaire du supprimé est déjà dans le gardé";
      const keepText =
        p.keep.text.length > DEDUPE_PREVIEW_KEEP_CHARS
          ? `${p.keep.text.slice(0, DEDUPE_PREVIEW_KEEP_CHARS)}…`
          : p.keep.text;
      return [
        `── paire ${i + 1}/${pairs.length} · recouvrement ${p.cov.toFixed(2)} (seuil ${threshold})`,
        `  GARDE    [${p.keep.id}] ${p.keep.text.length} car.`,
        `    ${keepText}`,
        `  SUPPRIME [${p.drop.id}] ${p.drop.text.length} car.`,
        `    ${p.drop.text}`,
        `  perte    ${lostLine}`,
      ].join("\n");
    })
    .join("\n\n");
}

async function findSimilar(text: string, scope: string): Promise<Similar | null> {
  // Pas de plancher serveur ici : la dédup applique le sien sur le score renvoyé,
  // et un filtrage en amont masquerait des candidats utiles.
  const res = await mem0.search(text, scope, DEDUP_CANDIDATES).catch(() => null);
  if (!res) return null;
  const floor = text.length >= DEDUP_LONG_CHARS ? DEDUP_SCORE_LONG : DEDUP_SCORE;
  let best: Similar | null = null;
  for (const m of rows(res)) {
    const id = m?.id;
    const score = typeof m?.score === "number" ? m.score : 0;
    if (!id || score < floor) continue;
    if (!best || score > best.score) best = { id: String(id), text: memoryLine(m), score };
  }
  return best;
}

type MergeOutcome =
  | { action: "insert" }
  | { action: "skip"; target: Similar }
  | { action: "update"; target: Similar; merged: string };

/**
 * Décide quoi faire d'un fait entrant face au souvenir le plus proche.
 *
 * - l'existant couvre déjà le nouveau  → on n'écrit rien ;
 * - le nouveau couvre déjà l'existant  → il le remplace (formulation plus complète) ;
 * - les deux apportent quelque chose   → concaténation, l'existant d'abord.
 *
 * La concaténation est délibérément mécanique : elle est relue par l'agent, qui
 * peut la réécrire avec `mem0_update`. Faire arbitrer un LLM local ici
 * ajouterait 10 à 60 s à chaque écriture pour un gain incertain.
 */
function planMerge(text: string, similar: Similar | null): MergeOutcome {
  if (!similar) return { action: "insert" };
  const incoming = contentTokens(text);
  const existing = contentTokens(similar.text);
  if (coverage(incoming, existing) >= DEDUP_CONTAINED) return { action: "skip", target: similar };
  if (coverage(existing, incoming) >= DEDUP_CONTAINED) {
    return { action: "update", target: similar, merged: text.slice(0, MERGED_MAX_CHARS) };
  }
  // Deux faits qui ne se recouvrent pas lexicalement ne sont pas le même sujet,
  // quel que soit le score vectoriel : ils vivent séparément.
  const overlap = Math.max(coverage(incoming, existing), coverage(existing, incoming));
  if (overlap < DEDUP_MERGE_MIN_COVERAGE) return { action: "insert" };
  const merged = `${similar.text}\n${text}`;
  // Une concaténation tronquée perd la queue du fait entrant, et surtout elle ne
  // se stabilise jamais : le même texte rejoué n'est plus couvert par l'existant
  // amputé, donc il refusionne à chaque appel. Quand ça ne tient pas, on insère.
  if (merged.length > MERGED_MAX_CHARS) return { action: "insert" };
  return { action: "update", target: similar, merged };
}

// ---------------------------------------------------------------------------
// Garde-fou secrets — best-effort avant toute écriture. Pas une garantie.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{16,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{16,}/gi,
  /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

// ---------------------------------------------------------------------------
// Cache local de la mémoire du projet
//
// Chargé une fois par session, il sert à deux choses : rendre le sommaire
// exhaustif injecté dans le system prompt, et agrafer un souvenir aux arguments
// d'un outil sans aucun appel réseau (un mem0.search dans `tool_result`
// ajouterait jusqu'à 20 s à chaque grep, et sur un chemin ou un symbole le
// matching lexical bat de toute façon la similarité dense).
// ---------------------------------------------------------------------------

/** Souvenir préparé pour le matching local. */
type Prepared = { id: string; text: string; tokens: Set<string>; updatedAt: string };

type MemoryCache = { entries: Prepared[]; df: Map<string, number> };

/** Charge les souvenirs du projet et prépare le matching local. */
async function loadMemory(scope: string): Promise<MemoryCache | null> {
  const all = rows(await mem0.getAll(scope).catch(() => null));
  const entries: Prepared[] = all
    .filter((m) => m?.id)
    .map((m) => {
      const text = memoryLine(m);
      return { id: String(m.id), text, tokens: contentTokens(text), updatedAt: String(m?.updated_at ?? "") };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!entries.length) return null;
  // Fréquence documentaire : un token présent dans la moitié de la base ne
  // discrimine rien, l'agrafage doit pouvoir l'ignorer.
  const df = new Map<string, number>();
  for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  return { entries, df };
}

/** Sommaire exhaustif, rendu depuis le cache. */
export function buildIndex(scope: string, mem: MemoryCache): string {
  const shown = mem.entries.slice(0, INDEX_MAX_ENTRIES);
  const hidden = mem.entries.length - shown.length;
  // Le sommaire n'est "exhaustif" que tant qu'il n'est pas tronqué. Au-delà de
  // INDEX_MAX_ENTRIES, affirmer l'exhaustivité ET « n'appelle pas mem0_search »
  // dit à l'agent d'ignorer des souvenirs qui EXISTENT mais sont hors liste :
  // c'est précisément la ré-exploration que ce dispositif doit supprimer. Quand
  // la liste est tronquée, on retire la garantie et on invite explicitement à
  // chercher un sujet absent avant de conclure.
  const header =
    hidden > 0
      ? `[mem0] Sommaire de la mémoire du projet "${scope}" — ${mem.entries.length} souvenir(s), ` +
        `les ${shown.length} plus récents listés ci-dessous ; les ${hidden} plus anciens ne le sont PAS. ` +
        `Cette liste n'est donc pas exhaustive : si ta demande porte sur un sujet qui n'y figure pas, ` +
        `appelle mem0_search avant de conclure qu'il n'est pas en mémoire. Pour déplier une entrée, ` +
        `mem0_search sur son sujet ; les ids servent à mem0_update et mem0_forget.`
      : `[mem0] Sommaire de la mémoire du projet "${scope}" — ${mem.entries.length} souvenir(s). ` +
        `Ce sommaire est exhaustif : un sujet qui n'y figure pas n'est pas en mémoire, ` +
        `n'appelle pas mem0_search pour t'en assurer. Pour déplier une entrée, mem0_search sur son ` +
        `sujet ; les ids servent à mem0_update et mem0_forget.`;
  return (
    header +
    "\n" +
    shown
      .map((e) => {
        const line = e.text.split("\n")[0]!.trim();
        return `- [${e.id}] ${line.length > INDEX_LINE_CHARS ? `${line.slice(0, INDEX_LINE_CHARS - 1)}…` : line}`;
      })
      .join("\n") +
    (hidden > 0 ? `\n(+ ${hidden} souvenir(s) plus anciens, atteignables par mem0_search)` : "")
  );
}

/** Arguments d'un outil réduits au texte qui porte du sens pour le matching. */
function toolQuery(toolName: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) =>
    keys.map((k) => (typeof input[k] === "string" ? (input[k] as string) : "")).join(" ");
  switch (toolName) {
    case "grep":
      return pick("pattern", "path");
    case "read":
    case "glob":
      return pick("path");
    case "edit":
    case "write":
      return pick("path", "paths");
    case "lsp":
      return pick("symbol", "query", "file");
    default:
      return "";
  }
}

/**
 * Souvenir le plus proche des arguments d'un outil, ou null.
 *
 * Deux conditions cumulées : au moins un token INFORMATIF partagé (un token présent
 * dans plus de PIN_COMMON_RATIO des souvenirs ne discrimine rien — "extension" est dans
 * la moitié de la base), et au moins PIN_MIN_RATIO des tokens de l'argument retrouvés.
 * Sans le second garde-fou, lire un fichier suffirait à agrafer n'importe quel souvenir
 * qui le mentionne ; sans le premier, un chemin générique agraferait au hasard.
 */
function pickPin(mem: MemoryCache, query: string, seen: Set<string>): Prepared | null {
  const args = contentTokens(query);
  if (!args.size) return null;
  const common = Math.max(1, Math.floor(mem.entries.length * PIN_COMMON_RATIO));
  let best: { entry: Prepared; score: number } | null = null;
  for (const entry of mem.entries) {
    if (seen.has(entry.id)) continue;
    let hits = 0;
    let informative = 0;
    for (const t of args) {
      if (!entry.tokens.has(t)) continue;
      hits++;
      if ((mem.df.get(t) ?? 0) <= common) informative++;
    }
    if (!informative || hits / args.size < PIN_MIN_RATIO) continue;
    // entries est trié du plus récent au plus ancien : `>` garde le plus récent à score égal.
    if (!best || informative > best.score) best = { entry, score: informative };
  }
  return best?.entry ?? null;
}

// ---------------------------------------------------------------------------
type RecallHead = { id: string; head: string };

type RecallDetails = {
  status: "hit" | "empty" | "unavailable";
  scope: string;
  threshold: number;
  /** souvenirs du sommaire injecté en prompt système ; 0 si le cache n'a pas chargé. */
  indexSize: number;
  /** agrafages survenus depuis le rappel précédent. */
  pinned: number;
  project: RecallHead[];
  global: RecallHead[];
  /** renseigné uniquement quand status === "unavailable". */
  error?: string;
};

type RecallRow = { text: string; tone: "header" | "item" | "body" | "alert" };

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function wrapAt(s: string, n: number): string[] {
  if (s.length === 0) return [""];
  const result: string[] = [];
  let remaining = s;
  while (remaining.length > 0) {
    if (remaining.length <= n) { result.push(remaining); break; }
    // find last space at or before n
    const spaceIdx = remaining.slice(0, n).lastIndexOf(" ");
    if (spaceIdx === -1) {
      // no space: hard cut
      result.push(remaining.slice(0, n));
      remaining = remaining.slice(n);
    } else {
      result.push(remaining.slice(0, spaceIdx));
      remaining = remaining.slice(spaceIdx + 1);
    }
  }
  return result;
}

function renderRecallRows(
  d: RecallDetails,
  body: string,
  expanded: boolean,
  width: number,
): RecallRow[] {
  const w = Math.max(20, width);
  const rows: RecallRow[] = [{ text: "", tone: "body" }];

  // En-tête
  let header = "";
  if (d.status === "hit") {
    const n = d.project.length + d.global.length;
    header = `mem0 · ${n} souvenir(s) (projet ${d.project.length} · global ${d.global.length}) · sommaire ${d.indexSize} · seuil ${d.threshold}`;
  } else if (d.status === "empty") {
    header = `mem0 · aucun souvenir au-dessus du seuil ${d.threshold} · sommaire ${d.indexSize}`;
  } else {
    header = `mem0 · mémoire injoignable : ${d.error ?? "erreur inconnue"}`;
  }

  // Suffixes
  if (d.pinned > 0) header += ` · ${d.pinned} agrafé(s)`;
  if (!expanded && (d.status !== "empty" || body)) header += " · Ctrl+O";

  header = clip(header, w);
  rows.push({ text: header, tone: d.status === "unavailable" ? "alert" : "header" });

  if (!expanded) {
    // Résumé : une ligne item par souvenir, projet d'abord puis global
    if (d.status !== "empty" && d.status !== "unavailable") {
      for (const p of d.project) {
        rows.push({ text: `    [${p.id.slice(0, 8)}] ${clip(p.head, w)}`, tone: "item" });
      }
      for (const g of d.global) {
        rows.push({ text: `    [${g.id.slice(0, 8)}] ${clip(g.head, w)}`, tone: "item" });
      }
    }
  } else {
    // Déplié : body découpé sur \n, chaque ligne repliée à w-4
    const wBody = Math.max(w - 4, 16);
    for (const line of body.split("\n")) {
      if (line.length === 0) { rows.push({ text: "", tone: "body" }); continue; }
      for (const wrapped of wrapAt(`    ${line}`, wBody)) {
        rows.push({ text: wrapped, tone: "body" });
      }
    }
  }

  return rows;
}
// Extension
// ---------------------------------------------------------------------------

type SessionState = {
  turns: number;
  /** tours dont le prompt dépasse RECALL_MIN_PROMPT ; proxy de « la session a du fond ». */
  substantiveTurns: number;
  /** ids déjà montrés dans cette session, par rappel ou par agrafage : on ne répète pas. */
  injected: Set<string>;
  /** arguments d'outil déjà agrafés : un même chemin ou pattern n'agrafe qu'une fois. */
  pinnedQueries: Set<string>;
  /** cache local des souvenirs du projet + fréquence documentaire des tokens. */
  mem: MemoryCache | null;
  /** sommaire rendu, reconstruit en même temps que le cache. */
  index: string | null;
  /** compteurs : instrumentation (/mem0-status) et déclenchement du nudge (session_stop). */
  mutations: number; // edit/write réussis
  explorations: number; // read/grep/glob/lsp réussis
  recalls: number; // tours où au moins un souvenir a été injecté
  adds: number; // écritures mémoire réussies
  nudged: boolean;
  /** agrafages réussis sur la session, affiché par /mem0-status. */
  pinned: number;
  /** agrafages depuis le dernier bloc de rappel affiché. */
  pinnedSinceRecall: number;
  /** explorations sans écriture mem0_add ; déclenche un checkpoint au-delà du seuil. */
  explorationSinceLastWrite: number;
  /** phase active pour la session, définie par /set-phase ; null si aucune. */
  currentPhase: string | null;
  /** le trigger de fin de phase n'agit qu'une fois par session (garde anti-boucle). */
  phaseTriggered: boolean;
};

export default function mem0MemoryExtension(pi: ExtensionAPI) {
  const { z } = pi.zod;
  pi.setLabel("mem0 memory");

  // Le composant retourné remplace le cadre par défaut (cf. renderFramedMessage côté hôte).
  // Il n'implémente que `render(width)` : c'est le seul membre requis de l'interface Component,
  // ce qui évite d'importer @oh-my-pi/pi-tui — un import de VALEUR depuis @oh-my-pi/* casse la
  // résolution au runtime (extension chargée depuis ~/.omp/plugins/... qui n'a pas ces paquets)
  // et fait échouer scripts/check.sh.
  const TONES = { header: "customMessageLabel", item: "muted", body: "dim", alert: "warning" } as const;

  pi.registerMessageRenderer<RecallDetails>(RECALL_MESSAGE_TYPE, (message, options, theme) => {
    const d = message.details;
    if (!d || typeof d !== "object" || typeof (d as RecallDetails).status !== "string") return undefined;
    const body =
      typeof message.content === "string"
        ? message.content
        : message.content.map((c: any) => (c?.type === "text" ? String(c.text) : "")).join("\n");
    return {
      render(width: number) {
        return renderRecallRows(d as RecallDetails, body, options.expanded, width).map((r) =>
          r.text ? theme.fg(TONES[r.tone], r.text) : "",
        );
      },
    };
  });

  const states = new Map<string, SessionState>();
  const provisioned = new Map<string, BriefStatus>(); // par racine de projet

  // Clé stable par session. `ctx` peut être recréé d'un tour à l'autre selon la
  // version, donc pas de WeakSet sur l'objet ctx.
  function stateOf(ctx: any): SessionState {
    // ReadonlySessionManager expose getSessionId(), pas une propriété sessionId :
    // l'ancienne lecture retombait toujours sur cwd, et deux sessions ouvertes
    // sur le même projet partageaient compteur de tours et état de rappel.
    const key = String(
      ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId ?? ctx?.session?.id ?? ctx?.cwd ?? "session",
    );
    let st = states.get(key);
    if (!st) {
      st = {
        turns: 0,
        substantiveTurns: 0,
        injected: new Set(),
        pinnedQueries: new Set(),
        mem: null,
        index: null,
        mutations: 0,
        explorations: 0,
        recalls: 0,
        pinned: 0,
        adds: 0,
        nudged: false,
        pinnedSinceRecall: 0,
        explorationSinceLastWrite: 0,
        currentPhase: null,
        phaseTriggered: false,
      };
      states.set(key, st);
    }
    return st;
  }

  // Une vérification par racine de projet et par process. Ce sont des stat/read
  // synchrones : quelques millisecondes, rien qui justifie de l'asynchrone.
  function checkBrief(ctx: any, force = false): BriefStatus {
    const cwd = ctx?.cwd ?? process.cwd();
    const { dir } = rootOf(cwd);
    if (!force) {
      const cached = provisioned.get(dir);
      if (cached) return cached;
    }
    const status = ensureBrief(cwd, force);
    provisioned.set(dir, status);

    if (status.ref === "created" || status.agents === "created") {
      ctx?.ui?.notify?.(
        `[mem0] brief mémoire posé sur "${projectId(cwd)}" — ${BRIEF_REF_PATH} + bloc dans AGENTS.md`,
        "info",
      );
    } else if (status.ref === "outdated" || status.agents === "outdated") {
      ctx?.ui?.notify?.(
        "[mem0] brief en version ancienne sur ce projet — /mem0-brief --update pour le remplacer",
        "warning",
      );
    } else if (status.ref === "failed" || status.agents === "failed") {
      ctx?.ui?.notify?.(`[mem0] brief non posé : ${status.detail}`, "warning");
    }
    return status;
  }

  // --- Vérification du brief au démarrage de session ------------------------
  // session_start couvre le cas normal ; le premier before_agent_start rattrape
  // les versions d'OMP où l'event ne remonte pas. checkBrief est mémoïsé, donc
  // le doublon ne coûte rien.
  pi.on("session_start", async (_event, ctx) => {
    try { checkBrief(ctx); } catch { /* jamais bloquant */ }
  });

  // Après une compaction ou un changement de branche, les souvenirs déjà posés
  // ne sont plus forcément dans le contexte : on autorise leur réinjection.
  const forgetInjected = (ctx: ExtensionContext) => { stateOf(ctx).injected.clear(); };
  pi.on("session_compact", async (_event, ctx) => forgetInjected(ctx));
  pi.on("auto_compaction_end", async (_event, ctx) => forgetInjected(ctx));
  pi.on("session_branch", async (_event, ctx) => forgetInjected(ctx));

  // --- Rappel à CHAQUE tour + sommaire exhaustif ----------------------------
  //
  // La requête est le PROMPT BRUT. L'ancienne version l'enveloppait dans un
  // gabarit fixe ("Projet X. Demande en cours… stack, conventions, décisions…") :
  // mesuré sur la base réelle, le gabarit seul (demande vide) sortait un top-1 à
  // 0.687, plus haut que le top-1 de n'importe quelle vraie question, et sur une
  // demande hors sujet 4 des 5 premiers résultats étaient ceux du gabarit. Le
  // boilerplate était l'attracteur, pas la question.
  pi.on("before_agent_start", async (event, ctx) => {
    const st = stateOf(ctx);
    st.turns += 1;
    if (event.prompt.trim().length >= RECALL_MIN_PROMPT) st.substantiveTurns += 1;

    if (st.turns === 1) {
      try { checkBrief(ctx); } catch { /* jamais bloquant */ }
    }

     const scope = projectId(ctx.cwd);

    // Cache + sommaire : une fois par session, retentés au tour suivant en cas
    // d'échec. Sans cache, pas d'agrafage — l'exploration se déroule normalement.
    if (st.mem === null) {
      st.mem = await loadMemory(scope);
      st.index = st.mem ? buildIndex(scope, st.mem) : null;
    }

    // La directive et le sommaire sont reposés à chaque tour : un message se
    // dilue dans un long contexte et ne survit pas à la compaction, le system
    // prompt si.
    const systemPrompt = [...event.systemPrompt, SYSTEM_DIRECTIVE, ...(st.index ? [st.index] : [])];

    // Checkpoint exploration : nudge d'écriture quand l'agent a beaucoup exploré
    // sans rien mémoriser. `systemPrompt` doit être construit avant ce retour.
    if (st.explorationSinceLastWrite >= CHECKPOINT_THRESHOLD_NORMAL) {
      const explorationsDone = st.explorationSinceLastWrite;
      st.explorationSinceLastWrite = 0;
      return { systemPrompt, message: {
        customType: CHECKPOINT_MESSAGE_TYPE,
        content: `[mem0 checkpoint] ${explorationsDone} exploration(s) faites sans écriture. ` +
          `Tu as lu/grepé/parcouru des fichiers qui contiennent probablement des connaissances ` +
          `permanentes (architecture, conventions, bugs, décisions). ` +
          `Écris maintenant avec mem0_add ce qui sera vrai dans 6 mois. ` +
          `Un fait par appel, autoportant, en nommant fichiers et symboles.`,
        display: true,
        attribution: "agent" as const,
      }};
    }

    const prompt = event.prompt.trim();
    if (prompt.length < RECALL_MIN_PROMPT) return { systemPrompt };

    const recallMessage = (content: string, details: RecallDetails) => {
      st.pinnedSinceRecall = 0;
      return {
        systemPrompt,
        message: {
          customType: RECALL_MESSAGE_TYPE,
          content,
          display: RECALL_DISPLAY,
          attribution: "agent" as const,
          details,
        },
      };
    };

    try {
      let recallError: string | undefined;
      // Calcul unique des métadonnées pour le bloc visible : pinned est lu AVANT
      // toute remise à zéro dans recallMessage, indexSize est le même partout.
      const indexSize = st.mem?.entries.length ?? 0;
      const pinned = st.pinnedSinceRecall;
      const head = (m: any): RecallHead => ({
        id: String(m?.id ?? "?"),
        head: clip(memoryLine(m).split("\n")[0]!.trim(), RECALL_LINE_CHARS),
      });
      // Les échecs sont tracés — un rappel muet a caché le problème trop longtemps.
      const [projectRes, globalRes] = await Promise.all([
        mem0.search(prompt.slice(0, 800), scope, RECALL_LIMIT, RECALL_THRESHOLD).catch((err) => {
          recallError = (err as Error).message;
          console.warn(`[mem0] recall projet indisponible : ${recallError}`);
          return null;
        }),
        mem0.search(prompt.slice(0, 400), GLOBAL_SCOPE, RECALL_GLOBAL_LIMIT, RECALL_THRESHOLD).catch(() => null),
      ]);

      // Service injoignable : ne rien affirmer sur le contenu de la mémoire.
      if (projectRes === null && globalRes === null) {
        return recallMessage(
          `[mem0] Service mémoire injoignable (${MEM0_HTTP_URL}) : ${recallError ?? "aucune réponse"}. ` +
            `Aucun rappel ce tour : ne conclus rien sur le contenu de la mémoire, et ne tente pas ` +
            `d'écrire avec mem0_add tant qu'elle ne répond pas.`,
          { status: "unavailable", scope, threshold: RECALL_THRESHOLD, indexSize, pinned, project: [], global: [], error: recallError ?? "aucune réponse" },
        );
      }

      // Un souvenir déjà posé est dans le contexte : le reposer dilue le nouveau.
      // Exception sur le meilleur résultat du tour — il peut être loin derrière ou
      // avoir été compacté, et c'est celui dont l'agent a besoin maintenant.
      const fresh = (res: unknown, keepTop: boolean) =>
        rows(res).filter((m, i) => {
          const id = m?.id ? String(m.id) : memoryLine(m);
          const seen = st.injected.has(id);
          st.injected.add(id);
          return keepTop && i === 0 ? true : !seen;
        });

      const projectMems = fresh(projectRes, true);
      const globalMems = fresh(globalRes, false);


      // Cas vide : autrefois silencieux. C'est le signal qui déclenche l'écriture.
      if (!projectMems.length && !globalMems.length) {
        return recallMessage(
          `[mem0] Rien en mémoire sur cette demande (plancher de score ${RECALL_THRESHOLD}). ` +
            `Explore le dépôt, puis écris avec mem0_add ce qui sera encore vrai dans six mois : ` +
            `décision et sa raison, bug avec cause racine et correctif, convention, exigence.`,
          { status: "empty", scope, threshold: RECALL_THRESHOLD, indexSize, pinned, project: [], global: [] },
        );
      }

      const parts = [
        `[mem0] Déjà en mémoire sur cette demande — points acquis, ne relis pas les fichiers ` +
          `pour les revérifier, cite l'id quand tu t'en sers :`,
      ];
      if (projectMems.length) {
        parts.push(projectMems.map((m) => `- [${m.id ?? "?"}] ${memoryLine(m)}`).join("\n"));
      }
      if (globalMems.length) {
        parts.push("Préférences transverses :", globalMems.map((m) => `- ${memoryLine(m)}`).join("\n"));
      }
      parts.push(
        "Ce qui n'apparaît pas ci-dessus n'est pas en mémoire sur cette demande : explore, puis " +
          "écris ce que tu as appris avec mem0_add. Si le dépôt contredit un souvenir, le dépôt " +
          "gagne — corrige-le avec mem0_update.",
      );
      st.recalls += 1;

      return recallMessage(
        parts.join("\n\n"),
        { status: "hit", scope, threshold: RECALL_THRESHOLD, indexSize, pinned, project: projectMems.map(head), global: globalMems.map(head) },
      );
    } catch (err) {
      console.warn(`[mem0] recall indisponible : ${(err as Error).message}`);
      return recallMessage(
        `[mem0] Service mémoire injoignable (${MEM0_HTTP_URL}) : ${(err as Error).message}. ` +
          `Aucun rappel ce tour : ne conclus rien sur le contenu de la mémoire, et ne tente pas ` +
          `d'écrire avec mem0_add tant qu'elle ne répond pas.`,
        { status: "unavailable", scope, threshold: RECALL_THRESHOLD, indexSize: st.mem?.entries.length ?? 0, pinned: st.pinnedSinceRecall, project: [], global: [], error: (err as Error).message },
      );
    }
  });

  // --- Compteurs par outil + agrafage --------------------------------------
  //
  // Aucun appel réseau ici : le matching se fait sur le cache chargé au premier
  // tour. Le souvenir est posé EN TÊTE et le contenu original conservé
  // intégralement — l'outil n'est jamais amputé de son résultat.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    const st = stateOf(ctx);
    if (MUTATE_TOOLS[event.toolName]) st.mutations += 1;
    else if (EXPLORE_TOOLS[event.toolName]) { st.explorations += 1; st.explorationSinceLastWrite += 1; }

    if (!st.mem || !PIN_TOOLS[event.toolName]) return;
    const query = toolQuery(event.toolName, event.input);
    if (!query) return;
    // Un même argument n'agrafe qu'une fois : rejouer le même grep ou relire le
    // même fichier viderait sinon la base souvenir par souvenir dans le contexte.
    const key = `${event.toolName}:${query}`;
    if (st.pinnedQueries.has(key)) return;
    const hit = pickPin(st.mem, query, st.injected);
    if (!hit) return;
    st.pinnedQueries.add(key);
    st.injected.add(hit.id);
    st.pinned += 1;
    st.pinnedSinceRecall += 1;
    return {
      content: [
        {
          type: "text" as const,
          text:
            `[mem0] Déjà en mémoire à propos de ceci — n'explore pas pour le revérifier, ` +
            `cite l'id si tu t'en sers :\n[${hit.id}] ${hit.text.slice(0, PIN_TEXT_CHARS)}`,
        },
        ...event.content,
      ],
    };
  });

  // --- Relance en fin de session -------------------------------------------
  // Une seule par session, quand rien n'a été écrit en mémoire (adds === 0) et
  // que la session a produit quelque chose de potentiellement durable : soit des
  // fichiers modifiés (travail de code), soit une discussion substantielle sans
  // édition (needs, specs, archi — sinon le nudge fondé sur `mutations` ne tire
  // jamais et ces phases n'écrivent rien).
  pi.on("session_stop", async (_event, ctx) => {
    const st = stateOf(ctx);
    if (st.nudged) return;
    const msg = pickSessionStopNudge(st);
    if (!msg) return;
    st.nudged = true;
    return { continue: true, additionalContext: msg };
  });

  // --- Fin de phase : lecture mémoire déléguée -----------------------------
  // Phase enregistrée active + agent qui rend la main → on cherche les
  // instructions de la phase et on les PRÉSENTE à l'agent pour qu'il les applique
  // avec ses propres outils. Gardes : event.stop_hook_active (anti-boucle runtime)
  // + un seul déclenchement par session.
  pi.on("session_stop", async (event, ctx) => {
    if (event?.stop_hook_active) return;
    const st = stateOf(ctx);
    if (st.phaseTriggered) return;
    if (!st.currentPhase || !phases.has(st.currentPhase)) return;

    const phaseName = st.currentPhase;
    const scope = projectId(ctx.cwd);
    const brief = phases.get(phaseName)?.brief ?? "";
    // Une seule fois, même si la recherche échoue ou ne renvoie rien.
    st.phaseTriggered = true;

    try {
      // Requête = intention de la phase (nom + brief). On NE concatène PAS les
      // mots-clés fixes dans le texte embeddé : padder la requête détruit sa
      // pertinence (mesuré). Les mots-clés servent de tri lexical en aval.
      const query = brief ? `${phaseName} ${brief}` : phaseName;
      const found = rows(await mem0.search(query, scope, RECALL_LIMIT, RECALL_THRESHOLD)).map(memoryLine);
      const hasKeyword = (t: string) => EXECUTION_KEYWORDS.some((k) => t.toLowerCase().includes(k));
      const executable = found
        .filter((t) => EXECUTABLE_RE.test(t))
        .sort((a, b) => Number(hasKeyword(b)) - Number(hasKeyword(a)));

      if (executable.length) {
        return {
          continue: true,
          additionalContext:
            `[mem0 phase "${phaseName}"] Phase terminée. Instructions trouvées en mémoire à appliquer maintenant, ` +
            `avec tes propres outils (édition, bash/git) et sous les gardes d'approbation :\n` +
            executable.map((t, i) => `${i + 1}. ${t}`).join("\n") +
            `\n\nApplique celles qui sont pertinentes puis rends la main. Si une instruction ne colle pas ` +
            `à l'état réel du dépôt, dis-le au lieu de l'exécuter.`,
        };
      }

      return {
        continue: true,
        additionalContext:
          `[mem0 phase "${phaseName}"] Phase terminée, aucune instruction exécutable en mémoire pour cette phase. ` +
          `Si elle doit déclencher des actions (bump de version, commit, release, déploiement), enregistre-les ` +
          `avec mem0_add sous forme d'instruction, par exemple : « ${phaseName} — RUN: incrémenter la version ` +
          `dans package.json et marketplace.json puis commiter ». Elles seront présentées à la prochaine fin de phase.`,
      };
    } catch (err) {
      return {
        continue: true,
        additionalContext: `[mem0 phase "${phaseName}"] Recherche mémoire indisponible : ${(err as Error).message}. Aucune action automatique ce tour.`,
      };
    }
  });

  // --- Tools ---------------------------------------------------------------

  // `loadMode: "essential"` sur les quatre tools. Sans ça, OMP les monte en
  // devices xd:// (les tools d'extension sont "discoverable" par défaut) : le
  // modèle doit alors écrire ses arguments dans le `content` du tool write, et
  // se trompe régulièrement d'enveloppe — d'où les
  // `Invalid args for xd://mem0_search`. En essential, le schéma part sur le fil
  // à chaque requête et l'appel est direct.
  pi.registerTool({
    name: "mem0_search",
    label: "mem0 · search",
    loadMode: "essential",
    description:
      "Cherche dans la mémoire du projet : stack, conventions, décisions d'archi, bugs déjà " +
      "corrigés, exigences incontournables. À appeler dès que le sujet se déplace hors du " +
      "rappel automatique : avant de débugger un symptôme qui ressemble à du déjà-vu, avant " +
      "de trancher une question d'architecture, avant de choisir une convention, avant de " +
      "répondre à une question sur la façon de faire dans ce dépôt. Moins cher qu'une " +
      "exploration du dépôt.",
    parameters: z.object({
      query: z.string().describe("Résumé du symptôme, du sujet ou de la décision recherchée"),
      scope: z.enum(["project", "global"]).optional().default("project"),
      // Le plafond accepte large et borne au moment de l'appel : un `limit: 100`
      // renvoyait une erreur de validation et brûlait un tour pour rien.
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(6)
        .describe("Nombre de souvenirs renvoyés, borné à 50"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: any) {
      const scope = params.scope === "global" ? GLOBAL_SCOPE : projectId(ctx?.cwd ?? process.cwd());
      const limit = Math.min(params.limit ?? 6, 50);
      const result = await mem0.search(params.query, scope, limit, SEARCH_THRESHOLD);
      const found = rows(result);
      const text = found.length
        ? found.map((m) => `- [${m.id ?? "?"}] ${memoryLine(m)}`).join("\n")
        : "Aucun souvenir pertinent.";
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "mem0_add",
    label: "mem0 · add",
    loadMode: "essential",
    description:
      "Enregistre un point durable : stack ou choix technique du projet, convention, décision " +
      "d'architecture, bug + cause racine + correctif, exigence incontournable d'une feature, " +
      "préférence de travail. Une seule idée par appel, formulée pour être comprise dans six " +
      "mois sans le contexte de cette conversation. Le texte est stocké tel quel, écris donc " +
      "la phrase finale. Un souvenir proche est cherché d'abord : s'il en existe un, il est " +
      "complété au lieu d'être dupliqué, et la version fusionnée t'est renvoyée — relis-la. " +
      "N'enregistre rien de trivial ni de temporaire.",
    parameters: z.object({
      text: z.string().describe("Le fait, autoportant. Ex: 'Auth : tokens de reset à usage unique, TTL 15 min (décision du 12/03).'"),
      kind: z
        .enum(["fact", "procedure"])
        .optional()
        .default("fact")
        .describe("'procedure' pour une méthode réutilisable en plusieurs étapes (déploiement, checklist), 'fact' sinon"),
      scope: z
        .enum(["project", "global"])
        .optional()
        .default("project")
        .describe("'global' uniquement pour une préférence valable sur tous tes projets"),
      tags: z.string().optional().describe("valeurs séparées par des virgules, ex: 'stack,swiftui'"),
      dedupe: z
        .boolean()
        .optional()
        .default(true)
        .describe("false uniquement si ce fait doit vivre séparément d'un souvenir voisin déjà en base"),
      infer: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "true pour laisser mem0 reformuler ton texte via son extraction LLM. Laisse false : " +
            "l'extraction paraphrase un fait déjà propre en énoncé vague et crée des quasi-doublons.",
        ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const scope = params.scope === "global" ? GLOBAL_SCOPE : projectId(ctx?.cwd ?? process.cwd());
      const text = redact(params.text);

      // Toute écriture périme le cache local et le sommaire : ils seront rechargés
      // au tour suivant. Le chemin `skip` n'écrit rien, donc n'invalide rien.
      const wrote = (st: SessionState) => { st.adds += 1; st.mem = null; st.index = null; st.explorationSinceLastWrite = 0; };

      // Les procédures vivent dans un autre espace mem0 (memory_type
      // procedural_memory) : la recherche de similarité ne les atteint pas, on
      // ne tente donc pas de fusion.
      if (params.kind === "procedure") {
        const result = await mem0.add(text, scope, { procedure: true });
        wrote(stateOf(ctx));
        return { content: [{ type: "text", text: `Procédure enregistrée dans "${scope}".` }], details: result };
      }

      const similar = params.dedupe === false ? null : await findSimilar(text, scope);
      const plan = planMerge(text, similar);

      if (plan.action === "skip") {
        return {
          content: [
            {
              type: "text",
              text:
                `Déjà en mémoire (similarité ${plan.target.score.toFixed(2)}), rien écrit :\n` +
                `- [${plan.target.id}] ${plan.target.text}\n\n` +
                `Si ton fait dit vraiment autre chose, rappelle mem0_add avec dedupe: false, ` +
                `ou réécris l'entrée avec mem0_update.`,
            },
          ],
          details: plan.target,
        };
      }

      if (plan.action === "update") {
        const result = await mem0.update(plan.target.id, plan.merged);
        wrote(stateOf(ctx));
        return {
          content: [
            {
              type: "text",
              text:
                `Souvenir complété (similarité ${plan.target.score.toFixed(2)}) — [${plan.target.id}] :\n` +
                `${plan.merged}\n\n` +
                `Relis la fusion. Si elle est bancale, réécris-la avec mem0_update.`,
            },
          ],
          details: result,
        };
      }

      const result = await mem0.add(text, scope, { tags: params.tags, infer: params.infer === true });
      wrote(stateOf(ctx));
      return { content: [{ type: "text", text: `Enregistré dans "${scope}".` }], details: result };
    },
  });

  pi.registerTool({
    name: "mem0_update",
    label: "mem0 · update",
    loadMode: "essential",
    description:
      "Réécrit intégralement un souvenir existant, par son id (renvoyé par mem0_search, " +
      "mem0_add ou le rappel automatique). À utiliser quand un souvenir est devenu partiellement " +
      "faux, ou quand la fusion automatique de mem0_add a produit un texte bancal. Le nouveau " +
      "texte remplace l'ancien : reprends ce qui reste vrai.",
    parameters: z.object({
      memory_id: z.string(),
      text: z.string().describe("Le souvenir complet réécrit, autoportant"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await mem0.update(params.memory_id, redact(params.text));
      // Le texte a changé : cache local et sommaire sont périmés.
      const st = stateOf(ctx);
      st.mem = null;
      st.index = null;
      return { content: [{ type: "text", text: `Souvenir [${params.memory_id}] réécrit.` }], details: result };
    },
  });

  pi.registerTool({
    name: "mem0_forget",
    label: "mem0 · forget",
    loadMode: "essential",
    description:
      "Supprime un souvenir par son id (retourné par mem0_search). À utiliser quand un souvenir " +
      "est devenu faux — pas quand il est simplement incomplet ou partiellement périmé : dans ce " +
      "cas, réécris-le avec mem0_update.",
    parameters: z.object({ memory_id: z.string() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await mem0.delete(params.memory_id);
      // Le souvenir n'existe plus : cache local et sommaire sont périmés.
      const st = stateOf(ctx);
      st.mem = null;
      st.index = null;
      return { content: [{ type: "text", text: "Supprimé." }], details: result };
    },
  });

  // --- Commandes -----------------------------------------------------------

  pi.registerCommand("mem0-status", {
    description: "Connexion mem0, projet résolu, état du brief, nombre de souvenirs",
    handler: async (_args, ctx) => {
      const st = stateOf(ctx);
      const scope = projectId(ctx.cwd);
      const brief = provisioned.get(rootOf(ctx.cwd).dir) ?? checkBrief(ctx);
      try {
        const health = await mem0Fetch("/health");
        const [proj, glob] = await Promise.all([mem0.getAll(scope), mem0.getAll(GLOBAL_SCOPE)]);
        ctx.ui.notify(
          `[mem0] ok=${!!health.ok} · ${MEM0_HTTP_URL} · projet="${scope}" ${rows(proj).length} souvenir(s) · ` +
            `global ${rows(glob).length} · brief ref=${brief.ref} agents=${brief.agents}`,
          "info",
        );
        // Ce sont les ratios qui disent si le dispositif tient : recalls/turns et
        // pinned/explorations pour la couverture en lecture, adds/mutations en écriture.
        ctx.ui.notify(
          `[mem0] session : ${st.turns} tour(s) · ${st.recalls} rappel(s) non vide(s) · ` +
            `${st.explorations} exploration(s) · ${st.pinned} agrafage(s) · ${st.mutations} modification(s) · ` +
            `${st.adds} écriture(s) mémoire · sommaire ${st.index ? "présent" : "absent"}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `[mem0] injoignable sur ${MEM0_HTTP_URL} : ${(err as Error).message} · brief ref=${brief.ref} agents=${brief.agents}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("mem0-init", {
    description:
      "Amorce la mémoire d'un projet déjà existant : empreinte technique du dépôt + relecture guidée. " +
      "--scan-only pour l'empreinte seule, --force pour réamorcer un projet déjà en mémoire",
    handler: async (args, ctx) => {
      const argv = String(args ?? "");
      const force = argv.includes("--force");
      const scanOnly = argv.includes("--scan-only");
      const scope = projectId(ctx.cwd);
      const { dir, isRepo } = rootOf(ctx.cwd);

      if (!isRepo && !force) {
        ctx.ui.notify(
          `[mem0] ${dir} ne ressemble pas à un projet (ni .git ni AGENTS.md). --force pour amorcer quand même.`,
          "warning",
        );
        return;
      }

      // Le brief d'abord : sans lui, l'agent ne saura pas quoi enregistrer.
      checkBrief(ctx);

      // Garde anti-doublon. Réamorcer un projet déjà en mémoire crée des
      // quasi-doublons que la fusion mem0 ne rattrape pas toujours, et qui
      // diluent le recall.
      let existing = 0;
      try {
        existing = rows(await mem0.getAll(scope)).length;
      } catch (err) {
        ctx.ui.notify(`[mem0] injoignable sur ${MEM0_HTTP_URL} : ${(err as Error).message}`, "error");
        return;
      }

      if (existing > 0 && !force) {
        let go = false;
        if (ctx.hasUI) {
          try {
            // `confirm` prend (titre, message) : l'appel à un seul argument passait
            // un message `undefined` au dialogue.
            go = await ctx.ui.confirm(
              `Réamorcer "${scope}" ?`,
              `Ce projet a déjà ${existing} souvenir(s). Réamorcer risque de créer des doublons.`,
            );
          } catch { go = false; }
        }
        if (!go) {
          ctx.ui.notify(`[mem0] amorçage annulé (${existing} souvenir(s) existants) — /mem0-init --force pour forcer.`, "info");
          return;
        }
      }

      // 1. Empreinte technique : lue sur disque, écrite en verbatim (infer=false).
      // Pas d'extraction LLM ici — ce sont déjà des faits, et les faire passer
      // par le modèle ne ferait que les paraphraser en perdant des détails.
      const facts = scanStack(dir, scope);
      if (!facts.length) {
        ctx.ui.notify(`[mem0] rien de détectable sur disque dans ${dir} — l'amorçage repose entièrement sur la relecture.`, "warning");
      }

      let written = 0;
      let merged = 0;
      const failures: string[] = [];
      for (const fact of facts) {
        try {
          // Même chemin que mem0_add : un réamorçage ne doit pas empiler une
          // deuxième copie de l'empreinte.
          const plan = planMerge(fact, await findSimilar(fact, scope));
          if (plan.action === "skip") continue;
          if (plan.action === "update") {
            await mem0.update(plan.target.id, plan.merged);
            merged++;
            continue;
          }
          await mem0.add(fact, scope, { infer: false, tags: "stack,init" });
          written++;
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      ctx.ui.notify(
        `[mem0] empreinte de "${scope}" : ${written} nouveau(x), ${merged} complété(s), ` +
          `${facts.length - written - merged - failures.length} déjà connu(s)` +
          (failures.length ? ` · ${failures.length} échec(s) : ${failures[0]}` : ""),
        failures.length ? "warning" : "info",
      );

      if (scanOnly) return;
      if (written + merged === 0 && facts.length > 0 && failures.length > 0) {
        ctx.ui.notify("[mem0] aucune écriture n'a abouti — relecture non lancée. Vérifie /mem0-status.", "error");
        return;
      }

      // 2. Relecture guidée : la partie qui demande du jugement part au modèle,
      // en tant que message utilisateur pour que le tour démarre normalement.
      try {
        await ctx.waitForIdle?.();
        pi.sendUserMessage(initPrompt(scope, written + merged));
      } catch (err) {
        ctx.ui.notify(`[mem0] relecture non lancée : ${(err as Error).message}`, "warning");
      }
    },
  });

  pi.registerCommand("mem0-brief", {
    description: "État du brief mémoire du projet ; --update pour réécrire la version courante",
    handler: async (args, ctx) => {
      const force = String(args ?? "").includes("--update");
      const st = checkBrief(ctx, force);
      ctx.ui.notify(
        `[mem0] brief ${BRIEF_VERSION} · ${st.root} · ${BRIEF_REF_PATH}=${st.ref} · AGENTS.md=${st.agents}` +
          (st.detail ? ` (${st.detail})` : ""),
        st.ref === "failed" || st.agents === "failed" ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("mem0-dedupe", {
    description:
      "Repère les souvenirs redondants du projet et supprime les moins informatifs. Simulation " +
      "par défaut : chaque paire est affichée avec son score de recouvrement, le texte intégral " +
      "du souvenir voué à la suppression et les mots qu'elle ferait perdre. --apply pour écrire, " +
      "--strict pour ne traiter que les recouvrements quasi totaux, --scope global pour la " +
      "mémoire transverse",
    handler: async (args, ctx) => {
      const argv = String(args ?? "");
      const apply = argv.includes("--apply");
      const threshold = argv.includes("--strict") ? DEDUP_CONTAINED : DEDUPE_SWEEP_CONTAINED;
      const scope = argv.includes("--scope global") ? GLOBAL_SCOPE : projectId(ctx.cwd);

      let all: any[];
      try {
        all = rows(await mem0.getAll(scope));
      } catch (err) {
        ctx.ui.notify(`[mem0] injoignable sur ${MEM0_HTTP_URL} : ${(err as Error).message}`, "error");
        return;
      }

      // Comparaison lexicale pure, sans embedding : on travaille sur une base
      // déjà chargée en mémoire, et un aller-retour vectoriel par paire coûterait
      // O(n²) requêtes pour un gain nul sur des quasi-doublons.
      const entries: DedupeEntry[] = all
        .map((m) => ({ id: String(m?.id ?? ""), text: memoryLine(m) }))
        .filter((e) => e.id)
        .map((e) => ({ ...e, tokens: contentTokens(e.text) }));

      const actions = planDedupe(entries, threshold);

      if (!actions.length) {
        ctx.ui.notify(
          `[mem0] "${scope}" : ${entries.length} souvenir(s), aucun doublon au seuil ${threshold}.`,
          "info",
        );
        return;
      }

      if (!apply) {
        ctx.ui.notify(
          `[mem0] "${scope}" : ${actions.length} doublon(s) sur ${entries.length} souvenir(s) — simulation, rien n'est écrit.\n\n` +
            `${renderDedupePreview(actions, threshold)}\n\n` +
            `/mem0-dedupe --apply supprime les ${actions.length} souvenir(s) marqués SUPPRIME.`,
          "info",
        );
        return;
      }

      const deleted: string[] = [];
      const failures: string[] = [];
      for (const action of actions) {
        try {
          await mem0.delete(action.drop.id);
          deleted.push(action.drop.id);
        } catch (err) {
          failures.push(`[${action.drop.id}] ${(err as Error).message}`);
        }
      }
      // La base a changé sous le cache local : sommaire et agrafage seraient faux.
      const st = stateOf(ctx);
      st.mem = null;
      st.index = null;
      // Les ids supprimés partent dans le rapport : après coup, c'est la seule
      // trace qui permet de dire ce qui a disparu.
      ctx.ui.notify(
        `[mem0] "${scope}" : ${deleted.length} doublon(s) supprimé(s), ${entries.length - deleted.length} restant(s)` +
          (deleted.length ? `\n  supprimés : ${deleted.join(", ")}` : "") +
          (failures.length ? `\n  ${failures.length} échec(s) : ${failures.join(" · ")}` : ""),
        failures.length ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("mem0-save", {
    description: "Demande à l'agent d'écrire maintenant ce que cette session a produit de durable",
    handler: async (_args, ctx) => {
      const st = stateOf(ctx);
      st.nudged = true;
      await ctx.waitForIdle?.();
      pi.sendUserMessage(st.mutations > 0 ? nudgeText(st.mutations) : discussionNudgeText(st.substantiveTurns));
    },
  });

  pi.registerCommand("add-phase", {
    description: "Enregistre une phase et le brief de rôle de l'agent : /add-phase NOM BRIEF",
    handler: async (args, ctx) => {
      const argv = String(args ?? "").trim();
      const sp = argv.indexOf(" ");
      const name = (sp === -1 ? argv : argv.slice(0, sp)).trim();
      const brief = sp === -1 ? "" : argv.slice(sp + 1).trim();
      if (!name) {
        ctx.ui.notify("[mem0] usage : /add-phase NOM BRIEF", "error");
        return;
      }
      if (phases.has(name)) {
        ctx.ui.notify(`[mem0] phase "${name}" existe déjà — /remove-phase pour la retirer d'abord.`, "warning");
        return;
      }
      phases.set(name, { brief });
      savePhases(phases);
      ctx.ui.notify(`[mem0] phase "${name}" enregistrée.`, "info");
    },
  });

  pi.registerCommand("set-phase", {
    description: "Active une phase pour la session (--default réinitialise le registry) : /set-phase NOM",
    handler: async (args, ctx) => {
      const argv = String(args ?? "").trim();
      const st = stateOf(ctx);

      if (argv === "--default") {
        st.currentPhase = null;
        st.phaseTriggered = false;
        phases = new Map(DEFAULT_PHASES.map((d) => [d, { brief: "" }] as [string, PhaseEntry]));
        savePhases(phases);
        ctx.ui.notify(`[mem0] registry réinitialisé : ${DEFAULT_PHASES.join(", ")}. Aucune phase active.`, "info");
        return;
      }

      const name = argv.split(/\s+/)[0] ?? "";
      if (!name) {
        ctx.ui.notify("[mem0] usage : /set-phase NOM", "error");
        return;
      }
      if (!phases.has(name)) {
        ctx.ui.notify(`[mem0] phase "${name}" inconnue. /add-phase pour l'enregistrer, /set-phase --default pour les valeurs par défaut.`, "error");
        return;
      }
      st.currentPhase = name;
      st.phaseTriggered = false;
      const brief = phases.get(name)?.brief;
      ctx.ui.notify(`[mem0] phase "${name}" active pour cette session${brief ? ` — rôle : ${brief}` : ""}.`, "info");
    },
  });

  pi.registerCommand("remove-phase", {
    description: "Désenregistre une phase : /remove-phase NOM",
    handler: async (args, ctx) => {
      const name = String(args ?? "").trim().split(/\s+/)[0] ?? "";
      if (!name) {
        ctx.ui.notify("[mem0] usage : /remove-phase NOM", "error");
        return;
      }
      if (!phases.has(name)) {
        ctx.ui.notify(`[mem0] phase "${name}" inconnue.`, "warning");
        return;
      }
      phases.delete(name);
      savePhases(phases);
      const st = stateOf(ctx);
      if (st.currentPhase === name) st.currentPhase = null;
      ctx.ui.notify(`[mem0] phase "${name}" désenregistrée.`, "info");
    },
  });
}
