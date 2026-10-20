// Le MODÈLE et le niveau de réflexion de la session de la section « Session OMP »
// (feature model-selector-in-embedded-omp-session, S-1 à S-4) : vocabulaire,
// raisons de refus, défaut OMP du projet et application d'un choix à une session.
//
// Ce module est le SEUL du service qui appelle `.setModel(` / `.setThinkingLevel(`
// pour la session de la section et `setProjectModelRole(` (garde
// context-optimization-architecture/AC-8). Jamais de `persist` : l'écriture du
// défaut passe par la couche PROJET de `Settings` (`<cwd>/.omp/config.yml`, clé
// `modelRoles.default`), jamais par la config globale ni par un fichier écrit à la
// main.
import type { AgentSession, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { badRequest, conflict, ServiceError } from "./serviceApi.ts";

/** Les niveaux de réflexion de l'API (Vocabulaire des specs) : `auto` n'est jamais proposé. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;

/** Le modèle d'une session et son niveau, tels que l'API les rend. */
export type ModelState = { model: string | null; thinkingLevel: string | null };

/** Le défaut OMP d'un projet : même forme que l'état d'une session. */
export type ProjectModelDefault = ModelState;

/** Un choix demandé : `thinkingLevel` `null` = aucun niveau (le choix d'OMP). */
export type ModelRequest = { model: string; thinkingLevel: string | null };

// --- raisons de refus (texte exact des specs) --------------------------------

/** Une cause rapportée par OMP ou par une raison du service peut finir par un point : la phrase n'en porte qu'un. */
const stripEnd = (cause: string): string => cause.replace(/[.\s]+$/, "");

export const R_BUSY = "Changement impossible pendant que OMP répond : attendez la fin du tour.";
export const R_PURPOSE = "Seule la session de la section « Session OMP » change de modèle par cette route.";
export const R_UNAVAILABLE = (selector: string): string =>
  `Modèle inutilisable : OMP n'a pas d'authentification pour ${selector}.`;
export const R_LEVEL = (selector: string, level: string): string =>
  `Le modèle ${selector} ne prend pas en charge le niveau de réflexion « ${level} ».`;
export const R_SAVE = (cause: string): string =>
  `Modèle changé pour cette session, mais le défaut du projet n'a pas pu être enregistré : ${stripEnd(cause)}.`;
export const R_DEFAULT_NOT_APPLIED = (selector: string, cause: string): string =>
  `Défaut du projet non appliqué (${selector}) : ${stripEnd(cause)}. La session tourne sur le modèle choisi par OMP.`;
/** L'écriture du défaut SANS session (`POST /v1/projects/{repo}/model`) : R_SAVE parlerait d'une session. */
export const R_WRITE = (cause: string): string => `Défaut du projet non enregistré : ${stripEnd(cause)}.`;
export const R_UNREADABLE = (cause: string): string => `Défaut du projet illisible : ${stripEnd(cause)}.`;

// --- vocabulaire --------------------------------------------------------------

/** Ce que ce module lit d'un modèle d'OMP (`Model` de pi-ai, vu par la seule surface utile). */
export type ModelLike = {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinking?: { efforts?: readonly string[] } | null;
};

/** Le sélecteur canonique `provider/id`. */
export function selectorOf(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Les efforts supportés : `model.reasoning ? model.thinking?.efforts ?? [] : []`. */
export function supportedEfforts(model: ModelLike): string[] {
  return model.reasoning ? [...(model.thinking?.efforts ?? [])] : [];
}

/** Les niveaux PROPOSÉS : aucun sans efforts, sinon `off` puis les efforts dans l'ordre du catalogue. */
export function offeredLevels(model: ModelLike): string[] {
  const efforts = supportedEfforts(model);
  return efforts.length === 0 ? [] : ["off", ...efforts];
}

function isLevel(value: unknown): value is string {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** `modelRoles.default` → modèle + niveau : le suffixe après le DERNIER `:` n'est un niveau que s'il en est un. */
export function parseModelDefault(value: string | null | undefined): ProjectModelDefault {
  if (typeof value !== "string" || value.trim() === "") return { model: null, thinkingLevel: null };
  const raw = value.trim();
  const colon = raw.lastIndexOf(":");
  if (colon > 0 && isLevel(raw.slice(colon + 1))) {
    return { model: raw.slice(0, colon), thinkingLevel: raw.slice(colon + 1) };
  }
  return { model: raw, thinkingLevel: null };
}

/** L'inverse de `parseModelDefault` : `sélecteur`, ou `sélecteur:niveau` quand un niveau est choisi. */
export function formatModelDefault(model: string, level: string | null): string {
  return level === null ? model : `${model}:${level}`;
}

/** Le corps `{model, thinkingLevel?}` de S-2 et S-3, validé dans sa FORME (400 sinon). */
export function parseModelRequest(body: unknown): ModelRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest('corps attendu : {"model":"fournisseur/modèle","thinkingLevel":"…"}');
  }
  const record = body as { model?: unknown; thinkingLevel?: unknown };
  if (typeof record.model !== "string" || record.model.trim() === "" || !record.model.includes("/")) {
    throw badRequest("champ « model » : sélecteur « fournisseur/modèle » attendu");
  }
  const level = record.thinkingLevel;
  if (level !== undefined && level !== null && !isLevel(level)) {
    throw badRequest(`champ « thinkingLevel » : un de ${THINKING_LEVELS.join(", ")}, ou null`);
  }
  return { model: record.model, thinkingLevel: level ?? null };
}

// --- le défaut OMP du projet (S-3) --------------------------------------------

/** Le magasin du défaut de modèle d'un projet : `<cwd>/.omp/config.yml`, clé `modelRoles.default`. */
export interface ProjectModelStore {
  read(cwd: string): Promise<ProjectModelDefault>;
  /** `value` = `formatModelDefault(…)`. Lève l'erreur brute d'OMP ; l'appelant la met en mots. */
  write(cwd: string, value: string): Promise<ProjectModelDefault>;
}

const causeOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Le magasin réel : `Settings.loadIsolated({cwd})` charge global + projet SANS
 * toucher au singleton du process ; `setProjectModelRole` + `flush` écrivent le
 * seul `modelRoles.default` de `<cwd>/.omp/config.yml` (YAML atomique, verrouillé,
 * par OMP). Sans fichier de projet, la lecture ne charge rien du tout.
 */
export function createProjectModelStore(pi: ExtensionAPI): ProjectModelStore {
  const store: ProjectModelStore = {
    async read(cwd) {
      const omp = path.join(cwd, ".omp");
      if (!fs.existsSync(path.join(omp, "config.yml")) && !fs.existsSync(path.join(omp, "settings.json"))) {
        return { model: null, thinkingLevel: null };
      }
      try {
        const settings = await pi.pi.Settings.loadIsolated({ cwd });
        return parseModelDefault(settings.getProjectModelRole("default"));
      } catch (err) {
        throw new ServiceError(500, "internal", R_UNREADABLE(causeOf(err)));
      }
    },
    async write(cwd, value) {
      const settings = await pi.pi.Settings.loadIsolated({ cwd });
      settings.setProjectModelRole("default", value);
      await settings.flush();
      return store.read(cwd);
    },
  };
  return store;
}

// --- l'application d'un choix à une session (S-2, S-4) -------------------------

/** La surface d'une session OMP que l'application d'un choix touche. */
export type ModelSession = Pick<AgentSession, "isStreaming" | "getAvailableModels" | "setModel" | "setThinkingLevel">;

/**
 * Contrôle puis applique un choix à une session — SANS écrire le défaut du projet.
 * Ordre des refus (le premier qui échoue répond, rien n'est modifié) : tour en
 * cours (409), modèle absent des modèles authentifiés (409), niveau non proposé
 * (400). Puis `setModel` (sans `persist`) et ENSUITE `setThinkingLevel` : `setModel`
 * ré-applique le niveau par défaut du modèle, le choix de l'utilisateur doit le suivre.
 */
export async function applySessionModel(
  session: ModelSession,
  request: ModelRequest,
  options: { running: boolean },
): Promise<void> {
  if (options.running || session.isStreaming) throw conflict(R_BUSY);
  const model = session.getAvailableModels().find((candidate) => selectorOf(candidate) === request.model);
  if (!model) throw conflict(R_UNAVAILABLE(request.model));
  if (request.thinkingLevel !== null && !offeredLevels(model as ModelLike).includes(request.thinkingLevel)) {
    throw new ServiceError(400, "bad_request", R_LEVEL(request.model, request.thinkingLevel));
  }
  try {
    await session.setModel(model);
  } catch (err) {
    const cause = causeOf(err);
    throw conflict(
      cause.includes("No API key") ? R_UNAVAILABLE(request.model) : `Changement refusé par OMP : ${cause}`,
    );
  }
  if (request.thinkingLevel !== null) {
    session.setThinkingLevel(request.thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0]);
  }
}

/** Le modèle et le niveau ACTIFS d'une session (S-1) : `null` quand OMP n'en a pas. */
export function modelStateOf(session: {
  model?: ModelLike | null;
  configuredThinkingLevel?: () => string | null | undefined;
}): ModelState {
  const model = session.model;
  const level = typeof session.configuredThinkingLevel === "function" ? session.configuredThinkingLevel() : null;
  return { model: model ? selectorOf(model) : null, thinkingLevel: typeof level === "string" ? level : null };
}
