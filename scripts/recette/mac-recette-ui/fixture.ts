// Jeu de données fictif FIXE de la recette UI Mac (S-4 de
// recette-ui-mac-automatisee) : le dépôt git « atelier » et ses worktrees (Fichiers,
// Terminal), le support modèle, l'omp factice, et les réponses du serveur de
// fixture (mem0-http, oMLX). Les sections de pilotage sont servies par le serveur
// de pipelines du VPS : l'instance de recette n'en relie aucun, elles montrent
// leur appel à le relier.
//
// Ce module est PUR : il décrit des fichiers, des commits et des réponses ; seul
// recette.ts (sous-commande `fixture`) écrit sur disque, appelle git et écoute.
//
// Déterminisme : aucune horloge, aucun aléa, aucune variable d'environnement
// n'est lue ici. Toute date vaut `debut - décalage`, avec un décalage d'au moins
// 2 h pour que les libellés relatifs (« il y a 3 h ») ne bougent pas pendant le
// passage ; seuls les commits ont des dates absolues, pour des SHA stables.

/** Jeton d'installation fictif : `stack/installation-token`, rendu par `GET /health`. */
export const JETON_INSTALLATION = "5265636574746520554920646520274f4d5020436f6e736f6c6527204d61632e";

const HEURE = 3_600_000;
const JOUR = 24 * HEURE;

/** Ce dont le jeu dépend, et rien d'autre. */
export type EntreeJeu = {
  /** R, absolue, telle que passée (les chemins écrits gardent cette forme). */
  racine: string;
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

/** Worktree de chaque feature, relatif à R ; `export` n'en a pas. */
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

const iso = (ms: number): string => new Date(ms).toISOString();

/** Le script `omp` factice : l'app le trouve (préparation finie), il sort 0 en silence. */
const OMP_FACTICE = ["#!/bin/sh", "# omp factice de la recette UI Mac : présent, muet.", "exit 0", ""].join("\n");

/** Tous les fichiers du jeu, hors dépôt git (décrit par `depotFictif`) et hors
 *  `fixture.json` (écrit en dernier par recette.ts, serveur à l'écoute). */
export function jeuFictif(e: EntreeJeu): FichierJeu[] {
  return [
    { chemin: "support-modele/stack/installation-token", contenu: `${JETON_INSTALLATION}\n`, mode: 0o644 },
    { chemin: "support-modele/stack/env", contenu: `OMLX_BASE_URL=http://127.0.0.1:${e.port}/v1\n`, mode: 0o644 },
    { chemin: "bin/omp", contenu: OMP_FACTICE, mode: 0o755 },
  ];
}

// ---------------------------------------------------------------------------
// Serveur de fixture : routes de S-4, réponses pures

export type Requete = { methode: string; url: string };
export type Reponse = { statut: number; corps: unknown };

const INTROUVABLE: Reponse = { statut: 404, corps: { error: "not_found", reason: "route non servie par la recette" } };

const SOUVENIRS: Array<[string, string, string]> = [
  ["recette-1", "Le carnet de l'atelier liste une tâche par ligne, au format « jour : tâche ».", "recette,mac"],
  ["recette-2", "Les jours du carnet restent dans l'ordre de la semaine, du lundi au dimanche.", "recette,carnet"],
  ["recette-3", "Une tâche finie est barrée dans le carnet, jamais effacée.", "recette,carnet"],
  ["recette-4", "L'export du carnet attend le choix entre CSV et JSON.", "recette,export"],
  ["recette-5", "Le thème sombre du carnet garde un contraste d'au moins 4,5:1.", "recette,theme"],
  ["recette-6", "Les commandes de papier de verre se notent dans notes.txt.", "recette,atelier"],
];

/** Les réponses du serveur de fixture : pures, la même requête rend toujours la même réponse. */
export class RouteurFixture {
  readonly debut: number;

  constructor(debut: number) {
    this.debut = debut;
  }

  repondre(r: Requete): Reponse {
    const url = new URL(r.url, "http://127.0.0.1");
    if (r.methode !== "GET") return INTROUVABLE;
    const ok = (corps: unknown): Reponse => ({ statut: 200, corps });
    switch (url.pathname) {
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
      case "/v1/models":
        return ok({ object: "list", data: [{ id: "qwen3-8b" }, { id: "bge-m3" }] });
      default:
        return INTROUVABLE;
    }
  }
}
