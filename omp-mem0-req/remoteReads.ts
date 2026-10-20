// Les routes de LECTURE de l'API distante (S-3) : sessions, session.file, projects, documents,
// stats, models, repos. Portage de `RemoteReads` (omp-console/Sources/OMPConsole/Remote/RemoteReads.swift :
// `sessions`, `session`, `projects`, `documents`, `statistics`, `models`) et de `RemoteActions.knownRepos`.
// Le magasin, la mémoire, le journal et le flux sont à d'autres modules (`remoteStore.ts`, …).
import fs from "node:fs";
import path from "node:path";
import { RemoteError, remoteJson } from "./remoteApi.ts";
import type { RemoteRoute } from "./remoteApi.ts";
import type { RemoteContext } from "./remoteContext.ts";
import { repoRows } from "./remoteRepos.ts";
import { sessionPayload } from "./remoteSessions.ts";
import { statsPayload, storeRuns } from "./remoteStats.ts";

/** Le délai de garde de `omp models --json` (`ModelCatalogLoader.timeout`). */
const MODELS_TIMEOUT_MS = 15_000;
/** Le binaire de remplacement de `OmpBinaryResolver` : `OMP_CONSOLE_OMP_BINARY`. */
const OMP_BINARY_OVERRIDE_KEY = "OMP_CONSOLE_OMP_BINARY";
/** Le code qu'un enfant tué à l'échéance (SIGTERM) rend à `ProcessRunner`. */
const SIGTERM_CODE = 15;

export type RemoteDocument = { name: string; state: "text" | "missing" | "binary" | "unreadable"; content?: string; reason?: string };

export type RemoteModelsPayload = {
  selectors: string[];
  failure?: string;
  names?: Record<string, string>;
  thinking?: Record<string, string[]>;
};

/**
 * Un document : `text`, `missing`, `binary` ou `unreadable`. « Absent » et « présent mais illisible »
 * sont distincts : un fichier existant que l'on ne peut lire (droits, dossier) est `unreadable`.
 */
export function remoteDocument(name: string, file: string): RemoteDocument {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    if (fs.existsSync(file)) return { name, state: "unreadable", reason: "lecture impossible" };
    return { name, state: "missing" };
  }
  try {
    return { name, state: "text", content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data) };
  } catch {
    return { name, state: "binary", reason: "contenu non textuel" };
  }
}

// --- le catalogue des modèles (OMPConsole/Launch/ModelCatalog.swift) ------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Les éléments de `{"models":[…]}` ; `null` quand le JSON n'a pas cette forme (un élément non objet compris). */
function modelEntries(stdout: string): Json[] | null {
  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isObject(root) || !Array.isArray(root.models)) return null;
  return root.models.every(isObject) ? (root.models as Json[]) : null;
}

const isBlank = (value: string): boolean => value.trim() === "";

/** Sélecteurs triés (doublons retirés), noms lisibles et efforts de réflexion d'une même sortie ; `null` si illisible. */
export function parseModelListing(stdout: string): Required<Pick<RemoteModelsPayload, "selectors" | "names" | "thinking">> | null {
  const models = modelEntries(stdout);
  if (models === null) return null;
  const seen = new Set<string>();
  const selectors: string[] = [];
  const names: Record<string, string> = {};
  const thinking: Record<string, string[]> = {};
  const seenThinking = new Set<string>();
  for (const model of models) {
    const selector = model.selector;
    if (typeof selector !== "string" || isBlank(selector)) continue;
    if (!seen.has(selector)) {
      seen.add(selector);
      selectors.push(selector);
    }
    const name = model.name;
    if (typeof name === "string" && !isBlank(name) && !Object.hasOwn(names, selector)) names[selector] = name;
    if (!seenThinking.has(selector)) {
      seenThinking.add(selector);
      if (Array.isArray(model.thinking)) {
        const levels = model.thinking.filter((l): l is string => typeof l === "string");
        if (levels.length > 0) thinking[selector] = levels;
      }
    }
  }
  return { selectors: selectors.sort(), names, thinking };
}

/**
 * `omp models --json` : un binaire absent, un code non nul ou une sortie illisible ne jettent PAS — la
 * réponse porte `failure` et une liste vide, ce n'est pas une erreur de transport.
 */
async function loadModels(ctx: RemoteContext): Promise<RemoteModelsPayload> {
  const override = ctx.env[OMP_BINARY_OVERRIDE_KEY];
  const binary = override !== undefined && override !== "" ? override : "omp";
  const run = await ctx.exec(binary, ["models", "--json"], { timeoutMs: MODELS_TIMEOUT_MS });
  if (run.missing) return { selectors: [], failure: "omp introuvable" };
  const code = run.timedOut ? SIGTERM_CODE : run.code;
  if (code === null) return { selectors: [], failure: "lancement impossible" };
  if (code !== 0) return { selectors: [], failure: `omp models a échoué (code ${code})` };
  const listing = parseModelListing(run.stdout);
  if (listing === null) return { selectors: [], failure: "réponse illisible" };
  return { selectors: listing.selectors, names: listing.names, thinking: listing.thinking };
}

// --- les routes ---------------------------------------------------------------------------------

export function readRoutes(ctx: RemoteContext): RemoteRoute[] {
  return [
    {
      method: "GET",
      path: "v1/sessions",
      handle: () => remoteJson({ runs: storeRuns(ctx.store.snapshot()) }),
    },
    {
      method: "GET",
      path: "v1/sessions/:id",
      // Le paramètre est le CHEMIN absolu du fichier de session (percent-encodé par le client).
      handle: ({ params }) => {
        const file = params.id ?? "";
        if (!fs.existsSync(file)) throw new RemoteError("not_found", "session introuvable");
        return remoteJson(sessionPayload(file));
      },
    },
    {
      method: "GET",
      path: "v1/projects",
      handle: () => remoteJson({ projects: ctx.store.snapshot().projects.projects }),
    },
    {
      method: "GET",
      path: "v1/projects/:repoKey/documents",
      handle: ({ params }) => {
        const repoKey = params.repoKey ?? "";
        const project = ctx.store.snapshot().projects.projects.find(p => p.repoKey === repoKey);
        if (project === undefined) throw new RemoteError("not_found", "projet inconnu");
        const projectDoc = path.join(ctx.stateDir, "projects", `${repoKey}.doc`, "PROJECT.md");
        const contractDoc = path.join(project.repoRoot, ".omp", "pipeline", "contract.md");
        return remoteJson({
          documents: [remoteDocument("PROJECT.md", projectDoc), remoteDocument("contract.md", contractDoc)],
        });
      },
    },
    {
      method: "GET",
      path: "v1/stats",
      handle: ({ req }) => {
        const project = new URL(req.url).searchParams.get("project");
        return remoteJson(
          statsPayload(ctx.store.snapshot(), project, {
            now: ctx.now,
            pidAlive: ctx.pidAlive,
            home: ctx.env.HOME,
          }),
        );
      },
    },
    {
      method: "GET",
      path: "v1/models",
      handle: async () => remoteJson(await loadModels(ctx)),
    },
    {
      method: "GET",
      path: "v1/repos",
      handle: () => remoteJson({ rows: repoRows(ctx) }),
    },
  ];
}
