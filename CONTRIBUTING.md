# Contribuer

Ces six règles ne sont pas des recommandations : chacune est jugée par le dépôt lui-même, par un test ou un script nommé ci-dessous.

Un clone neuf se prépare une fois, réseau requis : `npm run setup` installe les outils épinglés (Biome, TypeScript, l'hôte OMP de la CI, la Qdrant des tests d'import mem0-rs). Avant, les sections lint et types de `scripts/check.sh` rougissent, et les tests qui en dépendent se sautent en nommant ce qui manque.

## 1. Un fichier de test par slug, un id unique par critère

Chaque critère d'acceptation est prouvé par un test titré `test("<slug>/AC-<n> : …")`. Un id qualifié `<slug>/AC-<n>` désigne un seul test, et tous les ids d'un même slug vivent dans un seul fichier `test/**/<slug>.test.ts`. Un id nu `AC-<n>` est interdit dans un titre de test. Le juge est `criteria/AC-13`, dans `test/outillage/criteria.test.ts`, qui parcourt les titres de tous les fichiers de test du dépôt.

Un test juge l'état courant du dépôt, jamais un état historique : pas de `git show <sha>:…` pour comparer à un commit. Il ne fige pas non plus le texte libre d'un workflow, d'un script ou d'une doc quand une lecture structurelle (jobs, clés `if:`/`needs:`/`runs-on:`, étapes présentes, ordre relatif) ou une exécution prouve la même chose : un test de wording devenu faux se réécrit ou se supprime, il ne se re-fige pas à l'identique.

## 2. Lancer les tests touchés

`scripts/test-files.sh --scope=changed` liste, un par ligne, les fichiers de test touchés par le diff contre HEAD (fichiers non suivis compris), ceux qui nomment un source modifié et ceux dont les imports relatifs atteignent un source modifié. Passe cette liste à `node --test --experimental-strip-types` pour ne relancer que ce que ta modification concerne. Pour comparer à une autre base, l'option devient `--scope=changed=<base>` ; `--macos` réduit la liste aux tests qui dépendent de macOS. `scripts/check.sh --tests-base=<réf>` fait la même réduction dans la section tests de check.sh, les autres sections restant entières.

## 3. Respecter les verrous de documentation

Les verrous de `test/outillage/docs.test.ts` lient `README.md`, `DEVELOPPEMENT.md` et `PUBLISHING.md` au catalogue des plugins et au flux réel de CI et de release. Toute édition de ces documents se vérifie avec ce fichier de test.

## 4. Aucun bump de version à la main

Une pull request ordinaire ne monte jamais une version : le job `check` de la CI lance `scripts/no-manual-bump.sh` sur chaque pull request et échoue si un porteur de version a changé. Le bump appartient au job de release. Le détail est dans [PUBLISHING.md § « Mettre à jour »](PUBLISHING.md).

## 5. Deux catalogues identiques octet pour octet

`.omp-plugin/marketplace.json` et `.claude-plugin/marketplace.json` s'éditent ensemble. La section catalogue de `scripts/check.sh` les compare par `diff -q .omp-plugin/marketplace.json .claude-plugin/marketplace.json` et échoue au moindre écart.

## 6. Un seul juge avant de pousser

`scripts/check.sh`, lancé sans option, exécute toutes ses sections et reste le seul juge avant de pousser. Une branche n'est prête que s'il est vert.

## Pour aller plus loin

- [DEVELOPPEMENT.md § « Tests et scripts »](DEVELOPPEMENT.md) : scripts et tests du dépôt.
- [DEVELOPPEMENT.md § « CI et release »](DEVELOPPEMENT.md) : workflows CI et release.
- [PUBLISHING.md](PUBLISHING.md) : publication et mise à jour.
- [DEVELOPPEMENT.md](DEVELOPPEMENT.md) : l'arborescence du dépôt et le contrat du service mémoire.
- [SECURITY.md](SECURITY.md) : signaler une vulnérabilité en privé, jamais en issue publique.
