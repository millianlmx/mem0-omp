// Catalogue des surfaces de la recette UI Mac (S-6 de recette-ui-mac-automatisee) :
// la SOURCE UNIQUE des 24 surfaces — 9 sections de la barre latérale, puis
// 15 feuilles. L'ordre du tableau est l'ordre du parcours, du rapport et du tri
// des signalements.
//
// Les ids sont exactement les rawValues de `SurfaceRecipe`
// (omp-console/Sources/OMPConsole/SurfaceRecipe.swift) : la sonde passe l'id tel
// quel en `-surface.recipe <id>`. Le marqueur est l'AXIdentifier dont la sonde
// attend la présence (section : sous la fenêtre, sans feuille ; feuille : sous
// l'`AXSheet` enfant de la fenêtre).

export type TypeSurface = "section" | "feuille";

export type Surface = {
  id: string;
  type: TypeSurface;
  titre: string;
  marqueur: string;
};

export const CATALOGUE: readonly Surface[] = [
  { id: "accueil", type: "section", titre: "Accueil", marqueur: "home.dashboard" },
  { id: "pipelines", type: "section", titre: "Pipelines", marqueur: "kanban.board" },
  { id: "projet", type: "section", titre: "Projet", marqueur: "projet.start" },
  { id: "session-omp", type: "section", titre: "Session OMP", marqueur: "session.launch" },
  { id: "terminal", type: "section", titre: "Terminal", marqueur: "terminal.view" },
  { id: "sessions", type: "section", titre: "Sessions", marqueur: "viewer.selector.list" },
  { id: "fichiers", type: "section", titre: "Fichiers", marqueur: "files.target" },
  { id: "memoire", type: "section", titre: "Mémoire", marqueur: "memoire.list" },
  { id: "statistiques", type: "section", titre: "Statistiques", marqueur: "stats.board" },
  { id: "bienvenue", type: "feuille", titre: "Bienvenue", marqueur: "welcome.sheet" },
  { id: "preparation", type: "feuille", titre: "Préparation", marqueur: "sheet.setup" },
  { id: "appairage", type: "feuille", titre: "Appairage", marqueur: "pairing.sheet" },
  { id: "nouvelle-pipeline", type: "feuille", titre: "Nouvelle pipeline", marqueur: "launch.sheet" },
  { id: "reponse", type: "feuille", titre: "Réponse à une carte", marqueur: "answer.sheet" },
  { id: "contrat", type: "feuille", titre: "Contrat", marqueur: "contract.sheet" },
  { id: "fiche-carte", type: "feuille", titre: "Fiche de carte", marqueur: "kanban.detail" },
  { id: "modeles", type: "feuille", titre: "Modèles", marqueur: "models.sheet" },
  { id: "projet-lancement", type: "feuille", titre: "Lancement de projet", marqueur: "projet.launch.commit" },
  { id: "projet-dialogue", type: "feuille", titre: "Question de la conduite", marqueur: "projet.dialog.cancel" },
  {
    id: "session-omp-dialogue",
    type: "feuille",
    titre: "Question de la session",
    marqueur: "session.dialog.cancel",
  },
  { id: "terminal-lancement", type: "feuille", titre: "Ouverture du Terminal", marqueur: "terminal.launch.list" },
  { id: "memoire-creation", type: "feuille", titre: "Nouveau souvenir", marqueur: "memoire.create.sheet" },
  { id: "memoire-edition", type: "feuille", titre: "Modifier le souvenir", marqueur: "memoire.edit.sheet" },
  { id: "memoire-lien", type: "feuille", titre: "Lier le souvenir", marqueur: "memoire.link.sheet" },
];
