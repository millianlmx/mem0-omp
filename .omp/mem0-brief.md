<!-- mem0:brief v2 -->
# Brief mémoire — règles complètes

Généré par le plugin `omp-mem0-memory`. Tu peux éditer ce fichier : il ne sera pas
réécrit tant que le marqueur de version en tête reste `v2`.

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
  projet. Avec `scope: "global"` si c'est vrai pour tous ses projets.

## Ce qu'il ne faut pas mémoriser

L'état courant du code (il change, et le dépôt fait autorité), ce qui est déjà dans
`AGENTS.md` ou le README, un raisonnement intermédiaire, une tâche en cours, un
résultat de test, du bavardage. Et jamais de secret, clé, token ou donnée
personnelle — la rédaction automatique existe mais elle est approximative.

## Comment écrire un souvenir

Une idée par appel, autoportante : quelqu'un doit pouvoir la comprendre dans six mois
sans le contexte de cette conversation. Nomme les fichiers, modules et symboles.

- OUI — `Tests : XCTest, un fichier par type, fixtures dans Tests/Support. Pas de mocks manuels, on passe par des protocoles + implémentations de test.`
- OUI — `Bug écran de séance figé : cause = Timer non invalidé au dismiss de la vue. Fix = .onDisappear { timer.invalidate() }. Vérifier ce pattern sur toute vue à timer.`
- NON — `On a corrigé le bug du timer.` (ni symptôme, ni cause, ni fix)
- NON — `TabataEngine.swift fait 340 lignes.` (périmé au prochain commit)

Une méthode réutilisable en plusieurs étapes (déployer, débugger une catégorie
d'erreur, checklist avant release) → `mem0_add` avec `kind: "procedure"`.

## Quand un souvenir est faux

Le dépôt gagne toujours. Si un souvenir contredit le code réel, il est périmé :
enregistre la version à jour avec `mem0_add` (la fusion garde une trace de l'état
précédent), ou supprime-le avec `mem0_forget` s'il est simplement faux.
