// Jeu de données fictif FIXE de la recette UI Mac (S-4 de
// recette-ui-mac-automatisee) : le dépôt git « atelier » et ses worktrees, le
// magasin pipeline, les transcriptions, le support modèle, l'omp factice, et
// les réponses du serveur de fixture (service OMP, mem0-http, oMLX).
//
// Ce module est PUR : il décrit des fichiers, des commits et des réponses ; seul
// recette.ts (sous-commande `fixture`) écrit sur disque, appelle git et écoute.
// Les formats sont ceux que l'app décode (omp-console/Tests/OMPConsoleTests/
// StoreFixtures.swift, ViewerFixtures.swift, ProjectFixtures.swift ;
// Sources/ConsoleCore/Store/StoreModels.swift).
//
// Déterminisme : aucune horloge, aucun aléa, aucune variable d'environnement
// n'est lue ici. Toute date vaut `debut - décalage`, avec un décalage d'au moins
// 2 h pour que les libellés relatifs (« il y a 3 h ») ne bougent pas pendant le
// passage ; seuls les commits ont des dates absolues, pour des SHA stables.
import { createHash } from "node:crypto";

/** Jeton du service OMP fictif (`service.json`, en-tête `X-OMP-Service-Token`). */
export const JETON_SERVICE = "0123456789abcdef0123456789abcdef";
/** Jeton d'installation fictif : `stack/installation-token`, rendu par `GET /health`. */
export const JETON_INSTALLATION = "5265636574746520554920646520274f4d5020436f6e736f6c6527204d61632e";

const HEURE = 3_600_000;
const JOUR = 24 * HEURE;

/** Ce dont le jeu dépend, et rien d'autre. */
export type EntreeJeu = {
  /** R, absolue, telle que passée (les chemins écrits gardent cette forme). */
  racine: string;
  /** `realpath(R/depots/atelier)` : seule entrée de la clé de dépôt (sha1 du chemin réel). */
  depotReel: string;
  /** Pid du processus de fixture : propriétaire vivant du lot, du run et du service. */
  pid: number;
  /** Port du serveur de fixture. */
  port: number;
  /** Début du passage, en ms depuis l'époque. */
  debut: number;
};

/** Un fichier du jeu, chemin relatif à R. */
export type FichierJeu = { chemin: string; contenu: string; mode: number };

/** Un commit du dépôt fictif : fichiers écrits (relatifs au dépôt) puis commités tous. */
export type CommitFictif = { date: string; message: string; fichiers: Record<string, string> };

/** Le dépôt git fictif `R/depots/atelier`, décrit comme données. */
export type DepotFictif = {
  auteur: { nom: string; courriel: string };
  branche: string;
  commits: CommitFictif[];
  /** Écrits après le dernier commit, jamais commités (modification + fichier non suivi). */
  nonCommites: Record<string, string>;
  /** Worktrees créés depuis `branche`, chemins relatifs à R. */
  worktrees: Array<{ chemin: string; branche: string }>;
};

/** Les fonctionnalités du jeu, dans l'ordre où elles sont écrites. */
const SLUGS = ["carnet", "export", "tri", "theme"] as const;
type Slug = (typeof SLUGS)[number];

/** Worktree de chaque feature, relatif à R ; `export` n'en a pas encore (question de /req). */
const WORKTREE: Record<Slug, string | null> = {
  carnet: "depots/atelier-carnet",
  export: null,
  tri: "depots/atelier-tri",
  theme: "depots/atelier-theme",
};

export function depotFictif(): DepotFictif {
  return {
    auteur: { nom: "Recette OMP", courriel: "recette@exemple.invalid" },
    branche: "main",
    commits: [
      {
        date: "2026-01-05T09:00:00Z",
        message: "Premier jet du carnet",
        fichiers: {
          "README.md": "# Atelier\n\nUn carnet de bord fictif, servi à la recette de l'interface Mac d'OMP Console.\n",
          "src/carnet.txt": "Lundi : poncer la table.\nMardi : huiler les chaises.\n",
          "docs/guide.md": "# Guide\n\nChaque ligne du carnet est une tâche de l'atelier.\n",
        },
      },
      {
        date: "2026-01-06T09:00:00Z",
        message: "Compléter le guide et le carnet",
        fichiers: {
          "src/carnet.txt": "Lundi : poncer la table.\nMardi : huiler les chaises.\nMercredi : vernir l'étagère.\n",
          "docs/guide.md": "# Guide\n\nChaque ligne du carnet est une tâche de l'atelier.\nUne tâche finie est barrée, jamais effacée.\n",
        },
      },
    ],
    nonCommites: {
      "src/carnet.txt": "Lundi : poncer la table.\nMardi : huiler les chaises.\nMercredi : vernir l'étagère.\nJeudi : ranger l'établi.\n",
      "notes.txt": "Penser à commander du papier de verre grain 240.\n",
    },
    worktrees: SLUGS.flatMap((slug) => {
      const chemin = WORKTREE[slug];
      return chemin === null ? [] : [{ chemin, branche: `feat/${slug}` }];
    }),
  };
}

/** sha1(chemin réel)[:16] : la clé de dépôt de l'app (KanbanRepoKey.key, KanbanModels.swift). */
export function cleDepot(depotReel: string): string {
  return createHash("sha1").update(depotReel).digest("hex").slice(0, 16);
}

/** Un identifiant d'entrée running/history : 16 hexadécimaux, stable par nom. */
function idEntree(nom: string): string {
  return createHash("sha1").update(`recette-ui-mac:${nom}`).digest("hex").slice(0, 16);
}

/** JSON à clés triées, comme `jsonText` des fixtures Swift : même entrée, mêmes octets. */
function jsonTrie(valeur: unknown): string {
  const trier = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(trier);
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, trier(o[k])]));
    }
    return v;
  };
  return JSON.stringify(trier(valeur));
}

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Magasin pipeline (formats de StoreFixtures.swift)

function lotFeature(e: EntreeJeu, slug: Slug, champs: {
  state: string;
  phase: string;
  waitKind: string | null;
  waitPrompt?: string;
  prUrl?: string;
  sinceAt: number;
  endedAt?: number;
}): Record<string, unknown> {
  const worktree = WORKTREE[slug];
  return {
    slug,
    name: slug,
    branch: `feat/${slug}`,
    worktree: worktree === null ? "" : `${e.racine}/${worktree}`,
    deps: [],
    origin: "panneau",
    state: champs.state,
    phase: champs.phase,
    waitKind: champs.waitKind,
    waitPrompt: champs.waitPrompt ?? null,
    sessionFile: null,
    pendingTexts: [],
    prUrl: champs.prUrl ?? null,
    stopReason: null,
    fixes: 0,
    reviewRuns: 0,
    unreadableRuns: 0,
    reviewHash: null,
    lastVerdict: null,
    lastBlockers: 0,
    lastRunSessionFile: null,
    contractHash: null,
    addedAt: e.debut - 3 * JOUR,
    sinceAt: champs.sinceAt,
    updatedAt: champs.sinceAt,
    endedAt: champs.endedAt ?? null,
    model: "recette/claude",
  };
}

const PR_THEME = "https://github.com/exemple/atelier/pull/7";
const QUESTION_EXPORT = "Quel format d'export veux-tu : CSV ou JSON ?";

function lot(e: EntreeJeu, cle: string): Record<string, unknown> {
  return {
    version: 1,
    id: cle,
    repoRoot: `${e.racine}/depots/atelier`,
    status: "running",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: e.pid, sessionFile: null, sessionId: null },
    createdAt: e.debut - 3 * JOUR,
    launchedAt: e.debut - 3 * JOUR + HEURE,
    features: [
      lotFeature(e, "carnet", { state: "waiting", phase: "specs", waitKind: "specs", sinceAt: e.debut - 5 * HEURE }),
      lotFeature(e, "export", { state: "waiting", phase: "req", waitKind: "answer", waitPrompt: QUESTION_EXPORT, sinceAt: e.debut - 4 * HEURE }),
      lotFeature(e, "tri", { state: "running", phase: "impl", waitKind: null, sinceAt: e.debut - 3 * HEURE }),
      lotFeature(e, "theme", { state: "done", phase: "review", waitKind: null, prUrl: PR_THEME, sinceAt: e.debut - 2 * JOUR, endedAt: e.debut - 26 * HEURE }),
    ],
  };
}

const INTENTIONS: Record<Slug, string> = {
  carnet: "Un carnet de bord qui liste les tâches de l'atelier, jour par jour.",
  export: "Exporter le carnet pour l'imprimer ou le partager.",
  tri: "Trier les tâches du carnet par jour puis par priorité.",
  theme: "Un thème clair et sombre pour lire le carnet le soir.",
};

function projet(e: EntreeJeu, cle: string): Record<string, unknown> {
  const feature = (slug: Slug, status: string, prUrl: string | null, depuis: number) => ({
    slug,
    intention: INTENTIONS[slug],
    status,
    prUrl,
    failure: null,
    removedReason: null,
    updatedAt: e.debut - depuis,
    model: "recette/claude",
  });
  const creation = e.debut - 3 * JOUR;
  return {
    version: 1,
    repoKey: cle,
    repoRoot: `${e.racine}/depots/atelier`,
    relayKey: `${e.racine}/magasin/projects/${cle}@${creation}`,
    purpose: "Un carnet de bord pour l'atelier : noter, trier et partager les tâches.",
    function: "Le carnet liste les tâches du jour ; chaque feature l'enrichit d'un geste.",
    status: "running",
    segments: [
      {
        name: "Carnet de bord",
        features: [
          feature("carnet", "launched", null, 5 * HEURE),
          feature("export", "launched", null, 4 * HEURE),
          feature("tri", "launched", null, 3 * HEURE),
          feature("theme", "pr", PR_THEME, 26 * HEURE),
        ],
      },
    ],
    current: 0,
    base: null,
    hostSession: null,
    createdAt: creation,
    updatedAt: e.debut - 2 * HEURE,
  };
}

function running(e: EntreeJeu): Record<string, unknown> {
  return {
    version: 1,
    id: idEntree("run-tri"),
    cwd: `${e.racine}/${WORKTREE.tri}`,
    label: "atelier/tri",
    phase: "impl",
    state: "running",
    phaseStartedAt: e.debut - 3 * HEURE,
    updatedAt: e.debut - 2 * HEURE,
    owner: { pid: e.pid },
    sessionFile: `${e.racine}/sessions/tri.jsonl`,
    sessionId: "recette-tri",
  };
}

function history(e: EntreeJeu, slug: "theme" | "carnet", phase: string, debutPhase: number, fin: number): Record<string, unknown> {
  return {
    version: 1,
    id: idEntree(`history-${slug}`),
    cwd: `${e.racine}/${WORKTREE[slug]}`,
    label: `atelier/${slug}`,
    phase,
    finalState: "done",
    phaseStartedAt: e.debut - debutPhase,
    endedAt: e.debut - fin,
    sessionFile: `${e.racine}/sessions/${slug}.jsonl`,
    sessionId: `recette-${slug}`,
  };
}

// ---------------------------------------------------------------------------
// Transcriptions (format ViewerLines de ViewerFixtures.swift)

type Tour = { utilisateur: string; assistant: string; outil?: { nom: string; arguments: Record<string, unknown>; resultat: string } };

function transcription(e: EntreeJeu, id: string, cwd: string, ilYA: number, tours: Tour[]): string {
  let n = 0;
  const message = (contenu: Record<string, unknown>): string => {
    n += 1;
    return jsonTrie({ type: "message", id: `e${n}`, timestamp: iso(e.debut - ilYA + n * 60_000), parentId: null, message: contenu });
  };
  const lignes = [jsonTrie({ type: "session", id, timestamp: iso(e.debut - ilYA), cwd, version: 3 })];
  tours.forEach((tour, i) => {
    lignes.push(message({ role: "user", content: [{ type: "text", text: tour.utilisateur }] }));
    const appel = tour.outil === undefined ? [] : [{ type: "toolCall", id: `appel-${i + 1}`, name: tour.outil.nom, arguments: tour.outil.arguments }];
    lignes.push(message({
      role: "assistant",
      model: "recette/claude",
      content: [{ type: "text", text: tour.assistant }, ...appel],
      usage: { input: 1200 + 300 * i, output: 240 + 60 * i, cacheRead: 800, cacheWrite: 0, totalTokens: 2240 + 360 * i, cost: { total: 0.012 + 0.003 * i } },
    }));
    if (tour.outil !== undefined) {
      lignes.push(message({ role: "toolResult", toolCallId: `appel-${i + 1}`, toolName: tour.outil.nom, content: [{ type: "text", text: tour.outil.resultat }] }));
    }
  });
  return `${lignes.join("\n")}\n`;
}

function transcriptions(e: EntreeJeu): FichierJeu[] {
  const depot = `${e.racine}/depots/atelier`;
  const sessions: Array<[string, string, string, number, Tour[]]> = [
    ["tri", "recette-tri", `${e.racine}/${WORKTREE.tri}`, 3 * HEURE, [
      { utilisateur: "Implémente le tri des tâches par jour puis par priorité.", assistant: "Je lis le carnet pour voir son format.", outil: { nom: "read", arguments: { path: "src/carnet.txt" }, resultat: "Lundi : poncer la table.\nMardi : huiler les chaises." } },
      { utilisateur: "Garde l'ordre des jours de la semaine.", assistant: "Entendu : les jours restent dans l'ordre du lundi au dimanche, la priorité départage une même journée." },
    ]],
    ["theme", "recette-theme", `${e.racine}/${WORKTREE.theme}`, 30 * HEURE, [
      { utilisateur: "Relis la feature du thème clair et sombre.", assistant: "La relecture est terminée : aucun défaut bloquant, la PR est ouverte." },
    ]],
    ["carnet", "recette-carnet", `${e.racine}/${WORKTREE.carnet}`, 6 * HEURE, [
      { utilisateur: "Je veux un carnet de bord qui liste les tâches de l'atelier.", assistant: "J'ai rédigé les besoins et les critères d'acceptation du carnet dans le contrat." },
    ]],
    ["session-omp", "recette-session-omp", depot, 150 * 60_000, [
      { utilisateur: "Résume l'état du carnet.", assistant: "Le carnet compte quatre tâches, dont une ajoutée hier et pas encore enregistrée." },
    ]],
  ];
  return sessions.map(([nom, id, cwd, ilYA, tours]) => ({
    chemin: `sessions/${nom}.jsonl`,
    contenu: transcription(e, id, cwd, ilYA, tours),
    mode: 0o644,
  }));
}

// ---------------------------------------------------------------------------
// Contrat du worktree `carnet`, attendu au jalon specs

const CONTRAT_CARNET = [
  "# Contrat — carnet",
  "",
  "## Besoins",
  "- B-1 : Lister les tâches de l'atelier jour par jour, dans l'ordre de la semaine.",
  "",
  "## Critères d'acceptation",
  "- AC-1 (B-1) : Given un carnet de trois jours, When on l'ouvre, Then les tâches apparaissent groupées par jour, du lundi au dimanche.",
  "",
  "## Spécifications",
  "",
  "### S-1 — Lecture du carnet (AC-1 ; B-1)",
  "- `src/carnet.txt` porte une tâche par ligne, au format `<jour> : <tâche>`.",
  "",
].join("\n");

/** Le script `omp` factice : seul `models --json` répond, tout le reste sort 0 en silence. */
const OMP_FACTICE = [
  "#!/bin/sh",
  "# omp factice de la recette UI Mac : catalogue de modèles fictif, rien d'autre.",
  'if [ "$#" -eq 2 ] && [ "$1" = "models" ] && [ "$2" = "--json" ]; then',
  `  printf '%s\\n' '{"models":[{"selector":"recette/claude","name":"Claude Recette"},{"selector":"recette/gpt","name":"GPT Recette"}]}'`,
  "fi",
  "exit 0",
  "",
].join("\n");

/**
 * Tous les fichiers du jeu, hors dépôt git (décrit par `depotFictif`) et hors
 * `fixture.json` (écrit en dernier par recette.ts, serveur à l'écoute).
 */
export function jeuFictif(e: EntreeJeu): FichierJeu[] {
  const cle = cleDepot(e.depotReel);
  const json = (chemin: string, objet: unknown): FichierJeu => ({ chemin, contenu: jsonTrie(objet), mode: 0o644 });
  return [
    json(`magasin/lots/${cle}.json`, lot(e, cle)),
    json(`magasin/projects/${cle}.json`, projet(e, cle)),
    json(`magasin/running/${idEntree("run-tri")}.json`, running(e)),
    json(`magasin/history/${idEntree("history-theme")}.json`, history(e, "theme", "review", 30 * HEURE, 26 * HEURE)),
    json(`magasin/history/${idEntree("history-carnet")}.json`, history(e, "carnet", "req", 6 * HEURE, 5 * HEURE)),
    json("magasin/service.json", { version: 1, pid: e.pid, port: e.port, token: JETON_SERVICE, stateDir: `${e.racine}/magasin` }),
    ...transcriptions(e),
    { chemin: "support-modele/stack/installation-token", contenu: `${JETON_INSTALLATION}\n`, mode: 0o644 },
    { chemin: "support-modele/stack/env", contenu: `OMLX_BASE_URL=http://127.0.0.1:${e.port}/v1\n`, mode: 0o644 },
    { chemin: "bin/omp", contenu: OMP_FACTICE, mode: 0o755 },
    { chemin: `${WORKTREE.carnet}/.omp/pipeline/contract.md`, contenu: CONTRAT_CARNET, mode: 0o644 },
  ];
}

// ---------------------------------------------------------------------------
// Serveur de fixture : routes de S-4, réponses pures

export type Requete = { methode: string; url: string; jetonService: string | undefined; corps: string };
export type Reponse =
  | { type: "json"; statut: number; corps: unknown }
  /** Flux SSE : la trame `dialog` part aussitôt, suivie de `: ping` ; le flux reste ouvert. */
  | { type: "flux"; trame: string };

const INTROUVABLE: Reponse = { type: "json", statut: 404, corps: { error: "not_found", reason: "route non servie par la recette" } };

/** `event: <nom>\ndata: <json>\n\n`, puis un commentaire `: ping` qui force la ligne vide côté app (D-9). */
export function trameSse(evenement: string, donnees: unknown): string {
  return `event: ${evenement}\ndata: ${JSON.stringify(donnees)}\n\n: ping\n\n`;
}

const DIALOGUES: Record<string, unknown> = {
  "recette-session": {
    id: "recette-dialogue-session",
    method: "select",
    title: "Quel modèle pour cette session ?",
    options: ["Claude Recette", "GPT Recette"],
  },
  "recette-conduite": {
    id: "recette-dialogue-conduite",
    method: "select",
    title: "Quel périmètre pour la recette ? (1/3)\nLe projet fictif atelier attend ta réponse.",
    options: ["Tout le dépôt", "Seulement src/"],
  },
};

const SOUVENIRS: Array<[string, string, string]> = [
  ["recette-1", "Le carnet de l'atelier liste une tâche par ligne, au format « jour : tâche ».", "recette,mac"],
  ["recette-2", "Les jours du carnet restent dans l'ordre de la semaine, du lundi au dimanche.", "recette,carnet"],
  ["recette-3", "Une tâche finie est barrée dans le carnet, jamais effacée.", "recette,carnet"],
  ["recette-4", "L'export du carnet attend le choix entre CSV et JSON.", "recette,export"],
  ["recette-5", "Le thème sombre du carnet garde un contraste d'au moins 4,5:1.", "recette,theme"],
  ["recette-6", "Les commandes de papier de verre se notent dans notes.txt.", "recette,atelier"],
];

/**
 * Les réponses du serveur de fixture. Tient la liste des sessions créées : la
 * seule mémoire du serveur, et la même suite de requêtes rend toujours les mêmes
 * réponses.
 */
export class RouteurFixture {
  readonly racine: string;
  readonly debut: number;
  readonly sessions = new Map<string, Record<string, unknown>>();

  constructor(racine: string, debut: number) {
    this.racine = racine;
    this.debut = debut;
  }

  repondre(r: Requete): Reponse {
    const url = new URL(r.url, "http://127.0.0.1");
    const chemin = url.pathname;
    if (chemin === "/v1" || chemin.startsWith("/v1/")) return this.service(r, chemin);
    if (r.methode !== "GET") return INTROUVABLE;
    const ok = (corps: unknown): Reponse => ({ type: "json", statut: 200, corps });
    switch (chemin) {
      case "/health":
        return ok({ ok: true, installation: JETON_INSTALLATION });
      case "/memory/all": {
        const agent = url.searchParams.get("agent_id") ?? "atelier";
        return ok({
          total: SOUVENIRS.length,
          results: SOUVENIRS.map(([id, memory, tags], i) => ({
            id,
            memory,
            updated_at: iso(this.debut - (2 + i) * JOUR),
            metadata: { tags },
            agent_id: agent,
          })),
        });
      }
      case "/memory/graph":
        return ok({
          total: 3,
          edges: [
            { source: "recette-1", target: "recette-2", score: 0.82 },
            { source: "recette-2", target: "recette-3", score: 0.74 },
            { source: "recette-4", target: "recette-5", score: 0.66 },
          ],
        });
      case "/models":
        return ok({ object: "list", data: [{ id: "qwen3-8b" }, { id: "bge-m3" }] });
      default:
        return INTROUVABLE;
    }
  }

  private service(r: Requete, chemin: string): Reponse {
    if (r.jetonService !== JETON_SERVICE) return { type: "json", statut: 401, corps: { error: "unauthorized" } };
    const ok = (corps: unknown): Reponse => ({ type: "json", statut: 200, corps });
    const decoder = (segment: string): string | null => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return null;
      }
    };

    if (chemin === "/v1/sessions") {
      if (r.methode === "GET") return ok({ sessions: [...this.sessions.values()] });
      if (r.methode !== "POST") return INTROUVABLE;
      let corps: unknown;
      try {
        corps = JSON.parse(r.corps);
      } catch {
        corps = undefined;
      }
      const cwd = corps !== null && typeof corps === "object" && "cwd" in corps ? corps.cwd : undefined;
      if (typeof cwd !== "string" || cwd === "") return { type: "json", statut: 400, corps: { error: "bad_request", reason: "cwd absent" } };
      const session = { id: "recette-session", cwd, purpose: "session", state: "running", sessionFile: `${this.racine}/sessions/session-omp.jsonl` };
      this.sessions.set(session.id, session);
      return ok(session);
    }

    const conduite = /^\/v1\/projects\/(.+)\/conduite$/.exec(chemin);
    if (conduite !== null) {
      const depot = decoder(conduite[1]);
      if (depot === null) return INTROUVABLE;
      if (r.methode === "DELETE") return ok({ closed: true });
      if (r.methode !== "POST") return INTROUVABLE;
      this.sessions.set("recette-conduite", { id: "recette-conduite", cwd: depot, purpose: "project", state: "running", sessionFile: null });
      return ok({ sessionId: "recette-conduite", state: "running" });
    }

    const evenements = /^\/v1\/sessions\/([^/]+)\/events$/.exec(chemin);
    if (evenements !== null) {
      const dialogue = DIALOGUES[decoder(evenements[1]) ?? ""];
      if (r.methode !== "GET" || dialogue === undefined) return INTROUVABLE;
      return { type: "flux", trame: trameSse("dialog", dialogue) };
    }

    if (/^\/v1\/sessions\/[^/]+\/dialogs\/[^/]+$/.test(chemin)) {
      return r.methode === "POST" ? ok({ accepted: true }) : INTROUVABLE;
    }

    const session = /^\/v1\/sessions\/([^/]+)$/.exec(chemin);
    if (session !== null) {
      if (r.methode === "DELETE") return ok({ closed: true });
      const connue = this.sessions.get(decoder(session[1]) ?? "");
      return r.methode === "GET" && connue !== undefined ? ok(connue) : INTROUVABLE;
    }
    return INTROUVABLE;
  }
}
