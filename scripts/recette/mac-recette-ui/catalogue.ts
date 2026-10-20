// Catalogue des surfaces de la recette UI Mac (S-6 de recette-ui-mac-automatisee) :
// la SOURCE UNIQUE des 14 surfaces — 8 sections de la barre latérale, puis
// 6 feuilles. L'ordre du tableau est l'ordre du parcours, du rapport et du tri
// des signalements.
//
// La sonde passe l'id tel quel en `-surface.recipe <id>`. Le marqueur est
// l'AXIdentifier dont la sonde attend la présence (section : sous la fenêtre, sans
// feuille ; feuille : sous l'`AXSheet` enfant de la fenêtre). Les cinq sections de
// pilotage sont relevées serveur de pipelines non relié.

export type TypeSurface = "section" | "feuille";

export type Surface = {
  id: string;
  type: TypeSurface;
  titre: string;
  marqueur: string;
};

export const CATALOGUE: readonly Surface[] = [
  { id: "accueil", type: "section", titre: "Accueil", marqueur: "home.harness" },
  { id: "pipelines", type: "section", titre: "Pipelines", marqueur: "pipelines.harness" },
  { id: "projet", type: "section", titre: "Projet", marqueur: "project.harness" },
  { id: "audit", type: "section", titre: "Audit", marqueur: "audit.harness" },
  { id: "statistiques", type: "section", titre: "Statistiques", marqueur: "stats.harness" },
  { id: "terminal", type: "section", titre: "Terminal", marqueur: "terminal.view" },
  { id: "fichiers", type: "section", titre: "Fichiers", marqueur: "files.target" },
  { id: "memoire", type: "section", titre: "Mémoire", marqueur: "memoire.list" },
  { id: "preparation", type: "feuille", titre: "Préparation", marqueur: "sheet.setup" },
  { id: "serveur", type: "feuille", titre: "Serveur de pipelines", marqueur: "server.sheet" },
  { id: "terminal-lancement", type: "feuille", titre: "Ouverture du Terminal", marqueur: "terminal.launch.list" },
  { id: "memoire-creation", type: "feuille", titre: "Nouveau souvenir", marqueur: "memoire.create.sheet" },
  { id: "memoire-edition", type: "feuille", titre: "Modifier le souvenir", marqueur: "memoire.edit.sheet" },
  { id: "memoire-lien", type: "feuille", titre: "Lier le souvenir", marqueur: "memoire.link.sheet" },
];
