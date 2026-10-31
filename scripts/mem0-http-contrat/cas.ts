// Cas du contrat boîte noire mem0-http (specs S-5, S-6, S-7) — le SEUL fichier
// de cas : viser un autre serveur (mem0-rs) se fait par MEM0_CONTRAT_URL et
// MEM0_CONTRAT_START, jamais en touchant à ce fichier.
//
// Il porte aussi le catalogue des formes (jeu de clés exact de chaque réponse 2xx)
// et l'interface de phase / groupe / cas que consomme le lanceur contrat.ts.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { JETON_OPENAI, MODELE_CHAT, plonger } from "./faux-openai.ts";
import type { RequeteChat, RequeteEmbeddings } from "./faux-openai.ts";
import type { Forme } from "./formes.ts";

// ---------------------------------------------------------------------------
// Interface consommée par contrat.ts
// ---------------------------------------------------------------------------

export type Methode = "GET" | "POST" | "PUT" | "DELETE";

export type Requete = {
  methode: Methode;
  /** Gabarit de route, ex. `/memory/{id}` : c'est lui que nomment journal et écarts. */
  gabarit: string;
  /** Chemin effectif, requête comprise (ex. `/memory/all?agent_id=x`) ; défaut : le gabarit. */
  chemin?: string;
  /** Corps JSON (POST, PUT). */
  corps?: unknown;
  /** Valeur de `X-Mem0-Token` ; `null` = aucun en-tête ; absent = défaut de la phase. */
  jeton?: string | null;
  /** Statut attendu, 200 par défaut. Un autre statut fait échouer le cas. */
  statut?: number;
  /** Forme OBLIGATOIRE de toute réponse 2xx ; le corps d'une réponse non 2xx n'est lu que si `corpsErreur` est posé. */
  forme?: Forme;
  /**
   * Corps JSON exact attendu quand le statut reçu est le statut attendu non 2xx :
   * `content-type` application/json et `JSON.parse(corps)` profondément égal.
   */
  corpsErreur?: unknown;
};

export type EntreeJournal = { phase: string; route: string; jeton: boolean; statut: number };

export type Contexte = {
  /**
   * Envoie la requête et rend le corps JSON vérifié (2xx), ou `null` (statut
   * attendu non 2xx). Lève `EchecCas` sur un statut inattendu, une forme fausse
   * ou une erreur réseau : le cas s'arrête là.
   */
  appeler(requete: Requete): Promise<unknown>;
  /** Consigne un écart (`<route> : <constat>`) si la condition est fausse ; le cas continue. */
  constater(condition: boolean, ecart: string): void;
  /** Toutes les requêtes des cas, toutes phases confondues, dans l'ordre d'envoi. */
  journal(): readonly EntreeJournal[];
  /** Compteurs de requêtes reçues par le faux OpenAI. */
  compteursOpenAI(): { embeddings: number; chat: number };
  /** Requêtes chat reçues par le faux OpenAI (toutes), dans l'ordre de réception. */
  requetesChat(): RequeteChat[];
  /** Requêtes embeddings rendues en 200 par le faux OpenAI, dans l'ordre de réception. */
  requetesEmbeddings(): RequeteEmbeddings[];
  /** Fixture de rang chargée par le lanceur (phase `rang`, hors mode externe). */
  fixtureRang(): FixtureRang;
};

export type Cas = { libelle: string; executer(ctx: Contexte): Promise<void> };

export type Groupe = {
  nom: string;
  /** Groupe des ajouts infer=true : désactivé par MEM0_CONTRAT_INFER=0 (S-6). */
  infer?: true;
  /** Non applicable à une instance externe (rapporté SKIP en mode externe). */
  horsExterne?: true;
  /** Fabrique les cas : un état neuf (ids retenus…) à chaque exécution. */
  cas(): Cas[];
};

export type Phase = {
  nom: string;
  /**
   * `MEM0_HTTP_TOKEN` de l'instance NEUVE démarrée pour la phase : `""` = serveur
   * ouvert, non vide = serveur à jeton (phase sautée en mode externe), `null` =
   * phase sans instance (contrôles sur le journal seulement).
   */
  jetonServeur: string | null;
  groupes: readonly Groupe[];
};

/** Écarts d'un cas, levés pour l'arrêter. */
export class EchecCas extends Error {
  readonly ecarts: readonly string[];
  constructor(ecarts: readonly string[]) {
    super(ecarts.join("\n"));
    this.ecarts = ecarts;
  }
}

// ---------------------------------------------------------------------------
// Fixture de rang (scripts/mem0-http-contrat/rang.json, spec S-10 de mem0-rs-noyau)
// ---------------------------------------------------------------------------

export type RequeteRang = {
  cle: string;
  query: string;
  limit: number;
  threshold: number | null;
  /** Clés du corpus rendues par le Python, dans l'ordre (écrit par la capture). */
  attendu?: string[];
};

/** Arête rapportée aux clés du corpus, `a < b`. */
export type AreteRang = { a: string; b: string; score: number };

export type GrapheRang = { total: number; threshold: number; top_k: number; aretes: AreteRang[] };

export type FixtureRang = {
  format: 1;
  source?: { mem0ai: string; fastembed: string; qdrant: string; capture: string };
  agent_id: string;
  corpus: { cle: string; texte: string }[];
  requetes: RequeteRang[];
  seuil_avant_fusion: { requete: string; cle: string };
  /** Écrit par la capture. */
  graphe?: GrapheRang;
};

const estObjetJson = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const estChaine = (v: unknown): v is string => typeof v === "string" && v !== "";
const estEntierPositif = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/**
 * Valide la STRUCTURE d'une fixture de rang (la couverture est l'affaire de la
 * capture) ; lève une Error dont le message est la raison du refus.
 */
export function analyserFixtureRang(texte: string): FixtureRang {
  const f: unknown = JSON.parse(texte);
  if (!estObjetJson(f)) throw new Error("objet JSON attendu");
  if (f.format !== 1) throw new Error(`format attendu 1, reçu ${JSON.stringify(f.format)}`);
  if (!estChaine(f.agent_id)) throw new Error("agent_id : chaîne non vide attendue");
  if (
    !Array.isArray(f.corpus) ||
    !f.corpus.every((s) => estObjetJson(s) && estChaine(s.cle) && typeof s.texte === "string")
  ) {
    throw new Error("corpus : liste de {cle, texte} attendue");
  }
  if (
    !Array.isArray(f.requetes) ||
    !f.requetes.every(
      (q) =>
        estObjetJson(q) &&
        estChaine(q.cle) &&
        estChaine(q.query) &&
        estEntierPositif(q.limit) &&
        (q.threshold === null || typeof q.threshold === "number") &&
        (q.attendu === undefined || (Array.isArray(q.attendu) && q.attendu.every(estChaine))),
    )
  ) {
    throw new Error("requetes : liste de {cle, query, limit, threshold, attendu?} attendue");
  }
  const seuil = f.seuil_avant_fusion;
  if (!estObjetJson(seuil) || !estChaine(seuil.requete) || !estChaine(seuil.cle)) {
    throw new Error("seuil_avant_fusion : {requete, cle} attendu");
  }
  const g = f.graphe;
  if (
    g !== undefined &&
    !(
      estObjetJson(g) &&
      estEntierPositif(g.total) &&
      typeof g.threshold === "number" &&
      estEntierPositif(g.top_k) &&
      Array.isArray(g.aretes) &&
      g.aretes.every((a) => estObjetJson(a) && estChaine(a.a) && estChaine(a.b) && typeof a.score === "number")
    )
  ) {
    throw new Error("graphe : {total, threshold, top_k, aretes: [{a, b, score}]} attendu");
  }
  return f as FixtureRang;
}

/**
 * Corps de `POST /memory/search` d'une requête de la fixture — le même à la
 * capture et au contrôle. `complete` : sans limite utile (taille du corpus) et à
 * threshold 0, la liste complète des candidats.
 */
export function corpsRechercheRang(f: FixtureRang, q: RequeteRang, complete = false): Record<string, unknown> {
  return {
    query: q.query,
    agent_id: f.agent_id,
    limit: complete ? f.corpus.length : q.limit,
    threshold: complete ? 0 : q.threshold,
    explain: true,
  };
}

/** Arêtes du serveur rapportées aux clés du corpus (`a < b`), triées par (`a`, `b`) : la forme de `graphe.aretes`. */
export function aretesParCles(
  edges: readonly { source: string; target: string; score: number }[],
  cleDe: (id: string) => string,
): AreteRang[] {
  return edges
    .map((e) => {
      const [a, b] = [cleDe(e.source), cleDe(e.target)].sort();
      return { a, b, score: e.score };
    })
    .sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : x.b > y.b ? 1 : 0) : x.a < y.a ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Catalogue des formes (S-5)
// ---------------------------------------------------------------------------

const S: Forme = { type: "string" };
const N: Forme = { type: "number" };
const I: Forme = { type: "integer" };
const B: Forme = { type: "boolean" };
const Nul: Forme = { type: "null" };
const C = (valeur: string | number | boolean | null): Forme => ({ type: "const", valeur });
const F = (format: "uuid" | "date-iso" | "md5"): Forme => ({ type: "format", format });
const objet = (cles: Record<string, Forme>): Forme => ({ type: "objet", cles });
const tableau = (element: Forme): Forme => ({ type: "tableau", element });

export const SANTE: Forme = objet({
  ok: C(true),
  mem0: S,
  user: C("moi"),
  dream: objet({
    enabled: B,
    chat: S,
    last_run_at: { type: "ou", formes: [Nul, S] },
    last_error: { type: "ou", formes: [Nul, S] },
  }),
});

export const AJOUT: Forme = objet({
  results: tableau(objet({ id: F("uuid"), memory: S, event: C("ADD"), actor_id: Nul, role: C("user") })),
});

export const AJOUT_INFER: Forme = objet({
  results: tableau(objet({ id: F("uuid"), memory: S, event: C("ADD") })),
});

const CLES_SOUVENIR_INFER: Record<string, Forme> = {
  id: F("uuid"),
  memory: S,
  hash: F("md5"),
  metadata: { type: "ou", formes: [Nul, objet({ tags: S })] },
  created_at: F("date-iso"),
  updated_at: F("date-iso"),
  user_id: C("moi"),
  agent_id: S,
};
const CLES_SOUVENIR: Record<string, Forme> = { ...CLES_SOUVENIR_INFER, role: C("user") };

export const SOUVENIR: Forme = objet(CLES_SOUVENIR);
export const SOUVENIR_INFER: Forme = objet(CLES_SOUVENIR_INFER);
export const SOUVENIR_INFER_ATTRIBUE: Forme = objet({ ...CLES_SOUVENIR_INFER, attributed_to: S });

export const DETAILS: Forme = objet({
  semantic_score: N,
  bm25_score: N,
  entity_boost: N,
  raw_score: N,
  max_possible_score: N,
  final_score: N,
  threshold: N,
});

export const RECHERCHE: Forme = objet({ results: tableau(objet({ ...CLES_SOUVENIR, score: N })) });
export const RECHERCHE_EXPLIQUEE: Forme = objet({
  results: tableau(objet({ ...CLES_SOUVENIR, score: N, score_details: DETAILS })),
});

export const LISTE: Forme = objet({ total: I, results: tableau(SOUVENIR) });
export const LISTE_INFER: Forme = objet({
  total: I,
  results: tableau({ type: "ou", formes: [SOUVENIR_INFER, SOUVENIR_INFER_ATTRIBUE] }),
});

export const GRAPHE: Forme = objet({
  total: I,
  threshold: N,
  top_k: I,
  edges: tableau(objet({ source: F("uuid"), target: F("uuid"), score: N })),
});

export const MAJ: Forme = objet({ message: C("Memory updated successfully!") });
export const SUPPRESSION: Forme = objet({ message: C("Memory deleted successfully!") });

export const HISTORIQUE: Forme = tableau(
  objet({
    id: F("uuid"),
    memory_id: F("uuid"),
    old_memory: { type: "ou", formes: [Nul, S] },
    new_memory: { type: "ou", formes: [Nul, S] },
    event: S,
    created_at: F("date-iso"),
    updated_at: F("date-iso"),
    is_deleted: B,
    actor_id: Nul,
    role: C("user"),
  }),
);

export const HISTORIQUE_INFER: Forme = tableau(
  objet({
    id: F("uuid"),
    memory_id: F("uuid"),
    old_memory: Nul,
    new_memory: S,
    event: C("ADD"),
    created_at: F("date-iso"),
    updated_at: Nul,
    is_deleted: C(false),
    actor_id: Nul,
    role: Nul,
  }),
);

// ---------------------------------------------------------------------------
// Groupes et phases
// ---------------------------------------------------------------------------

/** Pause entre écritures, pour qu'aucun ordre ne dépende d'une égalité à la seconde (DATETIME). */
const PAUSE_HORODATAGE_MS = 1100;

/** Corps déjà vérifiés contre leur forme : ces vues typées ne font que les lire. */
type Ajout = { results: { id: string; memory: string }[] };
type Souvenir = {
  id: string;
  memory: string;
  hash: string;
  metadata: { tags: string } | null;
  created_at: string;
  updated_at: string;
  agent_id: string;
  role?: string;
  attributed_to?: string;
  score?: number;
  score_details?: { semantic_score: number; threshold: number };
};
type Liste = { total: number; results: Souvenir[] };
type Resultats = { results: Souvenir[] };
type Details = { semantic_score: number; bm25_score: number; max_possible_score: number; threshold: number };
export type LigneExpliquee = Souvenir & { score: number; score_details: Details };
type ResultatsExpliques = { results: LigneExpliquee[] };
type Graphe = {
  total: number;
  threshold: number;
  top_k: number;
  edges: { source: string; target: string; score: number }[];
};
type Historique = {
  memory_id: string;
  old_memory: string | null;
  new_memory: string | null;
  event: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
}[];

/** Cosinus de deux plongements du faux OpenAI (déjà normalisés en L2). */
function cosinus(a: string, b: string): number {
  const va = plonger(a);
  const vb = plonger(b);
  let produit = 0;
  for (let i = 0; i < va.length; i++) produit += va[i] * vb[i];
  return produit;
}

const arrondi = (x: number): string => x.toFixed(4);
const json = (v: unknown): string => JSON.stringify(v);

/** POST /memory/add infer=false d'un seul texte ; rend l'id du souvenir créé. */
async function ajouter(ctx: Contexte, agent: string, texte: string, tags?: string): Promise<string> {
  const corps: Record<string, unknown> = { text: texte, agent_id: agent, infer: false };
  if (tags !== undefined) corps.tags = tags;
  const r = (await ctx.appeler({ methode: "POST", gabarit: "/memory/add", corps, forme: AJOUT })) as Ajout;
  if (r.results.length !== 1) {
    throw new EchecCas([`POST /memory/add : 1 résultat attendu pour « ${texte} », reçu ${r.results.length}`]);
  }
  ctx.constater(
    r.results[0].memory === texte,
    `POST /memory/add : memory attendu ${json(texte)}, reçu ${json(r.results[0].memory)}`,
  );
  return r.results[0].id;
}

async function lister(ctx: Contexte, agent: string, forme: Forme = LISTE): Promise<Liste> {
  return (await ctx.appeler({
    methode: "GET",
    gabarit: "/memory/all",
    chemin: `/memory/all?agent_id=${encodeURIComponent(agent)}`,
    forme,
  })) as Liste;
}

async function chercher(ctx: Contexte, corps: Record<string, unknown>, forme: Forme): Promise<Resultats> {
  return (await ctx.appeler({ methode: "POST", gabarit: "/memory/search", corps, forme })) as Resultats;
}

async function modifier(ctx: Contexte, id: string, corps: Record<string, unknown>): Promise<void> {
  await ctx.appeler({ methode: "PUT", gabarit: "/memory/{id}", chemin: `/memory/${id}`, corps, forme: MAJ });
}

async function chercherExplique(ctx: Contexte, corps: Record<string, unknown>): Promise<ResultatsExpliques> {
  return (await ctx.appeler({
    methode: "POST",
    gabarit: "/memory/search",
    corps,
    forme: RECHERCHE_EXPLIQUEE,
  })) as ResultatsExpliques;
}

async function lireHistorique(ctx: Contexte, id: string): Promise<Historique> {
  return (await ctx.appeler({
    methode: "GET",
    gabarit: "/memory/{id}/history",
    chemin: `/memory/${id}/history`,
    forme: HISTORIQUE,
  })) as Historique;
}

const md5 = (texte: string): string => createHash("md5").update(texte, "utf8").digest("hex");

/** Le souvenir d'id donné dans une liste de résultats, ou un écart consigné. */
function trouver(
  ctx: Contexte,
  route: string,
  resultats: readonly Souvenir[],
  id: string,
  nom: string,
): Souvenir | null {
  const s = resultats.find((r) => r.id === id) ?? null;
  ctx.constater(s !== null, `${route} : ${nom} (${id}) absent des résultats`);
  return s;
}

function exigerMetadata(ctx: Contexte, route: string, s: Souvenir | null, nom: string, attendu: unknown): void {
  if (s === null) return;
  ctx.constater(
    isDeepStrictEqual(s.metadata, attendu),
    `${route} : metadata de ${nom} attendu ${json(attendu)}, reçu ${json(s.metadata)}`,
  );
}

const SANTE_OUVERT: Groupe = {
  nom: "santé",
  cas: () => [
    {
      libelle: "AC-1 · GET /health répond sans jeton",
      executer: async (ctx) => {
        await ctx.appeler({ methode: "GET", gabarit: "/health", jeton: null, forme: SANTE });
      },
    },
  ],
};

// Graphe : H partage ses 4 mots avec chaque Lᵢ (cos 0.8165), les Lᵢ entre elles
// 4 mots sur 6 (cos 0.6667, sous le seuil 0.75). H a donc 9 voisins > top_k=8.
const GRAPHE_H = "graphe noeud arête voisin";
const GRAPHE_PAIRES: readonly (readonly [string, string])[] = [
  ["pomme", "poire"],
  ["prune", "cerise"],
  ["figue", "datte"],
  ["mangue", "papaye"],
  ["kiwi", "melon"],
  ["citron", "orange"],
  ["banane", "ananas"],
  ["litchi", "goyave"],
  ["grenade", "abricot"],
];
const GRAPHE_L = GRAPHE_PAIRES.map(([a, b]) => `${GRAPHE_H} ${a} ${b}`);

const GRAPHE_OUVERT: Groupe = {
  nom: "graphe",
  cas: () => {
    const agent = "contrat-graphe";
    let idH = "";
    const idsL: string[] = [];
    return [
      {
        libelle: "AC-11 · précondition du corpus (faux embedder)",
        executer: async (ctx) => {
          for (const [i, l] of GRAPHE_L.entries()) {
            const c = cosinus(GRAPHE_H, l);
            ctx.constater(c >= 0.8, `corpus graphe : cos(H, L${i + 1}) = ${arrondi(c)} < 0.80`);
          }
          for (let i = 0; i < GRAPHE_L.length; i++) {
            for (let j = i + 1; j < GRAPHE_L.length; j++) {
              const c = cosinus(GRAPHE_L[i], GRAPHE_L[j]);
              ctx.constater(c <= 0.7, `corpus graphe : cos(L${i + 1}, L${j + 1}) = ${arrondi(c)} > 0.70`);
            }
          }
        },
      },
      {
        libelle: "AC-11 · 10 souvenirs ajoutés (infer=false)",
        executer: async (ctx) => {
          idH = await ajouter(ctx, agent, GRAPHE_H);
          for (const l of GRAPHE_L) idsL.push(await ajouter(ctx, agent, l));
        },
      },
      {
        libelle: "AC-11 · GET /memory/graph rend les constantes du serveur et l'union des voisinages",
        executer: async (ctx) => {
          const route = "GET /memory/graph";
          const g = (await ctx.appeler({ methode: "GET", gabarit: "/memory/graph", forme: GRAPHE })) as Graphe;
          ctx.constater(g.total === 10, `${route} : total attendu 10, reçu ${g.total}`);
          ctx.constater(g.threshold === 0.75, `${route} : threshold attendu 0.75, reçu ${g.threshold}`);
          ctx.constater(g.top_k === 8, `${route} : top_k attendu 8, reçu ${g.top_k}`);
          ctx.constater(
            g.edges.length === 9,
            `${route} : 9 arêtes attendues (H relié à chaque Lᵢ), reçu ${g.edges.length}`,
          );
          const relies = new Set<string>();
          for (const [i, e] of g.edges.entries()) {
            const lieu = `edges[${i}] (${e.source} → ${e.target})`;
            const autre = e.source === idH ? e.target : e.target === idH ? e.source : null;
            if (autre === null) {
              const entreL = idsL.includes(e.source) && idsL.includes(e.target);
              ctx.constater(false, `${route} : ${lieu} ${entreL ? "relie deux Lᵢ" : "ne touche pas H"}`);
            } else {
              ctx.constater(idsL.includes(autre), `${route} : ${lieu} relie H à un souvenir hors des Lᵢ`);
              relies.add(autre);
            }
            ctx.constater(e.source < e.target, `${route} : ${lieu} n'a pas source < target`);
            ctx.constater(
              e.score >= g.threshold,
              `${route} : ${lieu} a un score ${e.score} sous threshold ${g.threshold}`,
            );
            const suivante = g.edges[i + 1];
            if (suivante !== undefined) {
              const ordonnee =
                e.score > suivante.score ||
                (e.score === suivante.score &&
                  (e.source < suivante.source || (e.source === suivante.source && e.target <= suivante.target)));
              ctx.constater(
                ordonnee,
                `${route} : edges[${i}] et edges[${i + 1}] ne sont pas triées par (score décroissant, source, target)`,
              );
            }
          }
          ctx.constater(
            relies.size === 9,
            `${route} : H relié à ${relies.size} Lᵢ distinctes, 9 attendues (degré > top_k)`,
          );
        },
      },
    ];
  },
};

const PROCEDURE_OUVERT: Groupe = {
  nom: "procédure",
  cas: () => [
    {
      libelle: "AC-1 · POST /memory/add_procedure conserve les étapes mot pour mot",
      executer: async (ctx) => {
        const agent = "contrat-procedure";
        const steps = "1. Préparer l'environnement\n2. Lancer le contrat";
        const r = (await ctx.appeler({
          methode: "POST",
          gabarit: "/memory/add_procedure",
          corps: { steps, agent_id: agent },
          forme: AJOUT,
        })) as Ajout;
        ctx.constater(
          r.results[0]?.memory === steps,
          `POST /memory/add_procedure : results[0].memory attendu ${json(steps)}, reçu ${json(r.results[0]?.memory)}`,
        );
        const liste = await lister(ctx, agent);
        ctx.constater(liste.total === 1, `GET /memory/all : total attendu 1, reçu ${liste.total}`);
        ctx.constater(
          liste.results[0]?.memory === steps,
          `GET /memory/all : results[0].memory attendu ${json(steps)}, reçu ${json(liste.results[0]?.memory)}`,
        );
      },
    },
  ],
};

const TAGS_OUVERT: Groupe = {
  nom: "tags",
  cas: () => {
    const agent = "contrat-tags";
    let e1 = "";
    let e2 = "";
    /** all, puis E1 doit porter ce texte et ces metadata. */
    const relireE1 = async (ctx: Contexte, memoire: string, metadata: unknown): Promise<void> => {
      const route = "GET /memory/all";
      const s = trouver(ctx, route, (await lister(ctx, agent)).results, e1, "E1");
      if (s === null) return;
      ctx.constater(s.memory === memoire, `${route} : memory de E1 attendu ${json(memoire)}, reçu ${json(s.memory)}`);
      exigerMetadata(ctx, route, s, "E1", metadata);
    };
    return [
      {
        libelle: "AC-7 · ajout avec et sans tags",
        executer: async (ctx) => {
          e1 = await ajouter(ctx, agent, "Souvenir étiqueté", "alpha,beta");
          e2 = await ajouter(ctx, agent, "Souvenir sans étiquette");
        },
      },
      {
        libelle: "AC-7 · tags restitués par search",
        executer: async (ctx) => {
          const route = "POST /memory/search";
          const r = await chercher(ctx, { query: "Souvenir étiqueté", agent_id: agent }, RECHERCHE);
          exigerMetadata(ctx, route, trouver(ctx, route, r.results, e1, "E1"), "E1", { tags: "alpha,beta" });
          exigerMetadata(ctx, route, trouver(ctx, route, r.results, e2, "E2"), "E2", null);
        },
      },
      {
        libelle: "AC-7 · tags restitués par all",
        executer: async (ctx) => {
          const route = "GET /memory/all";
          const r = await lister(ctx, agent);
          exigerMetadata(ctx, route, trouver(ctx, route, r.results, e1, "E1"), "E1", { tags: "alpha,beta" });
          exigerMetadata(ctx, route, trouver(ctx, route, r.results, e2, "E2"), "E2", null);
        },
      },
      {
        libelle: "AC-7 · PUT avec tags remplace les tags",
        executer: async (ctx) => {
          await modifier(ctx, e1, { text: "Souvenir étiqueté v2", tags: "gamma" });
          await relireE1(ctx, "Souvenir étiqueté v2", { tags: "gamma" });
        },
      },
      {
        libelle: "AC-7 · PUT sans tags conserve les tags",
        executer: async (ctx) => {
          await modifier(ctx, e1, { text: "Souvenir étiqueté v3" });
          await relireE1(ctx, "Souvenir étiqueté v3", { tags: "gamma" });
        },
      },
    ];
  },
};

const HISTORIQUE_OUVERT: Groupe = {
  nom: "historique",
  cas: () => {
    let id = "";
    return [
      {
        libelle: "AC-8 · ajout puis PUT",
        executer: async (ctx) => {
          id = await ajouter(ctx, "contrat-historique", "Historique version 1");
          await pause(PAUSE_HORODATAGE_MS);
          await modifier(ctx, id, { text: "Historique version 2" });
        },
      },
      {
        libelle: "AC-8 · GET /memory/{id}/history rend ADD puis UPDATE",
        executer: async (ctx) => {
          const route = "GET /memory/{id}/history";
          const h = (await ctx.appeler({
            methode: "GET",
            gabarit: "/memory/{id}/history",
            chemin: `/memory/${id}/history`,
            forme: HISTORIQUE,
          })) as Historique;
          if (h.length !== 2) throw new EchecCas([`${route} : 2 entrées attendues, reçu ${h.length}`]);
          const attendus = [
            { memory_id: id, old_memory: null, new_memory: "Historique version 1", event: "ADD", is_deleted: false },
            {
              memory_id: id,
              old_memory: "Historique version 1",
              new_memory: "Historique version 2",
              event: "UPDATE",
              is_deleted: false,
            },
          ];
          for (const [i, attendu] of attendus.entries()) {
            const entree: Record<string, unknown> = h[i];
            for (const [cle, valeur] of Object.entries(attendu)) {
              ctx.constater(
                entree[cle] === valeur,
                `${route} : [${i}].${cle} attendu ${json(valeur)}, reçu ${json(entree[cle])}`,
              );
            }
          }
          ctx.constater(
            h[1].created_at === h[0].created_at,
            `${route} : [1].created_at (${h[1].created_at}) diffère de [0].created_at (${h[0].created_at})`,
          );
          ctx.constater(
            Date.parse(h[1].updated_at) > Date.parse(h[0].updated_at),
            `${route} : [1].updated_at (${h[1].updated_at}) n'est pas postérieur à [0].updated_at (${h[0].updated_at})`,
          );
        },
      },
    ];
  },
};

const LISTE_OUVERT: Groupe = {
  nom: "liste",
  cas: () => {
    const agent = "contrat-liste";
    const ids: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };
    return [
      {
        libelle: "AC-10 · trois ajouts puis PUT du plus ancien",
        executer: async (ctx) => {
          ids.A = await ajouter(ctx, agent, "Liste premier souvenir");
          await pause(PAUSE_HORODATAGE_MS);
          ids.B = await ajouter(ctx, agent, "Liste deuxième souvenir");
          await pause(PAUSE_HORODATAGE_MS);
          ids.C = await ajouter(ctx, agent, "Liste troisième souvenir");
          await pause(PAUSE_HORODATAGE_MS);
          await modifier(ctx, ids.A, { text: "Liste premier souvenir modifié" });
        },
      },
      {
        libelle: "AC-10 · GET /memory/all trie par updated_at décroissant, total = résultats",
        executer: async (ctx) => {
          const route = "GET /memory/all";
          const r = await lister(ctx, agent);
          const nom = (id: string): string => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
          const ordre = r.results.map((s) => nom(s.id));
          ctx.constater(
            isDeepStrictEqual(ordre, ["A", "C", "B"]),
            `${route} : ordre attendu [A, C, B], reçu [${ordre.join(", ")}]`,
          );
          ctx.constater(
            r.total === 3 && r.results.length === 3,
            `${route} : total (${r.total}) et nombre de résultats (${r.results.length}) attendus égaux à 3`,
          );
          for (let i = 0; i + 1 < r.results.length; i++) {
            const [a, b] = [r.results[i].updated_at, r.results[i + 1].updated_at];
            ctx.constater(
              Date.parse(a) >= Date.parse(b),
              `${route} : results[${i}].updated_at (${a}) antérieur à results[${i + 1}].updated_at (${b})`,
            );
          }
        },
      },
    ];
  },
};

// Recherche : V est sémantiquement proche de Qt, T et D en sont loin ; pour Qh,
// le dense seul classerait D devant T, seul le BM25 (jeton `embedding_dims`)
// remet T en tête.
const RECHERCHE_T = "Constante EMBEDDING_DIMS du serveur";
const RECHERCHE_D = "Embedding : dims et taille";
const RECHERCHE_V = "Les vecteurs du serveur ont une taille fixe";
const RECHERCHE_QT = "vecteurs serveur taille";
const RECHERCHE_QH = "EMBEDDING_DIMS";

const RECHERCHE_OUVERT: Groupe = {
  nom: "recherche",
  cas: () => {
    const agent = "contrat-recherche";
    const ids: Record<"T" | "D" | "V", string> = { T: "", D: "", V: "" };
    const route = "POST /memory/search";
    /** Présence (true) ou absence (false) attendue de chaque souvenir nommé. */
    const exigerPresence = (ctx: Contexte, r: Resultats, attendu: Record<"T" | "D" | "V", boolean>): void => {
      for (const nom of ["T", "D", "V"] as const) {
        const trouve = r.results.some((s) => s.id === ids[nom]);
        ctx.constater(
          trouve === attendu[nom],
          `${route} : ${nom} (${ids[nom]}) ${attendu[nom] ? "absent des" : "présent dans les"} résultats`,
        );
      }
    };
    return [
      {
        libelle: "AC-12 · précondition du corpus (faux embedder)",
        executer: async (ctx) => {
          const qtV = cosinus(RECHERCHE_QT, RECHERCHE_V);
          const qtT = cosinus(RECHERCHE_QT, RECHERCHE_T);
          const qtD = cosinus(RECHERCHE_QT, RECHERCHE_D);
          const qhD = cosinus(RECHERCHE_QH, RECHERCHE_D);
          const qhT = cosinus(RECHERCHE_QH, RECHERCHE_T);
          ctx.constater(qtV >= 0.55, `corpus recherche : cos(Qt, V) = ${arrondi(qtV)} < 0.55`);
          ctx.constater(qtT <= 0.45, `corpus recherche : cos(Qt, T) = ${arrondi(qtT)} > 0.45`);
          ctx.constater(qtD <= 0.45, `corpus recherche : cos(Qt, D) = ${arrondi(qtD)} > 0.45`);
          ctx.constater(qhD > qhT, `corpus recherche : cos(Qh, D) = ${arrondi(qhD)} ≤ cos(Qh, T) = ${arrondi(qhT)}`);
          ctx.constater(qhT >= 0.2, `corpus recherche : cos(Qh, T) = ${arrondi(qhT)} < 0.2`);
        },
      },
      {
        libelle: "AC-12 · trois souvenirs ajoutés",
        executer: async (ctx) => {
          ids.T = await ajouter(ctx, agent, RECHERCHE_T);
          ids.D = await ajouter(ctx, agent, RECHERCHE_D);
          ids.V = await ajouter(ctx, agent, RECHERCHE_V);
        },
      },
      {
        libelle: "AC-12 · threshold filtre sur score_details.semantic_score",
        executer: async (ctx) => {
          const r = await chercher(
            ctx,
            { query: RECHERCHE_QT, agent_id: agent, threshold: 0.5, explain: true },
            RECHERCHE_EXPLIQUEE,
          );
          exigerPresence(ctx, r, { V: true, T: false, D: false });
          for (const [i, s] of r.results.entries()) {
            // score et score_details sont garantis par la forme RECHERCHE_EXPLIQUEE.
            const d = s.score_details ?? { semantic_score: Number.NaN, threshold: Number.NaN };
            ctx.constater(
              d.semantic_score >= 0.5,
              `${route} : results[${i}].score_details.semantic_score ${d.semantic_score} sous le seuil 0.5`,
            );
            ctx.constater(
              d.threshold === 0.5,
              `${route} : results[${i}].score_details.threshold attendu 0.5, reçu ${d.threshold}`,
            );
            const suivant = r.results[i + 1];
            if (suivant !== undefined) {
              ctx.constater(
                (s.score ?? 0) >= (suivant.score ?? 0),
                `${route} : results[${i}].score (${s.score}) < results[${i + 1}].score (${suivant.score})`,
              );
            }
          }
        },
      },
      {
        libelle: "AC-12 · sans threshold, les souvenirs sous 0.5 reviennent",
        executer: async (ctx) => {
          const r = await chercher(ctx, { query: RECHERCHE_QT, agent_id: agent, explain: true }, RECHERCHE_EXPLIQUEE);
          exigerPresence(ctx, r, { V: true, T: true, D: true });
        },
      },
      {
        libelle: "AC-12 · sans explain, score_details est absent",
        executer: async (ctx) => {
          // Le jeu de clés exact de RECHERCHE interdit score_details.
          await chercher(ctx, { query: RECHERCHE_QT, agent_id: agent, threshold: 0.5 }, RECHERCHE);
        },
      },
      {
        libelle: "AC-13 · « EMBEDDING_DIMS » sort la cible en rang 1",
        executer: async (ctx) => {
          const r = await chercher(ctx, { query: RECHERCHE_QH, agent_id: agent }, RECHERCHE);
          const premier = r.results[0]?.id;
          const nom = (["T", "D", "V"] as const).find((n) => ids[n] === premier) ?? String(premier);
          ctx.constater(premier === ids.T, `${route} : rang 1 attendu T (${ids.T}), reçu ${nom}`);
        },
      },
    ];
  },
};

const SUPPRESSION_OUVERT: Groupe = {
  nom: "suppression",
  cas: () => [
    {
      libelle: "AC-1 · DELETE d'un souvenir existant",
      executer: async (ctx) => {
        const agent = "contrat-suppression";
        const id = await ajouter(ctx, agent, "Souvenir à supprimer");
        await ctx.appeler({ methode: "DELETE", gabarit: "/memory/{id}", chemin: `/memory/${id}`, forme: SUPPRESSION });
        const liste = await lister(ctx, agent);
        ctx.constater(liste.total === 0, `GET /memory/all : total attendu 0 après DELETE, reçu ${liste.total}`);
      },
    },
    {
      libelle: "AC-9 · DELETE d'un id inconnu rend 500",
      executer: async (ctx) => {
        await ctx.appeler({
          methode: "DELETE",
          gabarit: "/memory/{id}",
          chemin: `/memory/${randomUUID()}`,
          statut: 500,
        });
      },
    },
  ],
};

// Groupe infer (mem0-rs-extraction-llm S-7) : chemin additif de mem0 2.2.1, joué
// contre le Python et contre mem0-rs ; la requête chat reçue par le faux OpenAI
// est comparée à l'invite attendue, seules les dates normalisées.

/** `ADDITIVE_EXTRACTION_PROMPT` de mem0 2.2.1 (SP/mem0/configs/prompts.py:468-944). */
const SYSTEME_EXTRACTION = {
  sha256: "ad19187a37813ef77ee156e714c0650e6ec749e0264bdc07d499bc9b24115155",
  octets: 33831,
} as const;

/** `CUSTOM_INSTRUCTIONS` de l'ancien mem0-http Python, octet pour octet. */
const CONSIGNES_EXTRACTION =
  "Contexte : session de développement logiciel, pas conversation personnelle. " +
  "N'extrais QUE : stack et choix techniques, décisions d'architecture avec leur raison, " +
  "conventions du dépôt, bugs résolus (symptôme + cause racine + correctif), exigences " +
  "non négociables d'une feature. N'extrais RIEN d'autre : ni préférences personnelles, " +
  "ni expériences, ni recommandations de l'assistant, ni état courant du code. " +
  "Une liste vide est un résultat normal et fréquent. " +
  "Rédige dans la langue de la conversation, en nommant fichiers, modules et symboles.";

const FAITS_DEUX = ["Le dépôt cible bash 3.2", "La CI tourne sur ubuntu-latest"];

/** Liste d'un scope qui mêle un souvenir direct (infer=false, `role`) et des souvenirs extraits. */
const LISTE_MIXTE: Forme = objet({
  total: I,
  results: tableau({ type: "ou", formes: [SOUVENIR, SOUVENIR_INFER, SOUVENIR_INFER_ATTRIBUE] }),
});

const CHAT = "POST /v1/chat/completions (faux OpenAI)";
const EMBEDDINGS = "POST /v1/embeddings (faux OpenAI)";

type AttenduChat = { texte: string; derniers: readonly string[]; existants: readonly string[] };

/**
 * Écarts entre une requête chat reçue et celle de mem0 2.2.1 (S-7, conditions 1
 * à 7) : en-tête, 6 clés exactes, paramètres, messages system + user, empreinte
 * du prompt système et invite user exacte, dates normalisées en `<date>`.
 */
function exigerChat(ctx: Contexte, requete: RequeteChat, attendu: AttenduChat): void {
  const autorisation = `Bearer ${JETON_OPENAI}`;
  ctx.constater(
    requete.autorisation === autorisation,
    `${CHAT} : authorization attendu ${json(autorisation)}, reçu ${json(requete.autorisation)}`,
  );
  const corps = requete.corps;
  if (!estObjetJson(corps)) {
    ctx.constater(false, `${CHAT} : corps objet JSON attendu, reçu ${json(corps)}`);
    return;
  }
  const cles = Object.keys(corps).sort();
  const clesAttendues = ["max_tokens", "messages", "model", "response_format", "temperature", "top_p"];
  ctx.constater(
    isDeepStrictEqual(cles, clesAttendues),
    `${CHAT} : clés attendues ${json(clesAttendues)}, reçu ${json(cles)}`,
  );
  const parametres: [string, unknown][] = [
    ["model", MODELE_CHAT],
    ["max_tokens", 2000],
    ["temperature", 0.1],
    ["top_p", 0.1],
    ["response_format", { type: "json_object" }],
  ];
  for (const [cle, valeur] of parametres) {
    ctx.constater(
      isDeepStrictEqual(corps[cle], valeur),
      `${CHAT} : ${cle} attendu ${json(valeur)}, reçu ${json(corps[cle])}`,
    );
  }
  const messages = corps.messages;
  const conformes =
    Array.isArray(messages) &&
    messages.length === 2 &&
    messages.every((m) => estObjetJson(m) && isDeepStrictEqual(Object.keys(m).sort(), ["content", "role"])) &&
    messages[0].role === "system" &&
    messages[1].role === "user";
  if (!conformes) {
    ctx.constater(
      false,
      `${CHAT} : messages attendus [{role: system, content}, {role: user, content}], reçu ${json(messages)}`.slice(
        0,
        400,
      ),
    );
    return;
  }
  const [systeme, invite] = messages as { role: string; content: unknown }[];
  if (typeof systeme.content !== "string" || typeof invite.content !== "string") {
    ctx.constater(false, `${CHAT} : content chaîne attendu dans les deux messages`);
    return;
  }
  const empreinte = createHash("sha256").update(systeme.content, "utf8").digest("hex");
  const octets = Buffer.byteLength(systeme.content, "utf8");
  ctx.constater(
    empreinte === SYSTEME_EXTRACTION.sha256 && octets === SYSTEME_EXTRACTION.octets,
    `${CHAT} : prompt système attendu sha256 ${SYSTEME_EXTRACTION.sha256} (${SYSTEME_EXTRACTION.octets} octets), reçu ${empreinte} (${octets} octets)`,
  );

  const dates = [...invite.content.matchAll(/\n\n## Observation Date\n([^\n]*)\n\n## Current Date\n([^\n]*)\n\n/g)];
  if (dates.length !== 1) {
    ctx.constater(
      false,
      `${CHAT} : un seul bloc Observation Date / Current Date attendu dans l'invite, reçu ${dates.length}`,
    );
    return;
  }
  const [bloc, d1, d2] = dates[0];
  const veille = new Date(Date.parse(`${requete.jour}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  ctx.constater(
    d1 === d2 && /^\d{4}-\d{2}-\d{2}$/.test(d1) && (d1 === requete.jour || d1 === veille),
    `${CHAT} : dates d'observation et courante attendues égales, AAAA-MM-JJ, ${requete.jour} ou ${veille} ; reçu ${json(d1)} et ${json(d2)}`,
  );
  const recue = invite.content.replace(bloc, "\n\n## Observation Date\n<date>\n\n## Current Date\n<date>\n\n");
  const derniers = attendu.derniers.map((l) => `${l}\n`).join("");
  const existants =
    attendu.existants.length === 0
      ? "[]"
      : `[${attendu.existants.map((t, i) => `{"id": "${i}", "text": ${JSON.stringify(t)}}`).join(", ")}]`;
  const attendue =
    `## Summary\n\n\n## Last k Messages\n${derniers}\n\n## Recently Extracted Memories\n[]` +
    `\n\n## Existing Memories\n${existants}\n\n## New Messages\nuser: ${attendu.texte}\n` +
    `\n\n## Observation Date\n<date>\n\n## Current Date\n<date>` +
    `\n\n## Custom Instructions\n${CONSIGNES_EXTRACTION}\n\n# Output:`;
  if (recue !== attendue) {
    let i = 0;
    while (i < recue.length && i < attendue.length && recue[i] === attendue[i]) i++;
    ctx.constater(
      false,
      `${CHAT} : invite user différente à l'index ${i} — attendu ${json(attendue.slice(i, i + 80))}, reçu ${json(recue.slice(i, i + 80))}`,
    );
  }
}

/** Requêtes reçues par le faux OpenAI depuis la création de la mesure (début du cas). */
function mesurerOpenAI(ctx: Contexte): { chat(): RequeteChat[]; embeddings(): string[][] } {
  const n0 = ctx.requetesChat().length;
  const e0 = ctx.requetesEmbeddings().length;
  return {
    chat: () => ctx.requetesChat().slice(n0),
    embeddings: () =>
      ctx
        .requetesEmbeddings()
        .slice(e0)
        .map((r) => r.entrees),
  };
}

/** POST /memory/add infer=true ; rend le corps vérifié (200) ou `null` (statut d'erreur attendu). */
async function ajouterInfere(
  ctx: Contexte,
  agent: string,
  texte: string,
  options: { tags?: string; statut?: number } = {},
): Promise<Ajout | null> {
  const corps: Record<string, unknown> = { text: texte, agent_id: agent, infer: true };
  if (options.tags !== undefined) corps.tags = options.tags;
  return (await ctx.appeler({
    methode: "POST",
    gabarit: "/memory/add",
    corps,
    statut: options.statut,
    forme: AJOUT_INFER,
  })) as Ajout | null;
}

function exigerFaits(ctx: Contexte, r: Ajout | null, attendus: readonly string[]): void {
  const memoires = r?.results.map((x) => x.memory) ?? null;
  ctx.constater(
    isDeepStrictEqual(memoires, attendus),
    `POST /memory/add : faits extraits attendus ${json(attendus)}, reçu ${json(memoires)}`,
  );
}

function exigerNombre(ctx: Contexte, route: string, quoi: string, recu: number, attendu: number): void {
  ctx.constater(recu === attendu, `${route} : ${attendu} ${quoi} attendu(s), reçu ${recu}`);
}

const INFER_OUVERT: Groupe = {
  nom: "infer",
  infer: true,
  cas: () => {
    const agentDeux = "contrat-infer-deux";
    const T1 = "[script:deux-faits] Notes de la réunion d'équipe";
    // Requête chat de C1, examinée par C2.
    let chatC1: RequeteChat | null = null;
    return [
      {
        libelle: "mem0-rs-extraction-llm AC-1 · infer=true extrait les faits scriptés en un seul appel chat",
        executer: async (ctx) => {
          const m = mesurerOpenAI(ctx);
          exigerFaits(ctx, await ajouterInfere(ctx, agentDeux, T1, { tags: "contrat,infer" }), FAITS_DEUX);
          const chats = m.chat();
          exigerNombre(ctx, CHAT, "requête(s)", chats.length, 1);
          chatC1 = chats[0] ?? null;
          const embeddings = m.embeddings();
          const attendues = [[`user: ${T1} `], FAITS_DEUX];
          ctx.constater(
            isDeepStrictEqual(embeddings, attendues),
            `${EMBEDDINGS} : entrées attendues ${json(attendues)}, reçu ${json(embeddings)}`,
          );
        },
      },
      {
        libelle: "mem0-rs-extraction-llm AC-2 · requête chat identique : système, invite, modèle et paramètres",
        executer: async (ctx) => {
          if (chatC1 === null) {
            ctx.constater(false, `${CHAT} : requête chat de l'ajout nominal absente`);
            return;
          }
          exigerChat(ctx, chatC1, { texte: T1, derniers: [], existants: [] });
        },
      },
      {
        libelle: "mem0-rs-extraction-llm AC-1 · faits relus par all et par history, sans role",
        executer: async (ctx) => {
          const route = "GET /memory/all";
          const liste = await lister(ctx, agentDeux, LISTE_INFER);
          exigerNombre(ctx, route, "souvenir(s)", liste.total, 2);
          const memoires = liste.results.map((s) => s.memory).sort();
          ctx.constater(
            isDeepStrictEqual(memoires, [...FAITS_DEUX].sort()),
            `${route} : faits attendus ${json(FAITS_DEUX)} (sans ordre), reçu ${json(memoires)}`,
          );
          for (const s of liste.results) {
            const nom = `« ${s.memory} »`;
            if (s.memory === FAITS_DEUX[0]) {
              ctx.constater(
                s.attributed_to === "user",
                `${route} : ${nom} attributed_to attendu "user", reçu ${json(s.attributed_to)}`,
              );
            } else {
              ctx.constater(!("attributed_to" in s), `${route} : ${nom} ne doit pas porter attributed_to`);
            }
            exigerMetadata(ctx, route, s, nom, { tags: "contrat,infer" });
            ctx.constater(
              s.hash === md5(s.memory),
              `${route} : ${nom} hash attendu md5(memory) ${md5(s.memory)}, reçu ${s.hash}`,
            );
            ctx.constater(
              s.created_at === s.updated_at,
              `${route} : ${nom} created_at ${s.created_at} et updated_at ${s.updated_at} attendus égaux`,
            );
            const historique = "GET /memory/{id}/history";
            const h = (await ctx.appeler({
              methode: "GET",
              gabarit: historique,
              chemin: `/memory/${s.id}/history`,
              forme: HISTORIQUE_INFER,
            })) as Historique;
            exigerNombre(ctx, historique, `révision(s) de ${nom}`, h.length, 1);
            const ligne = h[0];
            if (ligne === undefined) continue;
            ctx.constater(
              ligne.memory_id === s.id,
              `${historique} : memory_id attendu ${s.id}, reçu ${ligne.memory_id}`,
            );
            ctx.constater(
              ligne.new_memory === s.memory,
              `${historique} : new_memory attendu ${json(s.memory)}, reçu ${json(ligne.new_memory)}`,
            );
            ctx.constater(
              ligne.created_at === s.created_at,
              `${historique} : created_at attendu celui du souvenir ${s.created_at}, reçu ${ligne.created_at}`,
            );
          }
        },
      },
      {
        libelle: "mem0-rs-extraction-llm AC-2 · second appel du scope : Last k Messages et Existing Memories",
        executer: async (ctx) => {
          const T2 = "[script:vide] Suite de la réunion\nsur deux lignes";
          const requete = `user: ${T2.replace(/\n/g, " ")} `;
          const cosinus0 = cosinus(requete, FAITS_DEUX[0]);
          const cosinus1 = cosinus(requete, FAITS_DEUX[1]);
          if (Math.abs(cosinus0 - cosinus1) < 1e-6) {
            ctx.constater(false, `précondition : cosinus de la requête avec les 2 faits égaux (${arrondi(cosinus0)})`);
            return;
          }
          const existants = cosinus0 > cosinus1 ? FAITS_DEUX : [FAITS_DEUX[1], FAITS_DEUX[0]];
          const m = mesurerOpenAI(ctx);
          exigerFaits(ctx, await ajouterInfere(ctx, agentDeux, T2), []);
          const chats = m.chat();
          exigerNombre(ctx, CHAT, "requête(s)", chats.length, 1);
          if (chats[0] !== undefined) exigerChat(ctx, chats[0], { texte: T2, derniers: [`user: ${T1}`], existants });
          const embeddings = m.embeddings();
          ctx.constater(
            isDeepStrictEqual(embeddings, [[requete]]),
            `${EMBEDDINGS} : entrées attendues ${json([[requete]])}, reçu ${json(embeddings)}`,
          );
          exigerNombre(ctx, "GET /memory/all", "souvenir(s)", (await lister(ctx, agentDeux, LISTE_INFER)).total, 2);
        },
      },
      {
        libelle: "mem0-rs-extraction-llm AC-3 · un fait identique à un souvenir existant n'est pas recréé",
        executer: async (ctx) => {
          const agent = "contrat-infer-doublon";
          const existant = FAITS_DEUX[0];
          await ajouter(ctx, agent, existant);
          const m = mesurerOpenAI(ctx);
          exigerFaits(ctx, await ajouterInfere(ctx, agent, "[script:doublon] Rappel des décisions"), [
            "Fait inédit du doublon",
          ]);
          const liste = await lister(ctx, agent, LISTE_MIXTE);
          exigerNombre(ctx, "GET /memory/all", "souvenir(s)", liste.total, 2);
          const copies = liste.results.filter((s) => s.memory === existant).length;
          exigerNombre(ctx, "GET /memory/all", `souvenir(s) « ${existant} »`, copies, 1);
          const chats = m.chat();
          exigerNombre(ctx, CHAT, "requête(s)", chats.length, 1);
          if (chats[0] !== undefined) {
            exigerChat(ctx, chats[0], {
              texte: "[script:doublon] Rappel des décisions",
              derniers: [],
              existants: [existant],
            });
          }
          const lot = m.embeddings()[1];
          const attendues = [existant, "Fait inédit du doublon"];
          ctx.constater(
            isDeepStrictEqual(lot, attendues),
            `${EMBEDDINGS} : 2e requête de l'ajout infer=true attendue ${json(attendues)}, reçu ${json(lot)}`,
          );
        },
      },
      {
        libelle: "mem0-rs-extraction-llm AC-3 · deux faits identiques dans la même réponse : un seul souvenir",
        executer: async (ctx) => {
          const agent = "contrat-infer-double";
          const m = mesurerOpenAI(ctx);
          exigerFaits(ctx, await ajouterInfere(ctx, agent, "[script:double-interne] Liste répétée"), [
            "Fait répété",
            "Fait unique",
          ]);
          exigerNombre(ctx, "GET /memory/all", "souvenir(s)", (await lister(ctx, agent, LISTE_INFER)).total, 2);
          const lot = m.embeddings()[1];
          const attendues = ["Fait répété", "Fait répété", "Fait unique"];
          ctx.constater(
            isDeepStrictEqual(lot, attendues),
            `${EMBEDDINGS} : 2e requête attendue ${json(attendues)}, reçu ${json(lot)}`,
          );
        },
      },
      {
        libelle: 'mem0-rs-extraction-llm AC-4 · réponse {"memory":[]} : 200, results vide, aucun souvenir',
        executer: async (ctx) => {
          const agent = "contrat-infer-vide";
          const m = mesurerOpenAI(ctx);
          exigerFaits(ctx, await ajouterInfere(ctx, agent, "[script:vide] Bavardage sans fait durable"), []);
          exigerNombre(ctx, CHAT, "requête(s)", m.chat().length, 1);
          exigerNombre(ctx, EMBEDDINGS, "requête(s)", m.embeddings().length, 1);
          exigerNombre(ctx, "GET /memory/all", "souvenir(s)", (await lister(ctx, agent, LISTE_INFER)).total, 0);
        },
      },
      {
        libelle:
          "mem0-rs-extraction-llm AC-5 · réponse non-JSON, sans clé memory ou sans text : 200, results vide, aucun souvenir",
        executer: async (ctx) => {
          for (const nom of ["non-json", "sans-memoire", "element-sans-texte"]) {
            const agent = `contrat-infer-${nom}`;
            exigerFaits(ctx, await ajouterInfere(ctx, agent, `[script:${nom}] Réponse dégradée`), []);
            exigerNombre(
              ctx,
              "GET /memory/all",
              `souvenir(s) (${nom})`,
              (await lister(ctx, agent, LISTE_INFER)).total,
              0,
            );
          }
        },
      },
      {
        libelle: "mem0-rs-extraction-llm AC-5 · memory qui n'est pas une liste : 500, aucun souvenir",
        executer: async (ctx) => {
          const agent = "contrat-infer-memoire-chaine";
          await ajouterInfere(ctx, agent, "[script:memoire-chaine] Réponse mal formée", { statut: 500 });
          exigerNombre(ctx, "GET /memory/all", "souvenir(s)", (await lister(ctx, agent, LISTE_INFER)).total, 0);
        },
      },
      {
        libelle: "mem0-rs-extraction-llm AC-6 · chat/completions en 500 : 500, trois essais, aucun souvenir",
        executer: async (ctx) => {
          const agent = "contrat-infer-erreur";
          const texte = "[script:erreur-500] LLM en panne";
          const m = mesurerOpenAI(ctx);
          await ajouterInfere(ctx, agent, texte, { statut: 500 });
          const chats = m.chat();
          exigerNombre(ctx, CHAT, "requête(s)", chats.length, 3);
          for (const requete of chats) exigerChat(ctx, requete, { texte, derniers: [], existants: [] });
          exigerNombre(ctx, EMBEDDINGS, "requête(s)", m.embeddings().length, 1);
          exigerNombre(ctx, "GET /memory/all", "souvenir(s)", (await lister(ctx, agent, LISTE_INFER)).total, 0);
        },
      },
      {
        libelle: "mem0-rs-extraction-llm AC-5 · seuls les appels rendus en 200 entrent dans Last k Messages",
        executer: async (ctx) => {
          const agent = "contrat-infer-suite";
          const A = `[script:non-json] ${"Premier message de la suite. ".repeat(12)}`;
          const D = "[script:vide] Quatrième message de la suite";
          const m = mesurerOpenAI(ctx);
          await ajouterInfere(ctx, agent, A);
          await ajouterInfere(ctx, agent, "[script:erreur-500] Deuxième message de la suite", { statut: 500 });
          await ajouterInfere(ctx, agent, "[script:memoire-chaine] Troisième message de la suite", { statut: 500 });
          await ajouterInfere(ctx, agent, D);
          const derniere = m.chat().at(-1);
          if (derniere === undefined) {
            ctx.constater(false, `${CHAT} : aucune requête chat reçue pour le quatrième message`);
          } else {
            exigerChat(ctx, derniere, { texte: D, derniers: [`user: ${A.slice(0, 300)}...`], existants: [] });
          }
          exigerNombre(ctx, "GET /memory/all", "souvenir(s)", (await lister(ctx, agent, LISTE_INFER)).total, 0);
        },
      },
      {
        libelle: "mem0-rs-extraction-llm AC-1 · réponse encadrée par des balises de code et think : fait extrait",
        executer: async (ctx) => {
          const agent = "contrat-infer-balises";
          exigerFaits(ctx, await ajouterInfere(ctx, agent, "[script:balises] Réponse encadrée"), ["Fait balisé"]);
          exigerNombre(ctx, "GET /memory/all", "souvenir(s)", (await lister(ctx, agent, LISTE_INFER)).total, 1);
        },
      },
    ];
  },
};

// Noyau (mem0-rs-noyau S-9) : hash, fusion du PUT, procédure octet pour octet et
// trace de la suppression, sous la forme du Python — joué contre les deux serveurs.

/** Le nombre de révisions, puis les champs nommés de chacune. */
function exigerRevisions(
  ctx: Contexte,
  route: string,
  h: Historique,
  attendus: readonly Record<string, unknown>[],
): void {
  ctx.constater(
    h.length === attendus.length,
    `${route} : ${attendus.length} révision(s) attendue(s), reçu ${h.length}`,
  );
  for (const [i, attendu] of attendus.entries()) {
    const entree: Record<string, unknown> | undefined = h[i];
    if (entree === undefined) return;
    for (const [cle, valeur] of Object.entries(attendu)) {
      ctx.constater(
        entree[cle] === valeur,
        `${route} : [${i}].${cle} attendu ${json(valeur)}, reçu ${json(entree[cle])}`,
      );
    }
  }
}

const NOYAU_OUVERT: Groupe = {
  nom: "noyau",
  cas: () => {
    const agent = "contrat-noyau";
    const tous = "GET /memory/all";
    const historique = "GET /memory/{id}/history";
    const recherche = "POST /memory/search";
    return [
      {
        libelle: "mem0-rs-noyau AC-4 · hash = md5 du texte et révision ADD",
        executer: async (ctx) => {
          const t = "Révision « AC-4 » : ligne 1\nligne 2 — fin";
          const id = await ajouter(ctx, agent, t);
          const s = trouver(ctx, tous, (await lister(ctx, agent)).results, id, "T");
          if (s !== null)
            ctx.constater(s.hash === md5(t), `${tous} : hash de T attendu ${md5(t)} (md5), reçu ${s.hash}`);
          exigerRevisions(ctx, historique, await lireHistorique(ctx, id), [
            { event: "ADD", old_memory: null, new_memory: t, is_deleted: false },
          ]);
        },
      },
      {
        libelle: "mem0-rs-noyau AC-5 · PUT fusionne, ré-embarque et historise",
        executer: async (ctx) => {
          const v1 = "pomme cerise abricot";
          const v2 = "voilier phare marée";
          const id = await ajouter(ctx, agent, v1, "alpha");
          const avant = trouver(ctx, tous, (await lister(ctx, agent)).results, id, "V1");
          if (avant === null) return;
          await pause(PAUSE_HORODATAGE_MS);
          await modifier(ctx, id, { text: v2, tags: "beta" });
          const apres = trouver(ctx, tous, (await lister(ctx, agent)).results, id, "V2");
          if (apres !== null) {
            ctx.constater(
              apres.agent_id === agent,
              `${tous} : agent_id de V2 attendu ${json(agent)}, reçu ${json(apres.agent_id)}`,
            );
            ctx.constater(apres.role === "user", `${tous} : role de V2 attendu "user", reçu ${json(apres.role)}`);
            exigerMetadata(ctx, tous, apres, "V2", { tags: "beta" });
            ctx.constater(
              apres.created_at === avant.created_at,
              `${tous} : created_at de V2 (${apres.created_at}) diffère de celui de V1 (${avant.created_at})`,
            );
            ctx.constater(
              Date.parse(apres.updated_at) > Date.parse(apres.created_at),
              `${tous} : updated_at de V2 (${apres.updated_at}) n'est pas postérieur à created_at (${apres.created_at})`,
            );
          }
          await modifier(ctx, id, { text: v2 });
          exigerMetadata(ctx, tous, trouver(ctx, tous, (await lister(ctx, agent)).results, id, "V2"), "V2", {
            tags: "beta",
          });
          const nouveau = (await chercherExplique(ctx, { query: v2, agent_id: agent, explain: true })).results.find(
            (r) => r.id === id,
          );
          ctx.constater(
            nouveau !== undefined && nouveau.score_details.semantic_score >= 0.999,
            `${recherche} : V2 (${id}) ${nouveau === undefined ? "absent" : `rendu avec semantic_score ${nouveau.score_details.semantic_score}`} pour son nouveau texte (≥ 0.999 attendu)`,
          );
          const ancien = await chercherExplique(ctx, { query: v1, agent_id: agent, threshold: 0.5, explain: true });
          ctx.constater(
            !ancien.results.some((r) => r.id === id),
            `${recherche} : V2 (${id}) rendu pour l'ancien texte V1 au threshold 0.5 (vecteur non ré-embarqué)`,
          );
          exigerRevisions(ctx, historique, await lireHistorique(ctx, id), [
            { event: "ADD", old_memory: null, new_memory: v1 },
            { event: "UPDATE", old_memory: v1, new_memory: v2 },
            { event: "UPDATE", old_memory: v2, new_memory: v2 },
          ]);
        },
      },
      {
        libelle: "mem0-rs-noyau AC-6 · add_procedure conserve le texte octet pour octet",
        executer: async (ctx) => {
          const steps = '# Procédure\r\n\n1. **Lancer** `cargo test`  \n\t- cas "limite" \\ fin 🚀\n';
          const r = (await ctx.appeler({
            methode: "POST",
            gabarit: "/memory/add_procedure",
            corps: { steps, agent_id: agent },
            forme: AJOUT,
          })) as Ajout;
          const ajoute = r.results[0];
          if (ajoute === undefined) throw new EchecCas(["POST /memory/add_procedure : aucun souvenir créé"]);
          ctx.constater(
            ajoute.memory === steps,
            `POST /memory/add_procedure : results[0].memory attendu ${json(steps)}, reçu ${json(ajoute.memory)}`,
          );
          const lignes: [string, Souvenir | undefined][] = [
            [tous, (await lister(ctx, agent)).results.find((s) => s.id === ajoute.id)],
            [
              recherche,
              (
                await chercherExplique(ctx, { query: "Procédure Lancer cargo test", agent_id: agent, explain: true })
              ).results.find((s) => s.id === ajoute.id),
            ],
          ];
          for (const [route, s] of lignes) {
            if (s === undefined) {
              ctx.constater(false, `${route} : procédure (${ajoute.id}) absente des résultats`);
              continue;
            }
            ctx.constater(s.memory === steps, `${route} : memory attendu ${json(steps)}, reçu ${json(s.memory)}`);
            ctx.constater(s.hash === md5(steps), `${route} : hash attendu ${md5(steps)} (md5), reçu ${s.hash}`);
          }
        },
      },
      {
        libelle: "mem0-rs-noyau AC-7 · DELETE retire de all et de search, history garde la trace",
        executer: async (ctx) => {
          const texte = "souvenir à supprimer zéphyr";
          const id = await ajouter(ctx, agent, texte);
          await ctx.appeler({
            methode: "DELETE",
            gabarit: "/memory/{id}",
            chemin: `/memory/${id}`,
            forme: SUPPRESSION,
          });
          ctx.constater(
            !(await lister(ctx, agent)).results.some((s) => s.id === id),
            `${tous} : souvenir supprimé (${id}) encore listé`,
          );
          const r = await chercherExplique(ctx, { query: texte, agent_id: agent, threshold: 0, explain: true });
          ctx.constater(!r.results.some((s) => s.id === id), `${recherche} : souvenir supprimé (${id}) encore rendu`);
          const h = await lireHistorique(ctx, id);
          exigerRevisions(ctx, historique, h, [
            { event: "ADD", old_memory: null, new_memory: texte, is_deleted: false },
            { event: "DELETE", old_memory: texte, new_memory: null, is_deleted: true },
          ]);
          if (h.length !== 2) return;
          ctx.constater(
            h[1].created_at === h[0].created_at,
            `${historique} : [1].created_at (${h[1].created_at}) diffère de [0].created_at (${h[0].created_at})`,
          );
          ctx.constater(
            Date.parse(h[1].updated_at) >= Date.parse(h[0].updated_at),
            `${historique} : [1].updated_at (${h[1].updated_at}) antérieur à [0].updated_at (${h[0].updated_at})`,
          );
        },
      },
    ];
  },
};

/** Les 8 gabarits /memory/*, tels que les nomment journal et écarts. */
const ROUTES_MEMOIRE = [
  "POST /memory/add",
  "POST /memory/add_procedure",
  "POST /memory/search",
  "GET /memory/all",
  "GET /memory/graph",
  "PUT /memory/{id}",
  "GET /memory/{id}/history",
  "DELETE /memory/{id}",
] as const;

const JETON_OUVERT: Groupe = {
  nom: "jeton-ouvert",
  horsExterne: true,
  cas: () => [
    {
      libelle: "AC-6 · aucune route /memory/* rejetée sans jeton",
      executer: async (ctx) => {
        const journal = ctx.journal().filter((e) => e.phase === "ouvert");
        for (const route of ROUTES_MEMOIRE) {
          const acceptee = journal.some((e) => e.route === route && !e.jeton && e.statut !== 401);
          ctx.constater(
            acceptee,
            `${route} : aucune requête sans X-Mem0-Token acceptée (statut ≠ 401) dans la phase ouvert`,
          );
        }
      },
    },
  ],
};

const JETON = "contrat-jeton";
/** Corps exact du 401 de l'ancien mem0-http Python, que mem0-rs reproduit. */
const CORPS_401 = { detail: "bad or missing X-Mem0-Token" };

/** Les 8 requêtes /memory/* de la phase jeton, corps valides (le rejet vient du jeton, pas d'un 422). */
function requetesJeton(id: string): Requete[] {
  return [
    {
      methode: "POST",
      gabarit: "/memory/add",
      corps: { text: "Souvenir de la phase jeton", agent_id: JETON, infer: false },
      forme: AJOUT,
    },
    {
      methode: "POST",
      gabarit: "/memory/add_procedure",
      corps: { steps: "1. Vérifier le jeton", agent_id: JETON },
      forme: AJOUT,
    },
    { methode: "POST", gabarit: "/memory/search", corps: { query: "jeton", agent_id: JETON }, forme: RECHERCHE },
    { methode: "GET", gabarit: "/memory/all", chemin: `/memory/all?agent_id=${JETON}`, forme: LISTE },
    { methode: "GET", gabarit: "/memory/graph", forme: GRAPHE },
    {
      methode: "PUT",
      gabarit: "/memory/{id}",
      chemin: `/memory/${id}`,
      corps: { text: "Souvenir de la phase jeton modifié" },
      forme: MAJ,
    },
    { methode: "GET", gabarit: "/memory/{id}/history", chemin: `/memory/${id}/history`, forme: HISTORIQUE },
    { methode: "DELETE", gabarit: "/memory/{id}", chemin: `/memory/${id}`, forme: SUPPRESSION },
  ];
}

/** Chaque route /memory/* doit rendre 401 ; tous les écarts sont consignés, pas seulement le premier. */
async function exigerRejets(ctx: Contexte, jeton: string | null, corpsErreur?: unknown): Promise<void> {
  for (const requete of requetesJeton(randomUUID())) {
    try {
      await ctx.appeler({ ...requete, jeton, statut: 401, corpsErreur });
    } catch (e) {
      if (!(e instanceof EchecCas)) throw e;
      for (const ecart of e.ecarts) ctx.constater(false, ecart);
    }
  }
}

const JETON_JETON: Groupe = {
  nom: "jeton",
  cas: () => [
    {
      libelle: "AC-5 · GET /health sans jeton rend 200",
      executer: async (ctx) => {
        await ctx.appeler({ methode: "GET", gabarit: "/health", jeton: null, forme: SANTE });
      },
    },
    {
      libelle: "AC-5 · les 8 routes /memory/* sans en-tête rendent 401",
      executer: (ctx) => exigerRejets(ctx, null),
    },
    {
      libelle: "AC-5 · les 8 routes /memory/* avec un jeton faux rendent 401",
      executer: (ctx) => exigerRejets(ctx, "contrat-jeton-faux"),
    },
    {
      libelle: "mem0-rs-noyau AC-2 · 401 : corps exact, aucune lecture ni écriture",
      executer: async (ctx) => {
        const avant = ctx.compteursOpenAI().embeddings;
        await exigerRejets(ctx, null, CORPS_401);
        await exigerRejets(ctx, "contrat-jeton-faux", CORPS_401);
        const recus = ctx.compteursOpenAI().embeddings - avant;
        ctx.constater(
          recus === 0,
          `faux OpenAI : ${recus} requête(s) embeddings reçue(s) pendant les rejets 401, 0 attendue`,
        );
        const liste = (await ctx.appeler({
          methode: "GET",
          gabarit: "/memory/all",
          jeton: JETON,
          forme: LISTE,
        })) as Liste;
        ctx.constater(liste.total === 0, `GET /memory/all : total attendu 0 après les rejets 401, reçu ${liste.total}`);
      },
    },
    {
      libelle: "AC-5 · les 8 routes /memory/* avec le bon jeton rendent 200",
      executer: async (ctx) => {
        // L'ajout fournit l'id visé par PUT, history et DELETE.
        const r = (await ctx.appeler({ ...requetesJeton("")[0], jeton: JETON })) as Ajout;
        const id = r.results[0]?.id;
        if (id === undefined) throw new EchecCas(["POST /memory/add : aucun souvenir créé avec le bon jeton"]);
        for (const requete of requetesJeton(id).slice(1)) await ctx.appeler({ ...requete, jeton: JETON });
      },
    },
  ],
};

/** Les 9 gabarits du contrat (B-1). */
const ROUTES = ["GET /health", ...ROUTES_MEMOIRE] as const;

const COUVERTURE: Groupe = {
  nom: "couverture",
  cas: () => [
    {
      libelle: "AC-1 · les 9 routes ont été exercées",
      executer: async (ctx) => {
        const journal = ctx.journal();
        for (const route of ROUTES) {
          ctx.constater(
            journal.some((e) => e.route === route),
            `couverture : route jamais exercée ${route}`,
          );
        }
      },
    },
  ],
};

// Rang (mem0-rs-noyau S-10) : la fixture commitée rang.json porte le corpus, les
// requêtes et l'ordre capturé sur le Python. Phase à part, instance neuve : l'IDF
// du BM25 ne voit que ce corpus.

/** Seuil appliqué par le serveur quand `threshold` vaut null (mem0 2.2.1). */
const SEUIL_DEFAUT = 0.1;

const RANG: Groupe = {
  nom: "rang",
  horsExterne: true,
  cas: () => {
    /** id du serveur → clé du corpus. */
    const cles = new Map<string, string>();
    /** clé de requête → lignes rendues par la recherche de la fixture. */
    const reponses = new Map<string, LigneExpliquee[]>();
    const nommer = (id: string): string => cles.get(id) ?? id;
    return [
      {
        libelle: "mem0-rs-noyau AC-13 · corpus du rang ajouté (infer=false)",
        executer: async (ctx) => {
          const f = ctx.fixtureRang();
          for (const s of f.corpus) cles.set(await ajouter(ctx, f.agent_id, s.texte), s.cle);
        },
      },
      {
        libelle: "mem0-rs-noyau AC-13 · chaque requête rend les clés de la fixture dans l'ordre",
        executer: async (ctx) => {
          const f = ctx.fixtureRang();
          for (const q of f.requetes) {
            const r = await chercherExplique(ctx, corpsRechercheRang(f, q));
            reponses.set(q.cle, r.results);
            const recues = r.results.map((s) => nommer(s.id));
            const attendu = q.attendu ?? [];
            ctx.constater(
              isDeepStrictEqual(recues, attendu),
              `rang ${q.cle} : attendu [${attendu.join(", ")}], reçu [${recues.join(", ")}]`,
            );
          }
        },
      },
      {
        libelle: "mem0-rs-noyau AC-10 · score_details.semantic_score = cosinus brut du faux embedder",
        executer: async (ctx) => {
          for (const q of ctx.fixtureRang().requetes) {
            for (const s of reponses.get(q.cle) ?? []) {
              const c = cosinus(q.query, s.memory);
              const semantique = s.score_details.semantic_score;
              ctx.constater(
                Math.abs(semantique - c) <= 1e-6,
                `rang ${q.cle} : ${nommer(s.id)} a semantic_score ${semantique}, cosinus du faux embedder ${c}`,
              );
            }
          }
        },
      },
      {
        libelle: "mem0-rs-noyau AC-11 · threshold écarte le souvenir lexical avant la fusion",
        executer: async (ctx) => {
          const f = ctx.fixtureRang();
          const { requete, cle } = f.seuil_avant_fusion;
          const q = f.requetes.find((x) => x.cle === requete);
          const souvenir = f.corpus.find((s) => s.cle === cle);
          if (q === undefined || souvenir === undefined) {
            throw new EchecCas([
              `rang : seuil_avant_fusion (${requete}, ${cle}) ne désigne pas une requête et un souvenir de la fixture`,
            ]);
          }
          const seuil = q.threshold ?? SEUIL_DEFAUT;
          const id = [...cles].find(([, c]) => c === cle)?.[0];
          ctx.constater(
            !(reponses.get(q.cle) ?? []).some((s) => s.id === id),
            `rang ${q.cle} : ${cle} rendu malgré threshold ${seuil}`,
          );
          const c = cosinus(q.query, souvenir.texte);
          ctx.constater(
            c < seuil,
            `rang ${q.cle} : cosinus local de ${cle} = ${c}, non inférieur à threshold ${seuil}`,
          );
          const ligne = (await chercherExplique(ctx, corpsRechercheRang(f, q, true))).results.find((s) => s.id === id);
          ctx.constater(
            ligne !== undefined && ligne.score_details.bm25_score > 0,
            `rang ${q.cle} : à threshold 0, ${cle} ${ligne === undefined ? "absent" : `rendu avec bm25_score ${ligne.score_details.bm25_score}`} (présent avec bm25_score > 0 attendu)`,
          );
        },
      },
      {
        libelle: "mem0-rs-noyau AC-15 · GET /memory/graph rend les arêtes de la fixture",
        executer: async (ctx) => {
          const route = "GET /memory/graph";
          const attendu = ctx.fixtureRang().graphe;
          if (attendu === undefined) throw new EchecCas(["rang : fixture sans graphe"]);
          const g = (await ctx.appeler({ methode: "GET", gabarit: "/memory/graph", forme: GRAPHE })) as Graphe;
          for (const champ of ["total", "threshold", "top_k"] as const) {
            ctx.constater(
              g[champ] === attendu[champ],
              `${route} : ${champ} attendu ${attendu[champ]}, reçu ${g[champ]}`,
            );
          }
          const recues = new Map(aretesParCles(g.edges, nommer).map((a) => [`${a.a} — ${a.b}`, a.score]));
          const attendues = new Map(attendu.aretes.map((a) => [`${a.a} — ${a.b}`, a.score]));
          for (const [paire, score] of attendues) {
            const recu = recues.get(paire);
            if (recu === undefined) ctx.constater(false, `${route} : arête attendue ${paire} absente`);
            else
              ctx.constater(
                Math.abs(recu - score) <= 1e-6,
                `${route} : arête ${paire} : score attendu ${score}, reçu ${recu}`,
              );
          }
          for (const paire of recues.keys())
            ctx.constater(attendues.has(paire), `${route} : arête inattendue ${paire}`);
          for (let i = 0; i + 1 < g.edges.length; i++) {
            const [e, suivante] = [g.edges[i], g.edges[i + 1]];
            const ordonnee =
              e.score > suivante.score ||
              (e.score === suivante.score &&
                (e.source < suivante.source || (e.source === suivante.source && e.target <= suivante.target)));
            ctx.constater(
              ordonnee,
              `${route} : edges[${i}] et edges[${i + 1}] ne sont pas triées par (score décroissant, source, target)`,
            );
          }
        },
      },
    ];
  },
};

/** Phases dans l'ordre d'exécution ; une phase sans groupe ne démarre aucune instance. */
export const PHASES: readonly Phase[] = [
  {
    nom: "ouvert",
    jetonServeur: "",
    groupes: [
      SANTE_OUVERT,
      GRAPHE_OUVERT, // premier groupe qui écrit : /memory/graph compte tous les scopes
      PROCEDURE_OUVERT,
      TAGS_OUVERT,
      HISTORIQUE_OUVERT,
      LISTE_OUVERT,
      RECHERCHE_OUVERT,
      SUPPRESSION_OUVERT,
      INFER_OUVERT,
      NOYAU_OUVERT,
      JETON_OUVERT,
    ],
  },
  // Instance neuve : l'IDF du BM25 ne compte que le corpus de la fixture.
  { nom: "rang", jetonServeur: "", groupes: [RANG] },
  { nom: "jeton", jetonServeur: JETON, groupes: [JETON_JETON] },
  // Sans instance : le groupe ne lit que le journal de toutes les phases.
  { nom: "couverture", jetonServeur: null, groupes: [COUVERTURE] },
];
