# omp-console — la coque de la salle de contrôle

`omp-console/` est le paquet SwiftPM de l'application macOS de la salle de
contrôle : une fenêtre, une barre latérale à quatre sections — **Kanban**,
**Sessions**, **Fichiers**, **Projet** — et un panneau de détail. Les quatre sections
sont vivantes : **Kanban** affiche le tableau des pipelines (voir « Section Kanban »)
avec sa zone d'action (voir « Agir depuis le Kanban »), **Sessions** le sélecteur de
sessions (voir « Visionneuse de session »), **Fichiers** la visionneuse de fichiers
et de diffs (voir « Lire les fichiers et les diffs d'une cible ») et **Projet** la
conduite de projet (voir « Fenêtre Projet (conduite) »).
Cible minimale : macOS 14.

## Prérequis

- macOS 14 ou plus récent.
- Les Command Line Tools d'Apple : `swift --version` doit répondre.
- **`xcodebuild` n'est ni requis ni utilisable** sur un poste sans Xcode : sur un
  poste équipé des seuls Command Line Tools, il refuse de tourner (« requires
  Xcode, but active developer directory is a CommandLineTools instance »). Tout
  passe par SwiftPM (`swift build`, `swift test`) et par l'assemblage du bundle
  décrit ci-dessous.

## Builder

```bash
cd omp-console
swift build            # debug
swift build -c release # release
```

## Tester

```bash
cd omp-console
# SwiftPM ne trouve pas toujours les macros de Swift Testing (échec non
# déterministe du toolchain) : on pointe explicitement le dossier des plugins.
# `--no-parallel` : la suite mêle des tests à VEILLE qui attendent sur le fil
# principal (modèles Kanban et Files) et des tests de vue ; en parallèle elle
# rend 10 à 15 échecs de délai, en série elle passe 212/212 (~42 s).
swift test --scratch-path .build-tests --no-parallel \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
```

Sous les Command Line Tools seuls, XCTest n'existe pas : la suite du paquet
utilise **Swift Testing**, la seule bibliothèque de tests fournie avec le
toolchain.

Trois pièges mesurés sur Swift 6.4 CLT seuls expliquent cette ligne :

- `swift test` doit être la **première** commande écrite dans son dossier de
  build : un `swift build` préalable dans le même dossier fait échouer la
  compilation des tests (« plugin for module 'TestingMacros' not found »). D'où
  le `--scratch-path .build-tests` dédié — `scripts/swift-app.sh` compile et
  teste de son côté dans `omp-console/.build-app`.
- même sans build préalable, `swift test` échoue environ une fois sur trois en
  « plugin for module 'TestingMacros' not found », de façon non déterministe
  (reproduit sur un paquet minimal). Le `-plugin-path` explicite ci-dessus rend
  la suite déterministe.
- en **parallèle**, la suite complète est instable : les tests de modèle à veille
  interrogent le fil principal, que les tests de vue saturent — mesuré le
  2026-09-29 (fusion des trois features de « Les vues ») : 10 à 15 échecs de
  délai sur 212 tests en parallèle, 212/212 en série. `--no-parallel` est donc la
  règle du dépôt, dans la commande locale comme dans `scripts/swift-app.sh`.

## Lire le magasin d'état

`Sources/OMPConsole/Store/` est la **couche de lecture** du magasin d'état partagé
(`~/.omp/agent/pipeline/`, ou `MEM0_PIPELINE_STATE_DIR`) : les six répertoires
`running`, `history`, `lots`, `projects`, `inbox` et `audit` sont rendus en
modèles Swift typés, en parité avec le lecteur TypeScript de `omp-mem0-req`
(`omp-mem0-req/store.ts`, `lot.ts`, `project.ts`).

- `StoreReader` lit une racine et une horloge injectables ; une entrée au schéma
  incomplet est **écartée et nommée** (`discardedEntries` : le fichier
  `<store>/<nom>` et la raison — `JSON illisible` ou `schéma incomplet ou
  inconnu`), jamais rendue partielle ; `availability` distingue « magasin absent »
  de « magasin vide » pour chaque store, et `StoreSnapshot.root` porte la
  disponibilité de la **racine** elle-même.
- `StoreWatcher` veille un store par **notification du système de fichiers**
  (source vnode sur le répertoire, jamais de scrutation) et pousse un instantané
  typé à ses abonnés (`AsyncStream`, multicast) ; `StoreHub` agrège les six en un
  flux global. L'émission n'a lieu que si l'instantané a changé.
- La couche est un **lecteur** : aucune API d'écriture n'est appelée, jamais — un
  propriétaire mort est marqué (`isStale`), ni retiré ni déplacé vers `history/`.

`commands/` ne fait pas partie du périmètre **lu** par la couche `Store/`. La
section **Kanban** consomme le flux global en lecture, et c'est la couche
`Actions/` (voir « Agir depuis le Kanban ») qui écrit — et seulement deux
familles de fichiers : les livraisons d'un run et les commandes du canal.

## Section Kanban

`Sources/OMPConsole/Kanban/` est le **tableau des pipelines** : une ardoise unique
mêlant **tous** les dépôts, peuplée depuis le seul magasin d'état partagé — les
features de projet (`projects`), les features de lot (`lots`), les runs hors lot
(`running`) et les vingt clôtures les plus récentes (`history`, même borne que
`/pipelines`). Elle ne fait qu'afficher : aucune API d'écriture n'est appelée, un
propriétaire mort n'est ni déplacé vers `history/` ni retiré (à la différence du
panneau `/pipelines`, qui réconcilie). Elle **n'écrit rien** : les gestes offerts
depuis une carte passent par la couche `Actions/` (voir « Agir depuis le Kanban »),
jamais par le tableau lui-même.

### Les onze colonnes

En-tête d'une colonne : `<libellé> (<n>)`. Chaque carte est rangée dans
**exactement une** colonne ; les onze colonnes sont toujours affichées, même vides.

| `KanbanColumn` (`rawValue`, identifiant AX) | Libellé |
|---|---|
| `en-attente` | En attente |
| `en-cours` | En cours |
| `question-en-vol` | Question en vol |
| `pr-ouverte` | PR ouverte |
| `fusionne` | Fusionné |
| `echec` | Échec |
| `jalon-specs` | Jalon specs |
| `jalon-review` | Jalon review |
| `bloquee` | Bloquée |
| `terminee-sans-pr` | Terminée sans PR |
| `annulee-retiree` | Annulée / retirée |

### Les trois messages d'état

| Situation | Message |
|---|---|
| aucun instantané reçu encore | `Chargement du magasin d'état…` |
| la racine `<stateDir>` n'existe pas | `Magasin d'état absent : <stateDir>` |
| la racine existe, aucune carte ni anomalie | `Magasin d'état vide : <stateDir>` |

Un magasin qui ne contient que des fichiers illisibles rend le **tableau** (colonnes
vides + bandeau), jamais « vide » : les anomalies ne sont jamais tues. Le panneau de
détail sans sélection écrit `Aucune carte sélectionnée`.

### Identifiants d'accessibilité

| Identifiant | Surface |
|---|---|
| `kanban.board` | la zone des **colonnes** (focus clavier et flèches) |
| `kanban.column.<rawValue>` | une colonne |
| `kanban.card.<id>` | une carte (`feature:<clé>:<slug>`, `project:<clé>:<slug>`, `run:<id>`, `history:<id>`) |
| `kanban.banner` | le bandeau d'anomalies (absent s'il n'y en a aucune) |
| `kanban.anomaly.<i>` | une ligne d'anomalie |
| `kanban.detail` | le panneau de détail (carte sélectionnée) |
| `kanban.detail.empty` | le panneau sans sélection |
| `kanban.empty` | les deux messages « absent » / « vide » |
| `kanban.loading` | le message de chargement |

Clavier : les flèches `↓`/`↑` (carte suivante/précédente) et `→`/`←` (colonne
suivante/précédente non vide) sont attachées à la **zone des colonnes**
(`kanban.board`) — jamais au panneau de détail, donc une flèche dans un champ de
saisie de la zone d'action déplace le curseur, pas la colonne. Clic simple sur une
carte : sélection + surbrillance + panneau de détail. Sélectionner une carte ne
change **jamais** de section : la barre latérale reste sur Kanban, et Sessions,
Fichiers et Projet gardent leur propre contenu.

### Parité avec `/pipelines`

Sur le même magasin, toute entité lue par `/pipelines` a sa carte au même état :

| `/pipelines` | Tableau Kanban |
|---|---|
| rang de feature du lot | carte `feature:<clé>:<slug>`, dans la colonne de son état |
| rang `running` non apparié | carte `run:<id>` |
| rang `history` (20 plus récents) | carte `history:<id>` |
| run apparié à une feature | **fusionné** : une feature = une carte |
| colonne de droite `/phase · état · temps` | `phase`, `state`, `durée` de la carte |
| rang `PR : <url>` (feature `done`) | `PR : <url>` de la carte |
| en-tête « pilote : … mort » | marque `mort` + ligne de bandeau |
| avis « N fichier(s) d'état illisible(s) » | une ligne de bandeau par fichier |

Deux écarts **délibérés** : `/pipelines` réconcilie les propriétaires morts (le
tableau, lui, marque la carte `mort` en `Échec` sur place), et les features de
projet sans lot sont un ajout du tableau — elles font partie des sources (B-2).
`inbox/` et `audit/` ne sont pas des cartes.

### Recette : vivacité à l'écran

Le paquet ne vend aucun produit exécutable : la preuve graphique passe par le bundle
et une sonde AX (recette manuelle, jamais exécutée par la CI).

```bash
bash scripts/swift-app.sh                       # depuis la racine du dépôt
MEM0_PIPELINE_STATE_DIR=/tmp/magasin-jetable \
  nohup "omp-console/build/OMP Console.app/Contents/MacOS/OMPConsole" >/tmp/omp-console.log 2>&1 &
```

Lancer le binaire **directement** (pas `open`) : son `cwd` porte alors `.git`. Puis,
avec une sonde AX (`AXUIElementCreateApplication(pid)` + parcours de
`kAXChildrenAttribute`) :

1. lire `kanban.card.<id>` deux fois à 2 s d'intervalle ⇒ la durée a augmenté ;
2. publier un `running/<id>.json` de fixture dans le magasin jetable ⇒ la carte
   apparaît ; le supprimer ⇒ elle disparaît ; réécrire son état ⇒ elle change de
   colonne ;
3. cliquer une carte (clic souris réel) ⇒ `kanban.detail` décrit la carte et la
   surbrillance suit ; lire la barre latérale ⇒ la section reste **Kanban** ;
4. relever `kanban.banner` / `kanban.anomaly.<i>` après avoir déposé un fichier
   tronqué dans le magasin.

Le magasin jetable est **obligatoire** : la recette ne touche jamais
`~/.omp/agent/pipeline` de la machine.

### Recette : parité avec `/pipelines`

Sur le **même** magasin, ouvrir `/pipelines` dans une session OMP puis comparer rang
par rang selon la table ci-dessus (dépôt, entités, colonnes, anomalies). Pour un
propriétaire mort, laisser `/pipelines` réconcilier d'abord : le tableau voit alors
l'entrée d'historique et la parité tient. Consigner les relevés dans la section
`## Revue` du contrat.

## Agir depuis le Kanban

`Sources/OMPConsole/Actions/` est la **seule** couche qui écrit depuis l'app. Elle
n'écrit jamais l'état du lot : ses deux familles de fichiers sont les livraisons
d'un run (`<stateDir>/inbox/<boîte>/`) et les commandes du canal
(`<stateDir>/commands/`). Tout geste est tracé dans le **journal des gestes** en bas
de la section, avec l'accusé du pilote quand il y en a un — un refus est affiché
verbatim, et une commande sans pilote reste « en attente dans le canal ».

| Geste | Où | Écrit |
|---|---|---|
| Répondre à une question en vol (option ou texte libre) | zone d'action du détail | une livraison `ask` dans la boîte publiée du run |
| Envoyer un texte à un run vivant sans question | zone d'action du détail | une livraison `text` dans la boîte publiée du run |
| Valider les specs | zone d'action du détail (feature en attente specs) | `{kind:"verdict", verdict:"v"}` dans le canal |
| Accepter la revue | zone d'action du détail (feature en attente revue) | `{kind:"verdict", verdict:"y"}` dans le canal |
| Arrêter le lot | zone d'action du détail (carte portant un lot) | `{kind:"stop", repo}` dans le canal |
| Lancer une feature | bandeau « Lancer une feature… » | `{kind:"launch", title, description, repo}` dans le canal |

Règles d'aiguillage : une carte qui porte une **question en vol** offre la réponse
(option **ou** texte libre, jamais les deux ensemble) ; un run vivant **sans**
question offre l'envoi de texte ; une carte qui n'offre rien dit pourquoi (run non
armé, ou aucun geste possible). Le dépôt du formulaire de lancement est **choisi**
parmi les dépôts connus des cartes et le projet ouvert ; le slug est dérivé par le
dépôt, jamais par l'app.

### Identifiants d'accessibilité de l'action

| Identifiant | Surface |
|---|---|
| `kanban.actions.bar` | le bandeau de lancement |
| `kanban.launch.toggle` | le bouton « Lancer une feature… » |
| `kanban.launch.title`, `.description`, `.repo`, `.submit`, `.cancel` | les contrôles du formulaire |
| `kanban.actions` | la zone d'action sous les lignes du détail |
| `kanban.actions.motif` | le motif quand la carte n'offre aucun geste |
| `kanban.actions.option.<i>` | une option de la question en vol |
| `kanban.actions.answerField`, `.answer` | le champ libre et le bouton « Répondre » |
| `kanban.actions.steerField`, `.send` | le champ et le bouton d'envoi de texte |
| `kanban.actions.validate`, `.accept` | les boutons de jalon |
| `kanban.actions.stop` | le bouton « Arrêter le lot » |
| `kanban.journal`, `kanban.journal.empty` | le journal des gestes |

### Recette : agir depuis la carte

Même bundle et même magasin jetable que la recette de vivacité (une sonde AX
jetable : `AXUIElementCreateApplication(pid)` + parcours de `kAXChildrenAttribute`,
plus des clics et des frappes réels par `CGEvent`).

1. sélectionner une carte de feature en attente specs (clic réel) ⇒ la zone
   d'action expose `kanban.actions`, `kanban.actions.validate`,
   `kanban.actions.stop`, `kanban.actions.option.<i>`, `kanban.actions.answer`,
   `kanban.actions.answerField` et `kanban.launch.toggle` ;
2. cliquer « Valider les specs » ⇒ **un** fichier apparaît dans
   `<magasin>/commands/` (`{"version":1,"id":"console-…","repo":"…","kind":"verdict",
   "slug":"…","verdict":"v","sentAt":…}`) et `kanban.journal.empty` disparaît de
   l'arbre (une ligne s'est ajoutée au journal) ;
3. focaliser `kanban.actions.answerField`, y saisir un texte et presser `→` puis
   `←` ⇒ la sélection du champ passe de `(0,0)` à `(1,0)` puis revient à `(0,0)`
   alors que `kanban.actions.validate` reste présent : la colonne n'a pas bougé (le
   tableau garde ses flèches hors des champs) ;
4. déplacer la sélection au clavier jusqu'à une carte de run sans boîte ⇒
   `kanban.actions.motif` porte le texte du run non armé.

Le magasin jetable est **obligatoire** : la recette ne touche jamais
`~/.omp/agent/pipeline` de la machine.

## Lire les fichiers et les diffs d'une cible

La section **Fichiers** est une visionneuse **strictement en lecture** de l'arbre
d'une cible git — le dépôt principal ou l'un des worktrees `feat/*` connus, une
seule cible à la fois.

1. **Choisir la cible** — le sélecteur « Cible » de l'en-tête. La cible par défaut
   est celle du projet ouvert (la préférence partagée `session.projectRoot` avec la
   fenêtre « Session OMP ») ; à défaut, le dépôt principal. Chaque cible affiche sa
   base de comparaison : `HEAD` pour le principal, ou `base <sha7>` — la base
   enregistrée de la feature dans le magasin d'état, à défaut la base de fusion avec
   la branche par défaut du principal.
2. **Parcourir l'arbre** — colonne de gauche : fichiers **suivis** et **non suivis**
   de la cible, `.gitignore` appliqué. Un fichier suivi supprimé sur disque y reste,
   avec le badge « supprimé » ; un fichier ignoré par git (le contrat de la
   pipeline, par exemple) n'y figure jamais.
3. **Lire un fichier** — un clic (ou ↑/↓) publie à droite son **diff** puis son
   **contenu** : le diff couvre tout l'écart entre la cible et sa base (commits de la
   branche **et** modifications non commitées) ; un fichier non suivi y apparaît
   comme un ajout complet. Le diff est rendu en une seule colonne, hunks dans
   l'ordre de git, retraits en rouge, ajouts en vert — et jamais par la couleur
   seule : le `-` et le `+` de tête sont toujours là.
4. **Les deux documents de pilotage, hors arbre** — les boutons **Contrat**
   (`.omp/pipeline/contract.md` de la cible active, que git ignore donc qui ne peut
   pas figurer dans l'arbre) et **PROJECT.md** (à la racine de la cible). Absents,
   ils l'annoncent au lieu d'afficher un contenu vide ou celui d'une autre cible.
5. **Suivre les changements** — la cible active est surveillée par **FSEvents** (un
   seul descripteur récursif sur sa racine) : un fichier ajouté ou modifié met
   l'arbre et le document à jour sans geste, au plus un rechargement par 300 ms
   d'accalmie. Pas de scrutation périodique. **⌘R** (ou « Rafraîchir ») force un
   rechargement immédiat.

**Garanties de lecture seule.** Les seules commandes git employées sont
`ls-files -z --cached`, `ls-files -z --others --exclude-standard`,
`diff --no-color --no-ext-diff <base> -- <chemin>`,
`diff --no-color --no-ext-diff --no-index -- /dev/null <chemin>`,
`worktree list --porcelain`, `rev-parse --git-common-dir`, `rev-parse --abbrev-ref
HEAD`, `symbolic-ref --short --quiet refs/remotes/origin/HEAD` et `merge-base` —
toutes préfixées de `-C <répertoire> -c core.pager=cat`, jamais par un shell. Ni
`git add` (donc jamais `-N`), ni `update-index`, ni `git status` (qui rafraîchit
l'index), ni aucune autre commande d'écriture. Le contenu d'un fichier non suivi
passe par `--no-index`, qui ne touche pas l'index : le fichier reste `??`. Les
tests de la suite le vérifient sur une cible réelle, `git status --porcelain`,
l'empreinte du fichier d'index et les empreintes de tous les fichiers à l'appui.

**Mesure du 2026-09-28** (poste millian, Swift 6.4 CLT seuls, git 2.54.0) :
`bash scripts/swift-app.sh` — compilation release et **177 tests verts**, bundle
assemblé puis signature vérifiée ; `bash scripts/check.sh` — « Dépôt prêt à
publier. ». Les deux recettes (session, cible) sont rapportées « skipped » : aucun
script de CI ne pose leurs variables.

Les gestes à l'écran (choisir une cible dans le sélecteur, déplier l'arbre, voir le
diff coloré, ⌘R) restent une **vérification manuelle du poste** : dans un shell de
pipeline sans session d'affichage, le bundle se lance et son état est vivant —
l'application est bien au premier plan (`OMP Console` dans la barre de menus) et son
arbre d'accessibilité expose sa fenêtre et ses quatre sections — mais la fenêtre
n'est peinte sur aucun écran, donc une capture d'écran ne la montre pas.
fichiers, projet) consommeront ces flux dans les features suivantes : aucune n'est
branchée ici.
## Visionneuse de session

La section **Sessions** de la barre latérale liste les runs du magasin d'état
(les vivants d'abord, puis les runs clos) : chaque ligne est un bouton, et la
cliquer ouvre la **conversation de la session de ce run** dans une fenêtre dédiée.

- **Une fenêtre par session.** Re-choisir un run déjà ouvert ramène sa fenêtre au
  premier plan (la valeur présentée est la session, pas l'entrée du magasin) ;
  choisir un autre run en ouvre une seconde. Le titre de la fenêtre est
  `« <libellé du run> — <étiquette de session> »`.
- **Les faits essentiels y sont, une fois chacun, dans l'ordre du fichier** :
  messages avec leur rôle (« vous », « agent »), nom et cible de chaque appel
  d'outil, arguments, résultats, question `ask` et ses options, marqueurs de
  compaction et de branche.
- **Chaque appel d'outil se plie et se déplie individuellement** (replié par
  défaut ; un appel `ask` entre déplié), avec le statut `⇒ en attente`,
  `⇒ ok · N lignes` ou `⇒ erreur · N lignes`.
- **Diffs colorés par contenu** : tout diff unifié reçu d'un outil est détecté dans
  le texte du résultat, et le diff d'un appel d'édition d'OMP (`details.diff`) est
  classé ligne à ligne. Ajout, suppression, contexte et en-têtes sont distingués —
  par la couleur ET par la valeur d'accessibilité de chaque ligne (« ligne
  ajoutée », « ligne supprimée », « contexte », « en-tête de diff »).
- **Une question `ask` est mise en évidence, et ne se répond pas ici** : la
  visionneuse affiche la question et ses options, sans aucun geste pour y répondre.
- **Suivi automatique** : la vue ouvre le fil par la fin, puis suit les faits
  nouveaux en relisant **seulement les octets neufs** (le lecteur tient un curseur
  d'octets ; la veille est une source vnode sur le fichier, jamais une scrutation).
  Un geste vers le haut suspend le suivi — la position ne bouge plus et le bouton
  **« Revenir au direct »** apparaît ; l'activer reprend le suivi.
- **États explicites** : « en attente des premiers faits » tant que le fichier
  n'existe pas, « Session illisible : … Nouvelle tentative automatique. » s'il n'est
  pas lisible, « Session vide — aucun fait. » s'il est vide. Le bandeau du haut
  annonce en permanence `N faits · N ignorés · suivi|suivi suspendu`, plus l'état de
  lecture et, le cas échéant, `· fichier réécrit — affichage reconstruit`.
- **Lecture seule** : la visionneuse n'appelle aucune API d'écriture. Vérifier
  tient en une commande : la taille et l'empreinte du `.jsonl` ne changent pas
  pendant qu'on défile, qu'on plie ou que des faits arrivent.

### Recette : journaliser une vraie session

Même principe que la recette du lecteur — un test **désactivé par défaut** :

```bash
cd omp-console
MEM0_VIEWER_RECIPE="$HOME/.omp/agent/sessions/<bucket>/<horodatage>_<id>.jsonl" \
MEM0_VIEWER_RECIPE_OUT="/tmp/journal-visionneuse.txt" \
swift test --scratch-path .build-tests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing" \
  --filter recette
```

Le journal écrit une ligne par fait affiché (identité de ligne, rôle, texte, appels
d'outil avec leur cible et leurs arguments, question `ask` et options, diffs), à
confronter à la session de référence et au TUI.

## Recette : lire une vraie session

Le paquet ne vend aucun produit exécutable : la recette du lecteur de sessions
(`SessionReader`, `renderConversation`) passe donc par un test **désactivé par
défaut**, qui ne tourne que si on le lui demande explicitement.

```bash
cd omp-console
MEM0_SESSION_RECIPE="$HOME/.omp/agent/sessions/<bucket>/<horodatage>_<id>.jsonl" \
MEM0_SESSION_RECIPE_OUT="/tmp/rendu-session.txt" \
swift test --scratch-path .build-tests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing" \
  --filter recette
```

`MEM0_SESSION_RECIPE` est le chemin de la session à lire ; `MEM0_SESSION_RECIPE_OUT`
est le chemin du rendu à écrire (les deux sont requis). Le test n'affirme rien sur
le contenu : il écrit le rendu et annonce les comptes à confronter.

`--filter recette` (mesuré) porte sur le nom de FONCTION du test, pas sur son titre
affiché : renommer `recetteManuelleRendUneVraieSession` sans garder « recette »
dans le nom ferait sélectionner zéro test (sortie « Build complete! » seulement).

À vérifier dans le fichier de sortie :

1. la suite des têtes `== <i> …` est `1…n` sans trou ni répétition (aucune perte, aucun doublon,
   ordre du fichier) — le nombre de référence est celui des entrées annoncé par la recette, car un
   corps est rendu verbatim et peut citer une ligne qui ressemble à une tête de bloc ;
2. les pensées (`-- thinking`), les appels d'outil (`-- tool`, `-- args`) avec
   leur résultat (`== <i> tool-result …`) et leur diff (`-- diff`) apparaissent ;
3. les marqueurs `compaction` et `branch-summary` apparaissent là où le fichier
   les place ;
4. pendant qu'un run écrit sa session, relancer la même commande sur son `.jsonl`
   vivant : le rendu est produit sans erreur, la taille et la date du fichier
   relevées avant et après la lecture sont inchangées, et le run poursuit et se
   termine sans erreur ;
5. consigner en revue les commandes exactes, les chemins, la taille du rendu, le
   nombre d'entrées, le nombre d'ignorées et l'état du run après la lecture.

La CI ne l'exécute **jamais** : ni `.github/workflows/check.yml` ni
`scripts/swift-app.sh` ne posent ces variables, donc le test est rapporté
« skipped ».

## Recette : lire une vraie cible

La visionneuse n'a pas non plus de produit exécutable à elle : sa recette passe par
le même véhicule — un test **désactivé par défaut**, qui n'écrit rien dans la cible
et se contente de rendre ce que la section afficherait.

```bash
cd omp-console
MEM0_FILES_RECIPE="$HOME/.omp/pipeline-worktrees/<lot>/<slug>" \
MEM0_FILES_RECIPE_OUT="/tmp/rendu-visionneuse.txt" \
swift test --scratch-path .build-tests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing" \
  --filter recette
```

`MEM0_FILES_RECIPE` est le chemin de la cible à lire (un worktree de feature, ou le
dépôt principal) ; `MEM0_FILES_RECIPE_OUT` est le chemin du rendu à écrire (les deux
sont requis). Le test n'affirme rien sur le contenu : il écrit le rendu et annonce
les comptes à confronter.

Le rendu porte quatre sections : la **cible active** (libellé, chemin, branche,
base), le **catalogue** des cibles connues, l'**arbre** (une ligne par entrée, avec
son badge), le **diff** d'un fichier choisi et le **contenu** du premier fichier de
l'arbre. Le fichier du diff est un fichier **non suivi** s'il en existe un (son diff
est un ajout complet, garanti non vide), sinon le premier des 60 premiers fichiers
suivis qui porte une différence — la borne est écrite dans le rendu : sur un dépôt de
plusieurs milliers de fichiers, demander un diff à git pour chacun coûterait des
minutes à une recette qui n'a rien de plus à prouver. Le contenu est écrit **tel
quel** (aucune troncature dans le produit), borné à 200 lignes avec la marque
explicite de ce qui a été omis.

Mesure du 2026-09-28 (worktree `feat/visionneuse-de-fichiers-et-diffs`, contrat
présent, fichiers non suivis créés par la feature) :

```
recette : …/visionneuse-de-fichiers-et-diffs → /tmp/rendu-visionneuse.txt ;
15 cibles, 177 entrées, 17274 octets de rendu
```

À vérifier dans le fichier de sortie :

1. la cible active est bien celle passée en argument, et sa base correspond à
   `git -C <cible> rev-parse --abbrev-ref HEAD` / au sha enregistré de la feature
   (le catalogue liste le principal et les worktrees `feat/*` du poste) ;
2. l'arbre contient les fichiers suivis ET non suivis, à leur chemin relatif, et
   aucun fichier ignoré (le contrat, un répertoire `build/`) ;
3. le diff commence par `diff --git`, porte `--- /dev/null` et un hunk `@@ -0,0 +1,N @@`
   pour un fichier non suivi, et chaque ligne ajoutée commence par `+` ;
4. `git -C <cible> status --porcelain` reste identique avant et après la recette, et
   aucun fichier de la cible n'a été modifié.

La CI ne l'exécute **jamais** : ni `.github/workflows/check.yml` ni
`scripts/swift-app.sh` ne posent ces variables, donc le test est rapporté
« skipped ».

## Assembler le bundle `.app`

Depuis la **racine** du dépôt :

```bash
bash scripts/swift-app.sh
```

Le script compile en release, lance la suite en release, écrit le bundle dans
`omp-console/build/OMP Console.app`, le signe en ad hoc puis vérifie la
signature (`codesign --verify --strict`). Sous une plateforme autre que macOS, il
annonce « non exécuté » et sort en code 2 sans rien compiler.

## Ouvrir l'app

Double-cliquez `omp-console/build/OMP Console.app`, ou :

```bash
open "omp-console/build/OMP Console.app"
```

La fenêtre s'ouvre ; la barre de menus porte **« OMP Console »**. Pour le vérifier
sans cliquer (le processus doit être lancé) :

```bash
lsappinfo list | grep "OMP Console"
```

## Héberger une session OMP

Menu **Fichier ▸ « Nouvelle session OMP »** (⌘N) ouvre la fenêtre **Session OMP**,
qui héberge **une seule** session à la fois (la scène est à instance unique : il ne
peut pas exister deux `omp` hébergés).

1. **Choisir le projet** — bouton « Choisir un dossier… » (⌘O). Le dossier choisi
   devient le cwd passé au `omp` hébergé ; il est mémorisé, et il n'est jamais
   réécrit sans un geste de votre part.
2. **Choisir le mode** — deux modes, une différence réelle :
   - **`rpc-ui — dialogues actifs`** : le seul mode headless où l'outil `ask` de
     l'hôte existe. C'est le mode où un prompt peut déclencher une question à choix
     multiples, à laquelle la fenêtre répond.
   - **`rpc — sans dialogues`** : mode conducteur, sans `ask` côté hôte. Le prompt
     part, les événements arrivent, aucune question n'est posée.
3. **Lancer la session** (⌘R), saisir un prompt (↩ pour envoyer, ⌘↩ pour
   « Envoyer »), **lire** la transcription brute des trames reçues et le journal.
4. **Arrêter la session** (⌘.) ou quitter l'app : le process est terminé par la
   fermeture de son stdin (fin propre du protocole), il n'en reste aucun orphelin,
   et le fichier de session `.jsonl` reste sur disque, résumable.

États affichés dans la fenêtre : projet absent, `Aucune session`, `Lancement…`,
`Session vivante (pid <n>, session <8 caractères>)`, dialogue en attente,
`Arrêt en cours…`, `Session arrêtée`, `Process mort (code|signal <n>)` (avec un
bouton **Relancer**, qui reprend le même `.jsonl`), et l'erreur explicite en cas
d'échec. Un prompt n'est jamais relancé tout seul après une mort : la relance est
un clic.

### Trouver le binaire `omp`

La variable d'environnement **`OMP_CONSOLE_OMP_BINARY`** fixe le chemin du binaire :
quand elle est posée et non vide, c'est le **seul** candidat — pratique pour un
`omp` hors des emplacements habituels, ou pour forcer un poste sans `omp` (utile
avec le harnais ci-dessous).

Sans elle, l'ordre de recherche est : chaque entrée de `PATH`, puis
`~/.bun/bin/omp`, `/opt/homebrew/bin/omp`, `/usr/local/bin/omp` — le premier
fichier **exécutable** gagne. Les trois emplacements explicites ne sont pas
décoratifs : une app lancée par le Finder hérite du `PATH` de `launchd`
(`/usr/bin:/bin:/usr/sbin:/sbin`) et ne verrait donc jamais `~/.bun/bin`, où `omp`
s'installe couramment.

Si aucun candidat n'est exécutable, la fenêtre affiche « Binaire `omp` introuvable :
cherché dans PATH, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin. » — aucune session
fantôme n'est affichée comme vivante.

## Fenêtre Projet (conduite)

Menu **Fichier ▸ « Conduire un projet… »** (⌘⇧N) — ou le bouton du même nom dans
la section **Projet** — ouvre la fenêtre **Projet**, qui héberge la conduite d'un
projet par le pilote `/project` de l'extension : **une seule conduite à la fois**
(la scène est à instance unique, et un second démarrage est refusé jusqu'à la
clôture de la courante).

1. **Choisir le dépôt et le nom** dans la feuille (dossier par `NSOpenPanel`,
   dossiers seulement, nom par défaut = dernier composant du chemin).
2. **Conduire** — l'app lance `omp --mode rpc-ui --cwd <dossier>` (mode
   dialogues actifs, seul mode où l'outil `ask` de l'hôte existe) puis écrit
   `/project <nom>`. Aucun terminal n'est ouvert, aucune commande n'est tapée.
3. **Jouer l'utilisateur** — la saisie libre de la fenêtre écrit un `prompt`
   (↩ ou ⌘↩), et toute demande adressée à l'utilisateur (cadrage, validation du
   plan, escalade de lot) s'affiche comme un dialogue répondable : `select` (liste
   d'options), `input`/`editor` (texte, avec le `prefill` du plan pour un `editor`),
   `confirm`.
4. **Suivre** — le volet **Plan** re-présente le JSON du magasin (segments, état
   de chaque feature, modèle, lien de la PR quand elle existe), et le volet
   **Document** rend `PROJECT.md`. Les deux se rafraîchissent sans action : le JSON
   par la veille du magasin, le document par une veille de fichier.
5. **Alerter** — quand le projet attend une réponse et que la fenêtre n'est pas au
   premier plan, l'app émet **une** demande d'attention critique (`NSApp`) ; à la
   fin du projet (toutes les features du dernier segment fusionnées ou retirées),
   une demande informative unique. Aucune notification macOS, aucun vol de focus.
6. **Clore** — bouton **Clore la conduite** (arrêt propre du process hébergé). Le
   projet reste `running` côté pilote ; la reprise éventuelle est le fait du
   pilote au prochain `/project`.

**Ce que l'app n'écrit jamais** : ni `<stateDir>/projects/<clé>.json`, ni le
worktree `.doc`, ni le lot. Elle ne réimplémente non plus aucune règle du pilote
(plan, segments, jalons, PR) : elle affiche ce que le magasin porte et renvoie les
réponses dans la session hébergée.

Aucune reprise automatique : relancer l'app n'ouvre **aucune** session et n'arme
**aucun** `/project` ; c'est toujours un geste de l'utilisateur.

### Recette : conduire un projet depuis l'app

1. Supprimer l'état restauré des fenêtres **avant** de lancer le bundle, pour
   partir d'une app fraîche :

   ```bash
   rm -rf ~/Library/Saved\ Application\ State/com.omp.console.savedState
   ```

2. Assembler et lancer le bundle :

   ```bash
   bash scripts/swift-app.sh
   open "omp-console/build/OMP Console.app"
   ```

3. ⌘⇧N, choisir un dépôt GitHub réel, saisir un nom, « Conduire ».
4. Écrire la description du projet puis « fin » dans la barre de saisie : la
   question suivante (validation du plan) s'affiche comme un dialogue.
5. Choisir « Corriger le plan » : l'éditeur s'ouvre **prérempli** du plan ;
   modifier, « Répondre », vérifier que le pilote redemande une revue.
6. Laisser courir jusqu'à la première PR, puis vérifier dans le volet **Plan** le
   segment, l'état « PR ouverte » et le lien cliquable de la PR, et dans le volet
   **Document** le contenu publié de `PROJECT.md`.
7. Mettre la fenêtre en arrière-plan : un dialogue en attente doit lever une
   demande d'attention (icône de l'app dans le Dock qui rebondit).

## Harnais réel

La suite de tests contient quatre tests **réels** qui lancent un vrai `omp` (donc
font de vrais appels au modèle) et parcourent l'aller-retour complet : prompt →
événements → dialogue `ask` répondu → fin de tour, le mode conducteur sans
dialogues, un `SIGKILL` suivi d'une relance qui reprend le même `.jsonl`, et la
fermeture de l'app sans orphelin.

Ces tests ne tournent que si **`omp` est résoluble** sur la machine (garde sur la
plateforme macOS **et** la résolution du binaire). Ailleurs — notamment en
intégration continue, où aucun binaire `omp` n'est installé — ils sont rapportés
« skipped » et la suite reste verte. Leur nom de fonction commence par `harness`,
donc :

```bash
cd omp-console
# Une boucle locale rapide, sans appel modèle et sans session réelle :
swift test --scratch-path .build-tests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing" \
  --skip harness
```

`scripts/swift-app.sh` et `bash scripts/check.sh` lancent la suite **sans** ce
filtre : sur un poste qui a `omp`, ils exécutent donc une vraie session avec appel
modèle, et prennent le temps d'un tour réel. `OMP_CONSOLE_OMP_BINARY=/nonexistent/omp`
force le chemin « non exécuté » quand on veut la suite complète sans session réelle.

## Notifications et barre de menus

L'app est une **app de barre de menus** : fermer la fenêtre ne la quitte pas (seul
**⌘Q** quitte), l'item de barre reste présent, et un clic sur cet item ramène la
fenêtre visible et au premier plan. Le titre de l'item suit les compteurs —
`<occupés>·<en attente>` (point médian U+00B7) dès que l'un des deux est non nul,
l'icône seule sinon (`square.grid.2x2`) ; un menu déroulant n'est **pas** posé, un
menu demanderait deux clics là où un seul doit ramener la fenêtre.

### Les notifications

Une notification macOS est émise quand un évènement du magasin survient, **au plus
une fois par évènement** (déduplication persistée), et **seulement si la fenêtre de
l'app n'est pas au premier plan** (mesuré par `NSApplication.isActive`). Les quatre
besoins et leurs six familles :

| Évènement | Source | Titre · corps |
|---|---|---|
| attend une réponse | `running/<id>.json`, `pendingAsk` en vol et propriétaire vivant | `<label> attend une réponse` · « Une question attend votre réponse. » |
| attend une validation (specs) | feature de lot `waiting` avec `waitKind = specs` | `<name> attend une validation` · « Jalon specs : validez le contrat pour continuer. » |
| attend une validation (revue) | idem avec `waitKind = review` | `<name> attend une validation` · « Jalon revue : validez la livraison pour continuer. » |
| échoué (feature de lot) | feature de lot `failed` | `<name> a échoué` · « La feature `<slug>` a échoué. » |
| échoué (run clos) | `history/<id>.json`, `finalState = failed` | `<label> a échoué` · « Le run a échoué. » |
| PR fusionnée | feature de projet `status = merged` dans `projects/<clé>.json` | `PR fusionnée : <slug>` · « La PR de `<slug>` est fusionnée. » |

`<name>` est le `name` de la feature s'il n'est pas blanc, sinon son `slug` ; le
`label` est celui que le dépôt écrit lui-même. Une PR absente de `projects/` n'émet
rien (une PR non suivie), et une feature de **lot** `done` avec `prUrl` (colonne
« PR ouverte » du Kanban) n'est pas une fusion. Les sources sont bornées comme le
magasin : 200 entrées `running`, 20 rangs `history`, un lot et un projet par dépôt.

### La bande d'état de la fenêtre

Une bande informative est posée **au-dessus** du `NavigationSplitView`, donc visible
dans les quatre sections. Aucun élément focusable, aucun geste : l'ordre de
tabulation existant est inchangé.

| État | Ligne des compteurs (`status.counters`) |
|---|---|
| aucun instantané reçu | `Chargement des compteurs…` |
| racine du magasin absente | `Compteurs indisponibles — magasin d'état absent : <dir>` |
| sinon | `occupés : <busy> · en attente : <waiting>` (les deux chiffres toujours là, y compris 0) |

Une seconde ligne (`status.notifications`) apparaît **seulement** si l'autorisation
de notification est refusée :
`Notifications désactivées — autorisez OMP Console dans Réglages Système ▸ Notifications.`

| Identifiant | Surface |
|---|---|
| `status.strip` | la bande |
| `status.counters` | la ligne des compteurs |
| `status.notifications` | la ligne de refus (absente de l'arbre si l'autorisation n'est pas refusée) |

« Occupés » compte les cartes de la colonne **En cours** ; « en attente » les cartes
« Question en vol », « Jalon specs » et « Jalon review » — deux catégories
**exclusives**, calculées sur l'ardoise que la fenêtre affiche. La colonne « En
attente » du Kanban (features `pending`, non lancées) n'est **pas** ce compteur. La
bande et l'item de barre lisent le même état : leurs chiffres ne peuvent pas diverger.

### Le registre persisté

Les clés déjà notifiées vivent dans un fichier JSON :
`{"version":1,"notified":{"<clé>":<millisecondes epoch>}}`.

- Emplacement par défaut : `~/Library/Application Support/com.omp.console/notified-alerts.json`.
- Surcharge : la variable **`MEM0_CONSOLE_ALERTS_DIR`** (chemin absolu retenu, `~`
  développé ; un chemin relatif est ignoré).
- Fichier absent, illisible, non JSON, d'une autre version ou au champ `notified`
  mal typé ⇒ registre **vide**, jamais d'exception ; seules les clés font foi.
- L'écriture précède la livraison, et a lieu **même fenêtre au premier plan**
  (l'évènement est consommé : une relance ne le renotifiera pas). Aucune purge,
  aucun TTL.

### Recette manuelle

Le paquet ne vend aucun produit exécutable : la livraison réelle d'une notification
(bannière macOS) se prouve sur le **bundle** et une autorisation accordée. Aucun
processus de test ne peut ni construire un `NSStatusItem` ni appeler
`UNUserNotificationCenter` hors bundle (voir les trois pièges ci-dessous), donc le
test `AlertsRecipeTests` (désactivé par défaut) s'arrête à un livreur enregistreur.

```bash
bash scripts/swift-app.sh                       # depuis la racine du dépôt
MEM0_PIPELINE_STATE_DIR=/tmp/magasin-alertes \
  MEM0_CONSOLE_ALERTS_DIR=/tmp/ledger-alertes \
  nohup "omp-console/build/OMP Console.app/Contents/MacOS/OMPConsole" >/tmp/omp-console.log 2>&1 &
```

1. Accorder le dialogue d'autorisation ; vérifier `status.counters` à
   `occupés : 0 · en attente : 0` et l'item de barre à l'icône seule.
2. Mettre une autre app au premier plan, puis produire un **vrai** évènement par un
   **process de run réel** (`omp --mode rpc-ui` armé du magasin jetable, prompt
   demandant une question à choix multiples) : une bannière apparaît, nomme le run,
   et aucune seconde ne suit tant que la question est en vol. Relancer l'app avec le
   même `MEM0_CONSOLE_ALERTS_DIR` ⇒ aucune bannière ; `notified-alerts.json` porte la
   clé `answer:<id>:<toolCallId>`.
3. Répéter fenêtre **au premier plan** ⇒ aucune bannière, mais la clé est enregistrée.
4. Sur un pipeline réel, observer un jalon (`waitKind = specs|review`,
   `state = waiting`) et une fusion (`projects/<clé>.json`, `status = merged`) : une
   bannière par évènement, jamais deux.
5. Refuser l'autorisation dans Réglages Système ▸ Notifications ▸ OMP Console,
   rouvrir la fenêtre ⇒ `status.notifications` affiche la phrase ; la réaccorder ⇒ la
   ligne disparaît (statut relu à l'activation de l'app).
6. Fermer la fenêtre (bouton rouge) ⇒ l'app reste vivante, l'item de barre est là,
   ⌘Q quitte ; presser l'item (sonde AX `AXPress`) ⇒ la fenêtre redevient visible et
   au premier plan.

### Trois pièges mesurés

1. **Hors bundle, pas de centre de notifications.** `UNUserNotificationCenter.current()`
   dans un binaire nu (ou un processus de `swift test`) tue le process sur une
   exception Objective-C non rattrapable (`bundleProxyForCurrentProcess is nil`). La
   garde d'instanciation est donc `Bundle.main.bundleURL.pathExtension == "app"`, et
   **aucun** appel UserNotifications ne vit ailleurs que dans `AlertDelivery.swift`.
2. **`NSStatusBar` interdit dans la suite.** `NSStatusBar.system.statusItem(withLength:)`
   tue un processus de test (signal 6, pile `-[NSStatusBar _statusItemWithLength:withPriority:]`).
   `StatusItemController` n'y est donc jamais construit : sa logique de titre est une
   fonction pure (`StatusItemTitle`), et son câblage AppKit est prouvé par la recette.
3. **`activate()` coopératif est refusé.** Sans intention utilisateur,
   `NSApplication.activate()` rend la fenêtre visible mais pas clé ni principale ;
   seule `activate(ignoringOtherApps: true)` (dépréciée avec le SDK du poste, assumé)
   rétablit fenêtre clé/principale et app active.

### Relevés mesurés (poste de référence, 2026-09-29)

- `swift test` (suite complète, `--no-parallel`) : **265 tests verts**, la recette
  `AlertsRecipeTests` rapportée « skipped » (aucun script de CI ne pose ses variables).
- Recette en suite, lancée une fois à la main
  (`MEM0_ALERTS_RECIPE_DIR=/tmp/alerts-recipe/magasin`,
  `MEM0_ALERTS_RECIPE_OUT=/tmp/alerts-recipe/journal.txt`) : un process réel écrit
  `running/00000000000000a1.json` (état `waiting` + `pendingAsk`), le vrai modèle
  notifie **une** fois — clé `answer:00000000000000a1:call-1`, titre
  `recette/attente attend une réponse`, corps `Une question attend votre réponse.`,
  résultat `delivered` — et `notified-alerts.json` porte la clé. Le journal rappelle
  qu'aucun `add` réel n'est prouvé hors bundle.
- Les bannières réelles et le clic sur l'item de barre se consignent dans la section
  `## Revue` du contrat : cette recette exige le bundle et une autorisation accordée.

## Structure du paquet

```
omp-console/
├── Package.swift                  manifeste SwiftPM (cible macOS 14, deux cibles)
├── Sources/OMPConsole/
│   ├── OMPConsoleApp.swift        point d'entrée (@main), scènes et menu
│   ├── ConsoleRootView.swift      fenêtre, barre latérale, détail
│   ├── SectionViews.swift         les quatre vues de section
│   ├── ConsoleSection.swift       les quatre sections et leurs libellés
│   ├── ConsoleModel.swift         l'état : la section courante
│   ├── ProjectRoot.swift          le projet ouvert, résolu en UN endroit (clé partagée)
│   ├── SessionConsoleView.swift   fenêtre « Session OMP » (cinq zones, tous les états)
│   ├── SessionConsoleModel.swift  projet, mode, prompt, dialogue, statut, actions
│   ├── SessionHost.swift          session hébergée : poignée de main, corrélation,
│   │                              dialogues, mort, relance, arrêt propre
│   ├── RpcFrames.swift            trames JSONL : décodage, commandes, réponses
│   ├── RpcChunkDecoder.swift      fragments v2 et lignes illisibles
│   ├── RpcTransport.swift         process hébergé : tubes, signaux, sortie
│   ├── OmpBinary.swift            résolution du binaire `omp`
│   ├── Session/                   le lecteur de sessions (aucune vue, aucune E/S d'écriture)
│   │   ├── SessionModel.swift     le modèle de conversation : des valeurs
│   │   ├── SessionReader.swift    lecture incrémentale tirée par l'appelant
│   │   ├── SessionRendering.swift le rendu texte du modèle (fonctions pures)
│   │   └── RpcPanes.swift         volets RPC partagés (transcription, dialogue, prompt)
│   ├── Project/                   la conduite d'un projet depuis l'app
│   │   ├── ProjectConduite.swift  identité, état et refus d'une conduite
│   │   ├── ProjectConsoleModel.swift le modèle : armement, refus, clôture, dialogues, veille
│   │   ├── ProjectPaths.swift     la clé de dépôt et le chemin de PROJECT.md
│   │   ├── ProjectPlan.swift      le plan (segments, états, PR) : fonctions pures
│   │   ├── ProjectDocMarkdown.swift le document rendu en blocs (fonction pure)
│   │   ├── ProjectAttention.swift décision d'attention (pure) et adaptateur NSApp
│   │   ├── ProjectWindowPresence.swift présence de la fenêtre + WindowAccessor
│   │   ├── ProjectViewText.swift  tous les textes de la vue Projet
│   │   ├── ProjectConsoleView.swift la fenêtre (en-tête, plan, document, session)
│   │   ├── ProjectView.swift      la section « Projet » (même surface)
│   │   └── ProjectLaunchSheet.swift la feuille « Conduire un projet… »
│   ├── Store/                     la couche de lecture du magasin d'état
│   │   ├── PipelineStore.swift    racine du magasin et noms des six stores
│   │   ├── StoreModels.swift      modèles typés et validation champ par champ
│   │   ├── StoreSnapshot.swift    enveloppes d'un instantané
│   │   ├── StoreReader.swift      balayage, filtrage, entrées écartées nommées
│   │   ├── StoreWatcher.swift     veille vnode d'un store et flux d'abonnés
│   │   └── StoreHub.swift         le flux global, agrégat des six
│   ├── Kanban/                    le tableau des pipelines (lecture seule)
│   │   ├── KanbanModels.swift     colonnes, cartes, sources, marques, clé de dépôt
│   │   ├── KanbanBoard.swift      construction pure de l'ardoise, textes de parité
│   │   ├── KanbanAnomalies.swift  illisible, mort, doublon : bandeau et marques
│   │   ├── KanbanModel.swift      abonnement au flux, sélection, clavier
│   │   ├── KanbanView.swift       la section : bandeau, onze colonnes, clavier
│   │   ├── KanbanCardView.swift   une carte cliquable (durée sous TimelineView)
│   │   └── KanbanDetailView.swift le panneau de détail
│   ├── Actions/                   les gestes : la SEULE couche qui écrit
│   │   ├── PipelineCommand.swift  livraisons et commandes, objets JSON exacts
│   │   ├── PipelineWriter.swift   écriture atomique (rename), lecture des accusés
│   │   ├── ActionsText.swift      tous les textes et les lignes de journal
│   │   ├── KanbanActionPresentation.swift  aiguillage pur et dépôts lançables
│   │   ├── ActionsModel.swift     journal borné, émissions, sondage des accusés
│   │   └── KanbanActionViews.swift  bandeau, formulaire, zone d'action, journal
│   ├── Files/                     la visionneuse de fichiers et de diffs (lecture seule)
│   │   ├── GitCLI.swift           binaires, argv purs et exécution : la SEULE surface git
│   │   ├── FilesTarget.swift      catalogue des cibles et base de comparaison
│   │   ├── FilesTree.swift        l'arbre d'une cible (suivis, non suivis, supprimés)
│   │   ├── FilesReader.swift      le contenu d'un fichier, exactement
│   │   ├── FilesDiff.swift        le diff unifié découpé en lignes typées
│   │   ├── TreeWatcher.swift      veille FSEvents récursive de la cible active
│   │   ├── FilesModel.swift       l'état de la section : cible, arbre, document, veille
│   │   ├── FilesText.swift        tous les textes de la section, en un endroit
│   │   └── FilesView.swift        la section : en-tête, arbre, document, états
│   ├── Viewer/                    la visionneuse de session (aucune écriture)
│   │   ├── ViewerTarget.swift     la valeur d'une fenêtre : la session, et son titre
│   │   ├── SessionSelectorModel.swift  les runs choisissables, depuis le magasin
│   │   ├── SessionSelectorView.swift   la section « Sessions » : la liste
│   │   ├── SessionRows.swift      faits affichables, en-tête d'appel, question `ask`
│   │   ├── SessionDiffLines.swift diffs : classification et découpe des corps
│   │   ├── FileWatcher.swift      veille vnode d'UN fichier quelconque
│   │   ├── SessionViewerModel.swift  lignes, plis, suivi, états, journal d'octets
│   │   ├── SessionViewerView.swift   bandeau, flux, états vides, « Revenir au direct »
│   │   ├── SessionRowView.swift      le rendu d'un fait (dont les lignes de diff)
│   │   └── ScrollBottomObserver.swift la géométrie du défilement et ses gestes
│   ├── Alerts/                    les notifications macOS et la bande d'état
│   │   ├── AlertEvents.swift      dérivation des six familles, clés et textes purs
│   │   ├── AlertDelivery.swift    livreur réel/no-op, autorisation (SEUL import UserNotifications)
│   │   ├── AlertLedger.swift      registre persisté des clés, lecture tolérante
│   │   ├── AlertsModel.swift      abonnement, décision, compteurs, autorisation
│   │   └── AlertsStripView.swift  la bande de la fenêtre (textes purs, identifiants AX)
│   └── MenuBar/                   l'item de barre de menus et ses compteurs
│       ├── RunCounters.swift      occupés / en attente et l'état publié
│       └── StatusItem.swift       titre pur + contrôleur AppKit de l'item
├── Tests/OMPConsoleTests/         la suite Swift Testing
├── Bundle/Info.plist              le plist du bundle .app
└── build/                         artefacts (bundle .app), ignorés par git
```

## Plateforme

La section `── App Swift` de `scripts/check.sh` ne tourne que sous macOS : elle
compile le paquet, lance ses tests et assemble le bundle. Sous Ubuntu, elle
annonce « non exécuté » sans faire échouer la validation du dépôt ; les tests réels
du harnais y sont eux aussi « skipped », faute de `omp`.
