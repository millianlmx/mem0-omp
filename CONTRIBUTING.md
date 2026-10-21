# Contribuer

Ces six règles ne sont pas des recommandations : chacune est jugée par le dépôt lui-même, par un test ou un script nommé ci-dessous.

## 1. Un fichier de test par slug, un id unique par critère

Chaque critère d'acceptation est prouvé par un test titré `test("<slug>/AC-<n> : …")`. Un id qualifié `<slug>/AC-<n>` désigne un seul test, et tous les ids d'un même slug vivent dans un seul fichier `test/**/<slug>.test.ts`. Un id nu `AC-<n>` est interdit dans un titre de test. Le juge est `criteria/AC-13`, dans `test/outillage/criteria.test.ts`, qui parcourt les titres de tous les fichiers de test du dépôt.

## 2. Lancer les tests touchés

`scripts/test-files.sh --scope=changed` liste, un par ligne, les fichiers de test touchés par le diff contre HEAD (fichiers non suivis compris) et ceux qui nomment un source modifié. Passe cette liste à `node --test --experimental-strip-types` pour ne relancer que ce que ta modification concerne. Pour comparer à une autre base, l'option devient `--scope=changed=<base>`.

## 3. Respecter les verrous de documentation

Les verrous de `test/outillage/docs.test.ts` lient `README.md` et `PUBLISHING.md` au catalogue des plugins et au flux réel de CI et de release. Toute édition de ces documents se vérifie avec ce fichier de test.

## 4. Aucun bump de version à la main

Une pull request ordinaire ne monte jamais une version : le job `check` de la CI lance `scripts/no-manual-bump.sh` sur chaque pull request et échoue si un porteur de version a changé. Le bump appartient au job de release. Le détail est dans [PUBLISHING.md § « Mettre à jour »](PUBLISHING.md).

## 5. Deux catalogues identiques octet pour octet

`.omp-plugin/marketplace.json` et `.claude-plugin/marketplace.json` s'éditent ensemble. La section catalogue de `scripts/check.sh` les compare par `diff -q .omp-plugin/marketplace.json .claude-plugin/marketplace.json` et échoue au moindre écart.

## 6. Un seul juge avant de pousser

`scripts/check.sh`, lancé sans option, exécute toutes ses sections et reste le seul juge avant de pousser. Une branche n'est prête que s'il est vert.

## Pour aller plus loin

- [README.md § « Tests et scripts »](README.md) : scripts et tests du dépôt.
- [README.md § « CI et release »](README.md) : workflows CI et release.
- [PUBLISHING.md](PUBLISHING.md) : publication et mise à jour.
- [DEVELOPPEMENT.md](DEVELOPPEMENT.md) : le détail des tests, de la CI, de la release et du contrat du service mémoire.
