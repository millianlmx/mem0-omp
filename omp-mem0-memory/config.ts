// Config du dispositif : URL et jeton mem0, budgets, seuils de rappel, d'agrafage et de recherche.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * L'adresse et le jeton du service : `MEM0_HTTP_URL` / `MEM0_HTTP_TOKEN`, sinon
 * `~/.omp/mem0.json` (`{ "url", "token" }`, lu aussi par l'app OMP Console : la mémoire
 * partagée avec le serveur de pipelines), sinon le service local. Le jeton du fichier
 * ne vaut que pour l'adresse du fichier.
 */
export function resolveMem0Target(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): { url: string; token: string } {
  if (env.MEM0_HTTP_URL) return { url: env.MEM0_HTTP_URL, token: env.MEM0_HTTP_TOKEN || "" };
  let file: { url?: unknown; token?: unknown } = {};
  try {
    file = JSON.parse(readFileSync(join(home, ".omp", "mem0.json"), "utf8"));
  } catch {
    // Pas de fichier, ou illisible : le service local.
  }
  if (typeof file.url !== "string" || file.url === "") return { url: "http://localhost:8321", token: env.MEM0_HTTP_TOKEN || "" };
  const token = env.MEM0_HTTP_TOKEN || (typeof file.token === "string" ? file.token : "");
  return { url: file.url.replace(/\/+$/, ""), token };
}

const TARGET = resolveMem0Target();

export const MEM0_HTTP_URL = TARGET.url;

export const MEM0_HTTP_TOKEN = TARGET.token;

// Budgets par opération. `add` avec infer=true déclenche DEUX passes LLM côté
// serveur (extraction de faits + fusion avec l'existant) : sur qwen3-8b en local
// c'est couramment 10 à 60 s. Un budget global de quelques secondes ferait
// échouer silencieusement toutes les écritures.
// Le budget de recherche doit couvrir un premier appel à froid : l'embedding
// local (oMLX) charge son modèle à la première requête de la session. 3 s
// suffisaient à faire échouer TOUS les rappels en silence. Ce budget long ne vaut
// que pour un service FROID : une fois qu'une recherche du rappel a abouti, le
// modèle est chargé et le rappel passe à `searchWarm`. Un service qui ne répond
// plus en 5 s à chaud est en panne pour ce tour, pas en train de charger — et le
// rappel repasse au budget froid après chaque échec (rechargement après une mise
// en veille du modèle).
export const TIMEOUT = { search: 20_000, searchWarm: 5_000, write: 120_000, other: 10_000 };

// Disjoncteur du rappel : après un échec (service injoignable ou délai dépassé),
// le rappel n'appelle plus le service pendant cette durée et injecte une notice
// courte. Sans lui, chaque tour d'une panne payait le budget entier avant de
// répondre — et l'hôte coupe un handler `before_agent_start` à 30 s.
export const RECALL_BACKOFF_MS = 60_000;

export const RECALL_LIMIT = 5; // souvenirs projet injectés par tour

export const RECALL_GLOBAL_LIMIT = 2; // + préférences transverses

export const RECALL_MIN_PROMPT = 12; // en dessous ("ok", "continue"), on ne cherche pas

// Plancher de PERTINENCE. Sémantique, vérifiée dans le source de mem0 2.0.20
// (`score_and_rank`) : c'est le COSINUS BRUT (`score_details.semantic_score`) qui est
// filtré, jamais le `score` renvoyé — celui-ci est le score COMBINÉ (sémantique + bm25
// + boost entités) et BM25 le sature. Mesuré : sur « recette de tarte aux pommes », le
// souvenir le plus proche reçoit bm25 = 1.000 et un combiné de 0.716, plus haut que
// n'importe quelle ligne d'une demande pertinente — trier ou filtrer sur le combiné
// inverse donc l'ordre sémantique. D'où `explain: true` sur la recherche : sans
// `score_details`, aucune décision de pertinence n'est possible.
//
// Mesuré le 2026-09-18 sur la base réelle (69 souvenirs projet + 14 globaux, cosinus
// bruts) : le hors-sujet ne descend pas sous ~0.25 et les deux classes SE RECOUVRENT —
// « couleur du bouton de connexion » 0.424-0.478, « recette de tarte » 0.432,
// « résumé de ce qu'on a fait dans cette session » 0.501-0.534 (le hors-sujet le plus
// proche du seuil) contre 0.559-0.726 pour les demandes franchement en rapport. 0.55
// écarte TOUTES les sondes hors-sujet mesurées et garde les souvenirs qui tombent
// juste. Aucun plancher unique ne sépare parfaitement l'ambigu du modéré : le contrat
// tranche pour le silence, et c'est le sommaire exhaustif — pas ce seuil — qui rattrape
// un rappel qui rate. L'ancien 0.4 laissait entrer du hors-sujet mesuré à 0.42-0.53.
export const RECALL_THRESHOLD = 0.55;

// Sur-échantillonnage demandé au serveur (4 × la limite finale). Le serveur classe par
// score COMBINÉ : un souvenir à fort cosinus peut être rétrogradé hors du top servi,
// donc sans marge la sélection finale le manquerait. C'est `selectRelevant` qui tranche.
export const RECALL_POOL = 20;

export const RECALL_GLOBAL_POOL = 8;

// Plancher du search EXPLICITE (tool mem0_search). Sans lui, mem0 applique son
// défaut 0.1 = « renvoie tout » : une requête hors-sujet ramène les souvenirs les
// plus proches quand même. Même sémantique que RECALL_THRESHOLD — cosinus brut — et
// même valeur ; constante séparée pour la régler indépendamment du rappel.
export const SEARCH_THRESHOLD = 0.55;

export const SEARCH_POOL_MAX = 50; // plafond du pool demandé par le tool (4 × limit)

// Plancher de la recherche de FIN DE PHASE (session_stop). Elle garde 0.4 — le
// comportement d'avant : elle est déclenchée par une intention explicite (/set-phase)
// et filtrée en aval par EXECUTABLE_RE, la sévérité du rappel automatique n'a pas lieu
// de s'y appliquer.
export const PHASE_THRESHOLD = 0.4;

export const RECALL_LINE_CHARS = 100; // aperçu d'un souvenir dans le transcript, une ligne

export const RECALL_MESSAGE_TYPE = "mem0-recall";

// Le bloc de rappel est visible par défaut : un rappel muet ne se distingue pas d'un rappel absent.
export const RECALL_DISPLAY = process.env.MEM0_QUIET !== "1";

// Agrafage d'un souvenir au résultat d'un outil d'exploration.
export const PIN_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, lsp: true, edit: true, write: true };

export const PIN_MIN_RATIO = 0.5; // part des tokens de l'argument retrouvés dans le souvenir

export const PIN_COMMON_RATIO = 0.4; // au-delà, un token est trop répandu pour être informatif

export const PIN_TEXT_CHARS = 700; // longueur du souvenir agrafé

// Compteurs par outil : ce qui compte comme exploration, ce qui compte comme
// modification. `mutations > 0 && adds === 0` en fin de session déclenche la relance.
export const EXPLORE_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, lsp: true };

export const MUTATE_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, apply_patch: true };

export const GLOBAL_SCOPE = "_global";

// MEM0_MODE=runner : la session est un runner conduit par un orchestrateur (harness)
// dont un autre composant tient déjà la mémoire à jour (oracle de l'orchestrateur).
// Tout ce qui s'adresse à un humain ou coûte un tour est coupé : rappel par tour,
// épinglage sur les outils d'exploration, « mem0 checkpoint », relance de fin de
// session, pose du brief. Les outils mem0_* restent enregistrés. Lu à l'APPEL,
// pas à l'évaluation du module : l'environnement fait foi au moment du hook.
export function runnerMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.MEM0_MODE === "runner";
}

// MEM0_NUDGE=0 coupe la relance d'écriture de fin de session seule — pour les
// agents pilotés qui gardent le reste du dispositif : sans elle, chaque étape
// paierait un tour de plus. MEM0_MODE=runner la coupe aussi. Lu à l'APPEL.
export function sessionNudgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MEM0_NUDGE !== "0" && !runnerMode(env);
}

// MEM0_AUTOSETUP=0 pour ne jamais écrire dans un dépôt.
export const AUTOSETUP = process.env.MEM0_AUTOSETUP !== "0";
