// Cas du contrat boîte noire mem0-http (specs S-5, S-6, S-7) — le SEUL fichier
// de cas : viser un autre serveur (mem0-rs) se fait par MEM0_CONTRAT_URL et
// MEM0_CONTRAT_START, jamais en touchant à ce fichier.
//
// Il porte aussi le catalogue des formes (jeu de clés exact de chaque réponse 2xx)
// et l'interface de phase / groupe / cas que consomme le lanceur contrat.ts.
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { plonger } from "./faux-openai.ts";
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
  /** Forme OBLIGATOIRE de toute réponse 2xx ; le corps d'une réponse non 2xx n'est jamais lu. */
  forme?: Forme;
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

export const SANTE: Forme = objet({ ok: C(true), mem0: S, user: C("moi") });

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
export const LISTE_INFER: Forme = objet({ total: I, results: tableau(SOUVENIR_INFER) });

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
  metadata: { tags: string } | null;
  created_at: string;
  updated_at: string;
  score?: number;
  score_details?: { semantic_score: number; threshold: number };
};
type Liste = { total: number; results: Souvenir[] };
type Resultats = { results: Souvenir[] };
type Graphe = { total: number; threshold: number; top_k: number; edges: { source: string; target: string; score: number }[] };
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

/** Le souvenir d'id donné dans une liste de résultats, ou un écart consigné. */
function trouver(ctx: Contexte, route: string, resultats: readonly Souvenir[], id: string, nom: string): Souvenir | null {
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
          ctx.constater(g.edges.length === 9, `${route} : 9 arêtes attendues (H relié à chaque Lᵢ), reçu ${g.edges.length}`);
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
            ctx.constater(e.score >= g.threshold, `${route} : ${lieu} a un score ${e.score} sous threshold ${g.threshold}`);
            const suivante = g.edges[i + 1];
            if (suivante !== undefined) {
              const ordonnee =
                e.score > suivante.score ||
                (e.score === suivante.score &&
                  (e.source < suivante.source || (e.source === suivante.source && e.target <= suivante.target)));
              ctx.constater(ordonnee, `${route} : edges[${i}] et edges[${i + 1}] ne sont pas triées par (score décroissant, source, target)`);
            }
          }
          ctx.constater(relies.size === 9, `${route} : H relié à ${relies.size} Lᵢ distinctes, 9 attendues (degré > top_k)`);
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
              ctx.constater(entree[cle] === valeur, `${route} : [${i}].${cle} attendu ${json(valeur)}, reçu ${json(entree[cle])}`);
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
          ctx.constater(isDeepStrictEqual(ordre, ["A", "C", "B"]), `${route} : ordre attendu [A, C, B], reçu [${ordre.join(", ")}]`);
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
            ctx.constater(d.threshold === 0.5, `${route} : results[${i}].score_details.threshold attendu 0.5, reçu ${d.threshold}`);
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
        await ctx.appeler({ methode: "DELETE", gabarit: "/memory/{id}", chemin: `/memory/${randomUUID()}`, statut: 500 });
      },
    },
  ],
};

const FAITS_DEUX = ["Le dépôt cible bash 3.2", "La CI tourne sur ubuntu-latest"];

const INFER_OUVERT: Groupe = {
  nom: "infer",
  infer: true,
  cas: () => {
    // Compteur chat du faux OpenAI relevé au début du groupe (premier cas).
    let chatInitial = 0;
    return [
      {
        libelle: "AC-14 · infer=true extrait les faits scriptés",
        executer: async (ctx) => {
          chatInitial = ctx.compteursOpenAI().chat;
          const r = (await ctx.appeler({
            methode: "POST",
            gabarit: "/memory/add",
            corps: { text: "[script:deux-faits] Notes de la réunion d'équipe", agent_id: "contrat-infer-deux", infer: true },
            forme: AJOUT_INFER,
          })) as Ajout;
          const memoires = r.results.map((x) => x.memory);
          ctx.constater(
            isDeepStrictEqual(memoires, FAITS_DEUX),
            `POST /memory/add : faits extraits attendus ${json(FAITS_DEUX)}, reçu ${json(memoires)}`,
          );
        },
      },
      {
        libelle: "AC-14 · faits extraits relus par all",
        executer: async (ctx) => {
          const r = await lister(ctx, "contrat-infer-deux", LISTE_INFER);
          const memoires = r.results.map((x) => x.memory).sort();
          ctx.constater(r.total === 2, `GET /memory/all : total attendu 2, reçu ${r.total}`);
          ctx.constater(
            isDeepStrictEqual(memoires, [...FAITS_DEUX].sort()),
            `GET /memory/all : faits attendus ${json(FAITS_DEUX)} (sans ordre), reçu ${json(memoires)}`,
          );
        },
      },
      {
        libelle: "AC-14 · réponse scriptée vide → aucun souvenir",
        executer: async (ctx) => {
          const agent = "contrat-infer-vide";
          const r = (await ctx.appeler({
            methode: "POST",
            gabarit: "/memory/add",
            corps: { text: "[script:vide] Bavardage sans fait durable", agent_id: agent, infer: true },
            forme: AJOUT_INFER,
          })) as Ajout;
          ctx.constater(r.results.length === 0, `POST /memory/add : results vide attendu, reçu ${r.results.length} élément(s)`);
          const liste = await lister(ctx, agent, LISTE_INFER);
          ctx.constater(liste.total === 0, `GET /memory/all : total attendu 0, reçu ${liste.total}`);
        },
      },
      {
        libelle: "AC-14 · deux appels chat reçus par le faux OpenAI",
        executer: async (ctx) => {
          const recus = ctx.compteursOpenAI().chat - chatInitial;
          ctx.constater(recus === 2, `faux OpenAI : 2 requêtes chat attendues pendant le groupe, reçu ${recus}`);
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
          ctx.constater(acceptee, `${route} : aucune requête sans X-Mem0-Token acceptée (statut ≠ 401) dans la phase ouvert`);
        }
      },
    },
  ],
};

const JETON = "contrat-jeton";

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
async function exigerRejets(ctx: Contexte, jeton: string | null): Promise<void> {
  for (const requete of requetesJeton(randomUUID())) {
    try {
      await ctx.appeler({ ...requete, jeton, statut: 401 });
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
          ctx.constater(journal.some((e) => e.route === route), `couverture : route jamais exercée ${route}`);
        }
      },
    },
  ],
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
      JETON_OUVERT,
    ],
  },
  { nom: "jeton", jetonServeur: JETON, groupes: [JETON_JETON] },
  // Sans instance : le groupe ne lit que le journal de toutes les phases.
  { nom: "couverture", jetonServeur: null, groupes: [COUVERTURE] },
];
