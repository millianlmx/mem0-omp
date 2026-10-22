# Développer mem0-omp

L'organisation du dépôt et le détail de la suite de tests, de la CI et de la release. Les règles à respecter
avant une PR sont dans [CONTRIBUTING.md](CONTRIBUTING.md), la publication dans
[PUBLISHING.md](PUBLISHING.md).

## Le dépôt

```
mem0-omp/                              racine = marketplace OMP
├── .omp-plugin/marketplace.json       catalogue (repli : .claude-plugin/)
├── omp-mem0-memory/                   le plugin mémoire (un module par responsabilité, install.sh)
├── omp-mem0-req/                      le plugin des pipelines : client du serveur (/req, /project, /audit, /pipelines, /harness-follow ; outils harness_* du modèle)
├── omp-harness/                       le serveur de pipelines du VPS
│   └── deploy/                        conteneurs (harness.sh, compose), install.sh et systemd, module NixOS
├── omp-console/                       l'app macOS (SwiftUI), le noyau partagé et l'app iOS
│   └── ios/                           le projet Xcode de l'app iOS
├── mem0-stack/                        la pile conteneur du service mémoire
│   └── mem0-rs/                       le serveur mémoire (Rust + SQLite)
├── test/                              la suite node --test
├── scripts/check.sh                   la validation avant publication
├── scripts/test-files.sh              liste les fichiers de test : tous, macOS, du diff, d'une liste, outillage
├── scripts/test-touched.sh            lance les tests qu'une liste de fichiers concerne (npm run test:touched)
├── scripts/test-ac.sh                 preuve par critère : les tests du diff qui portent AC-n
├── scripts/ci-verdict.sh              verdict de l'agrégateur macOS de la CI
├── scripts/ci-scope.sh                dit si le diff d'une PR impose de compiler l'app Mac ou l'app iOS
├── scripts/tests-instables-connus.json   tests Swift instables connus, relancés une fois
├── scripts/typecheck.sh               type-check des plugins et de test/ (tsc épinglé)
├── scripts/lint.sh                    lint et format (Biome épinglé), sans réseau
├── scripts/plugin-smoke.ts            charge les plugins dans un vrai OMP
├── scripts/swift-app.sh               tests release puis bundle .app de l'app Mac
├── scripts/ios-build.sh               compile et teste l'app iOS (Xcode)
├── scripts/app-icon.sh                dessine l'icône de l'app
├── scripts/run-console.sh             recompile et relance l'app Mac
├── scripts/recette/                   recettes manuelles, jamais lancées par la CI
├── scripts/mem0-http-contrat.sh       contrat HTTP boîte noire du service mémoire
├── scripts/release.ts                 PR de release, tags et releases au merge
├── scripts/no-manual-bump.sh          refuse un bump de version manuel
└── scripts/release-simulation.sh      simule la release d'une PR sur une copie jetable
```

## Tests et scripts

La suite node vit dans `test/`, rangée par **ce qu'elle éprouve** ; un fichier =
une feature (son slug), et un id `<slug>/AC-<n>` ne vit que dans un test
(`criteria/AC-13`) :

| Dossier | Ce qu'il éprouve |
|---|---|
| `test/memoire/` | le plugin `omp-mem0-memory` (rappel, brief, outils mem0) |
| `test/req/` | le plugin `omp-mem0-req`, client du harness |
| `test/harness/` | le harness du VPS : machine à états, orchestrateur, API, heavy, git, déploiement |
| `test/console/` | les sources d'OMP Console — gardes textuelles Mac et iOS (`ios-*`), noyau partagé, coque iOS |
| `test/stack/` | `mem0-stack` : mem0-rs, contrat boîte noire, migration, `doctor.sh` |
| `test/outillage/` | l'outillage du dépôt : `check.sh`, CI, release, smoke des plugins, documentation |
| `test/support/` | les modules partagés, jamais lancés seuls (pas de `.test.ts`) : `repo.ts` (racine, liste des tests, dossiers jetables, copie du dépôt, environnement des enfants), `git.ts` (dépôts git jetables), `spawn.ts` (processus enfants en parallèle), `swift-source.ts` (sources Swift sans commentaires, lexer de littéraux), `harness-fixtures.ts` et `fake-omp-rpc.ts` (harness complet aux runners factices), `fake-zod.ts`, `doctor-banc.ts` |

Un test neuf va dans le dossier de ce qu'il éprouve, sans liste à tenir :
`scripts/test-files.sh` les découvre récursivement. Un helper utile à plusieurs
fichiers va dans `test/support/`, jamais recopié d'un fichier à l'autre.

```bash
npm test                                                        # = bash scripts/check.sh --sections=tests (section ── Tests)
node --test --experimental-strip-types 'test/**/*.test.ts'      # toute la suite
node --test --experimental-strip-types test/req/client-harness.test.ts   # un fichier
bash scripts/test-files.sh --scope=changed | xargs node --test --experimental-strip-types   # les tests du diff
npm run -s test:touched -- omp-harness/verdict.ts               # les tests que ces fichiers concernent
bash scripts/test-ac.sh AC-1 AC-2                                # preuve par critère
```

`scripts/test-files.sh --scope=changed[=<base>]` (base `HEAD`) retient : (a) les
`test/**/*.test.ts` du diff (`git diff --name-only` + non suivis) ; (b) tout test dont le texte
nomme un fichier du diff par son nom de base (`chain.ts`, `README.md`) ou par la fin d'un
import (`/chain"`) ; (b') tout test dont les imports relatifs, suivis de proche en proche,
atteignent un fichier du diff ; (c) les tests `--scope=macos` si le diff touche
`omp-console/` hors `.md` ; (d) la liste complète hors outillage si le diff touche
`scripts/check.sh`, `scripts/test-files.sh`, `package.json`, `tsconfig.json` ou
`tsconfig.test.json`. Sans git, base inconnue ou diff vide : message sur stderr et liste
complète hors outillage. Un diff non vide que nul test ne concerne : message sur stderr,
sortie 0, rien sur stdout. `--macos` (avec `changed` ou `files` seulement) réduit la
sélection aux fichiers de `--scope=macos`. `--scope=outillage` liste les fichiers
qui relancent un `check.sh` complet (`check.test.ts`, `release.test.ts`,
`release-simulation.test.ts`, règle par contenu) : `--scope=changed` ne les inclut
jamais, sauf sous `--with-outillage` (avec `changed` ou `files` seulement), où ils
suivent les mêmes règles et entrent dans les replis ; c'est ce que `check.sh
--tests-base` passe, pour qu'une PR qui touche `scripts/release.ts` lance
`release.test.ts`. `check.sh` sans option les lance toujours.

`scripts/test-files.sh --scope=files <chemins…>` applique les mêmes règles à une liste
reçue en arguments au lieu du diff : c'est l'entrée du harness, qui connaît les fichiers
touchés depuis la base du run. Une liste vide ou des fichiers que nul test ne concerne :
message sur stderr, sortie 0, rien sur stdout. `scripts/test-touched.sh <chemins…>`
(= `npm run test:touched -- …`) lance `node --test --test-reporter=tap` sur cette
sélection, et sort 0 sans rien lancer quand elle est vide.

`scripts/test-ac.sh [--base=<rev>] AC-1 AC-2 …` : pour chaque id, imprime les fichiers de
test **du diff** qui le portent (`AC-1` ≠ `AC-10`) ou `(aucun test dans le diff)`, lance
**une** passe `node --test --test-reporter=tap` sur ces fichiers, puis `AC-n : pass|fail|absent`
(nom de test portant l'id ; un test sauté ne prouve rien) ; sortie 1 dès un `fail` ou un
`absent`.

Les tests de `test/console/` partagent une copie du dépôt par fichier
(`sharedRepo(prefix).fresh()` dans `test/support/repo.ts`, remise à neuf en ≈ 10 ms) au lieu
d'une copie par test. `check.sh` imprime `# skipped N` dans `── Tests`, en succès comme en
échec. Un test qui se saute faute de prérequis installable (outil, toolchain, script
absent) passe par `prerequisAbsent(t, prérequis, conséquence)` de `test/support/prerequis.ts`,
jamais par un `t.skip` nu : c'est ce saut que `--strict` change en échec nommé.

`scripts/` ne garde à sa racine que ce que la CI, la release et le développement
lancent (`check.sh`, `test-files.sh`, `typecheck.sh`, `release.ts`,
`swift-app.sh`, `ios-build.sh`, `run-console.sh`, `mem0-http-contrat.sh`…) ; les
recettes manuelles ou gatées (captures iOS, sondes AX, bascule réelle)
vivent dans `scripts/recette/`.

## CI et release

Chaque PR passe `./scripts/check.sh` sur Ubuntu **et** sur macOS. Le type-check y
couvre les sources des **deux** plugins comme `test/` — deux programmes `tsc` :
`tsconfig.json` pour les plugins (lib ES2023, donc une API ES2024 comme
`Promise.withResolvers` y fait échouer le job) et `tsconfig.test.json` pour la
suite (lib ES2024). Les deux programmes appliquent `strict`, `noUnusedLocals`,
`noUnusedParameters` et `noFallthroughCasesInSwitch` : une variable, un import ou
un paramètre jamais lu (préfixe `_` pour un paramètre imposé par une signature)
et un `case` non vide qui retombe dans le suivant font échouer le job. Ce `tsc`
est TypeScript 5.9.3, installé une fois dans `.typecheck/typescript` (gitignoré)
par `bash scripts/typecheck.sh --prepare` (réseau requis) ; ensuite le type-check
ne touche ni au réseau ni au cache npm. Absent ou d'une autre version, la section
Types rougit en donnant cette commande. La CI la lance avant `check.sh` (étape
« Installer le TypeScript épinglé du type-check ») dans `check`, `macos-tests`,
`release` et `release-simulation`. La validation ne se contente pas de
transpiler les extensions : `scripts/plugin-smoke.ts` charge
**réellement** chaque plugin du catalogue dans un OMP (SDK épinglé sous Bun),
vérifie les commandes enregistrées, invoque `/mem0-status` puis l'outil
`mem0_search` d'un côté, `/req` de l'autre, et exige le résultat observé — le
service mem0 étant remplacé par un stub local, donc sans conteneur ni credential.
Un plugin qui ne répond pas fait échouer le job, et `main` exige ces deux statuts
ainsi que `release-simulation` : le merge est bloqué.

Sur Ubuntu, le job `check` lance `./scripts/check.sh --strict` : ses 13
sections à chaque run ; en pull_request il ajoute `--tests-base=<sha de la base>` et la
section tests se réduit aux fichiers que le diff de la PR concerne, au push vers `main`
la suite node tourne entière (filet des trous de sélection). Les jobs macOS ne tournent
qu'en pull_request, en **parallèle**, sur des runners distincts et sans `needs` entre
eux : `macos-app-swift` (`--sections=app-swift`), `macos-app-ios` (`--sections=app-ios`)
et `macos-tests (1/2)`, `macos-tests (2/2)`. Les deux jobs d'app commencent par
`scripts/ci-scope.sh --base=<sha de la base> app-swift|app-ios` : si rien dans le diff ne
commence par `omp-console/`, `scripts/`, `mem0-stack/` (app Swift seulement) ou
`.github/workflows/check.yml`, l'étape de compilation est sautée et le job reste vert ;
un diff illisible ou vide fait compiler. Mesuré le 2026-10-22, avant ce découpage :
`macos-app-ios` 674 s dont 13 s de tests, `macos-app-swift` 529 s, 16 jobs macOS par
feature pour 5 runners. Dans `macos-app-swift`, quand
`swift test` échoue, `scripts/swift-app.sh` lit les tests tombés. S'ils figurent TOUS
au registre `scripts/tests-instables-connus.json` (consulté par
`scripts/ci-verdict.sh --instables`), il les relance une seule fois
(`swift test --filter`) en les nommant. Tout autre échec reste rouge sans relance :
test non listé, rouge pendant la relance, erreur de compilation, plantage, sortie
illisible ou interruption. Le statut `check (macos-latest)`
est celui d'un job **agrégateur** qui les attend, tourne même quand l'un d'eux
échoue ou est annulé (`if: always()`), et ne réussit que si les trois résultats
valent `success` (`scripts/ci-verdict.sh`) — jamais « skipped », qui compterait
comme passant. `macos-tests` lance `--tests-scope=macos --tests-base=<sha de la base>` :
les fichiers de test qui appellent swift ou xcodebuild (`scripts/test-files.sh --scope=macos` :
nom en `ios-*`, ou mention de `swift`, `swiftc`, `xcodebuild`, `xcrun`, `swift-app.sh` ou
`ios-build.sh`), réduits à ceux que le diff concerne ; un ensemble vide laisse la
section verte. Un nouveau commit sur une PR annule le run `check` en cours de cette PR ;
un run déclenché par un push vers `main` n'est jamais annulé.

**Caches de la CI.** Les jobs qui installent ou compilent restaurent un cache
`actions/cache@v6` avant `check.sh` : `check` et `macos-tests` le cache npm
`~/.npm` (hôte OMP) et le cache cargo (`~/.cargo/registry/index`,
`~/.cargo/registry/cache`, `~/.cargo/git/db` et `mem0-stack/mem0-rs/target`) —
dans `macos-tests`, cargo pour la partie 1/2 seulement ; `macos-app-swift`
le cache cargo (cible release de `swift-app.sh`) ;
`release-simulation` le cache cargo. Plus aucun cache SwiftPM (`.build-app`,
`.build-node`) : restauré, il ne faisait rien gagner. L'agrégateur
`check (macos-latest)` ne cache
rien, `macos-app-ios` non plus : mesuré, un DerivedData `omp-console/.build-ios`
restauré ne fait rien gagner (xcodebuild recompile tout, car les mtimes du checkout
l'invalident, et le démarrage des tests sur simulateur pèse ~235 s). Chaque clé porte
la famille, le job, l'entrée de matrice, l'OS, l'architecture, une empreinte de
la toolchain (version de Node, `rustc -vV`, Swift et Xcode, calculée par l'étape
« Empreinte des toolchains ») et le contenu : hash de `Cargo.lock` et
`Cargo.toml`, de `Package.swift`, ou
la version de l'hôte (`OMP_HOST_VERSION` et `OMP_HOST_TYPES_NODE`, déclarées une
seule fois dans l'`env:` de `check.yml`). Il n'y a pas de `restore-keys` : une
clé changée repart de zéro. Seul un job vert sauvegarde, une PR n'écrit que dans
sa propre portée (elle lit celle de `main`), et aucune commande n'est sautée sur
un cache chaud — `npm install`, cargo et `swift` sont toujours
rejoués et ne réutilisent que ce qui est encore à jour, donc le verdict est celui
d'un run à froid. Côté npm, seul le cache de contenu `~/.npm` est gardé, jamais
`node_modules` : l'hôte s'installe sans lockfile, et un arbre restauré qui
satisfait déjà les plages figerait des dépendances transitives qu'un run à froid
mettrait à jour. Dans `release-simulation`, la copie jetable change de chemin à
chaque run : l'étape de simulation pose `CARGO_TARGET_DIR` sur
`${{ runner.temp }}/cargo-target`, cible stable que le cache restaure et que
`check.sh`, `swift-app.sh` et les tests `test/stack/*` honorent.

Ces jobs pilotent `check.sh` par quatre options, que l'on peut aussi passer en
local — sans option, toutes les sections et toute la suite tournent :

| Option | Effet |
|---|---|
| `--sections=<id>[,<id>…]` | n'exécute que ces sections, dans l'ordre du script : `catalogue`, `noms`, `plugins`, `versions`, `extension`, `types`, `lint`, `rust`, `smoke`, `tests`, `noyau`, `app-swift`, `app-ios` |
| `--tests-scope=macos` | `── Tests` ne lance que les fichiers de `scripts/test-files.sh --scope=macos` |
| `--tests-base=<réf>` | `── Tests` ne lance que les fichiers de `scripts/test-files.sh --scope=changed=<réf> --with-outillage` (avec `--macos` si `--tests-scope=macos`) ; une sélection vide laisse la section verte avec un `·` explicatif ; en vert, la section liste aussi ses tests de 2 s ou plus |
| `--tests-part=1/2` ou `2/2` | `1/2` : les tests `socle-app-swift/*` de `test/outillage/check.test.ts` ; `2/2` : tous les autres — chaque test tourne exactement une fois |
| `--strict` | un test de `test/` sauté faute de prérequis installable (`prerequisAbsent` de `test/support/prerequis.ts`) et les absences que `MEM0_OMP_REQUIRE_SMOKE`/`RUST`/`IOS` durciraient deviennent des échecs nommés ; restent des sauts : plateforme (Swift/iOS hors macOS), copie imbriquée, `MEM0_OMP_SKIP_*` |

Chaque section exécutée se termine par sa durée sur stdout, `  · <n> s` (secondes
entières), pour lire dans un journal de CI où le temps part.

À la racine du dépôt, `package.json` (privé, sans dépendance) donne quatre alias :
`npm run check` lance `bash scripts/check.sh`, `npm run typecheck` lance
`bash scripts/typecheck.sh`, `npm test` lance `bash scripts/check.sh --sections=tests` et
`npm run test:touched -- <fichiers…>` lance `bash scripts/test-touched.sh`.
Les arguments placés après `--` sont transmis tels quels (`npm run check -- --sections=types`,
`npm test -- --tests-part=1/2`) ; `npm test -- --sections=…` est refusé par `check.sh`
(option répétée). Depuis `omp-mem0-req/` ou `omp-mem0-memory/`, npm lit le
`package.json` du plugin, qui n'a pas ces alias.

Chaque PR vers `main` passe aussi `scripts/release-simulation.sh`, qui rejoue la
release de la PR **sur une copie jetable** — plan de `scripts/release.ts`,
écriture des versions, des deux catalogues et de `CHANGELOG.md`, puis
`./scripts/check.sh` limité aux sections que la release peut casser
(`--sections=catalogue,noms,plugins,versions,extension,types,lint,smoke,noyau,tests`
avec `--tests-base=HEAD` : les tests que les fichiers écrits concernent) — sans rien
pousser, sans tag et sans PR. Le job de release lance la même commande. Mesuré le
2026-10-22 avant cette réduction : 18 min, dont 989 s de `check.sh` complet. Son statut,
`release-simulation`, est requis : une PR dont la release simulée échouerait ne
peut pas être fusionnée.

La section `── Lint TypeScript` (id `lint`, juste après `types`) passe
`scripts/lint.sh` : Biome, épinglé dans le script, vérifie à la fois les règles
de lint et le format du TypeScript de `omp-mem0-req/` et `test/`, sans jamais
toucher au réseau. Prérequis, une fois par clone ou par worktree et avec le
réseau : `bash scripts/lint.sh --prepare`, qui installe la version épinglée dans
`.lint/` (ignoré par git). Un outil absent ou d'une autre version rougit la
section avec cette commande — elle n'est jamais sautée. `MEM0_OMP_LINT_DIR`
désigne une installation préparée ailleurs : les `check.sh` imbriqués des tests
et la copie de `scripts/release-simulation.sh` réutilisent ainsi celle de la
racine. Chaque job CI qui lance `check.sh` prépare l'outil juste avant. Pour
corriger en local ce que la section signale :
`.lint/node_modules/.bin/biome check --write omp-mem0-req test`.

La section `── Rust mem0-rs` joue le **contrat boîte noire** de l'API mémoire
(`scripts/mem0-http-contrat.sh --run`) contre mem0-rs : il exerce par HTTP les 9 routes du
serveur (`/health`, add, add_procedure, search, all, graph, PUT, DELETE, history)
et vérifie pour chaque réponse le jeu de clés exact et le type des valeurs. Le
serveur à tester est démarré jetable, sans conteneur : le binaire mem0-rs
(`--start-rs`) sur une base SQLite neuve, et un faux serveur OpenAI-compatible
(embeddings déterministes de 1024 dimensions, réponses chat scriptées), donc ni
oMLX ni la base réelle. Une Qdrant **native** v1.19.0 ne sert plus que de source
aux tests de `mem0-rs import` : elle se prépare une fois, hors du dépôt, par
`bash scripts/mem0-http-contrat.sh --prepare` ; sans elle, ces tests annoncent le
saut en nommant la pièce manquante. La CI la prépare avant `check.sh` (étape
« Préparer la Qdrant source des tests d'import mem0-rs ») et pose
`MEM0_OMP_REQUIRE_RUST=1` : une pièce manquante ou un cas en échec y rougit le
job. Variables lues :

| Variable | Effet |
|---|---|
| `MEM0_CONTRAT_URL` | URL de base `http://<hôte>:<port>` du serveur à tester |
| `MEM0_CONTRAT_START` | commande shell qui démarre le serveur à tester (défaut : `bash scripts/mem0-http-contrat.sh --start-rs`) |
| `MEM0_CONTRAT_EXTERNE` | `1` accepte une URL sans commande de démarrage (instance externe, vide exigée) |
| `MEM0_CONTRAT_TOKEN` | `X-Mem0-Token` envoyé à une instance externe |
| `MEM0_CONTRAT_INFER` | `0` désactive le groupe infer=true (extraction LLM) |
| `MEM0_CONTRAT_OPENAI_PORT` | port fixe du faux serveur OpenAI (libre par défaut) |
| `MEM0_CONTRAT_OPENAI_HOTE` | adresse IPv4 d'écoute du faux serveur OpenAI (défaut `127.0.0.1`, sinon refus en code 3) |
| `MEM0_CONTRAT_MOTEUR` | moteur de `--start-conteneur` (défaut : `podman` s'il est sur le PATH, sinon `docker`) |
| `MEM0_CONTRAT_QDRANT` | binaire Qdrant à utiliser à la place de celui du cache |
| `MEM0_CONTRAT_RANG_FIXTURE` | fixture de rang à utiliser à la place de `scripts/mem0-http-contrat/rang.json` |
| `MEM0_RS_BIN` | binaire démarré par `--start-rs` (défaut : `${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}/debug/mem0-rs`) |

`--start-qdrant` lance une Qdrant native jetable sur `MEM0_CONTRAT_PORT` (HTTP)
et `MEM0_CONTRAT_GRPC_PORT`, stockage dans `$MEM0_CONTRAT_WORKDIR/qdrant`, clé
API fixe `contrat-qdrant-cle` ; l'appelant attend `/readyz`. La preuve de
migration `test/stack/mem0-rs-migration.test.ts` y sème la collection `omp_memory` et
écrit à côté un `history.db`, puis les importe par `mem0-rs import`.

`--start-conteneur` démarre le service mem0-rs de `mem0-stack/docker-compose.yml`
(image `mem0-rs:local` déjà construite, sinon code 2) sous le projet
`mem0-contrat-<port>`, avec un volume nommé que l'arrêt efface (`down -v`) :
c'est la preuve locale du conteneur, jamais jouée en CI.

Les **preuves conteneur** de la bascule vivent dans
`test/stack/mem0-stack-bascule-rust.test.ts`, sautées sans leur drapeau et jamais
jouées en CI. Moteur : `MEM0_CONTRAT_MOTEUR`, sinon `podman`, sinon `docker` ;
le test refuse un moteur qui porte des conteneurs `omp-console-*`. Elles
construisent l'image par `compose build mem0-rs` et ne publient que des ports
libres (jamais 8321 ni 6333) :

- `MEM0_BASCULE_CONTENEUR=1` : un souvenir survit à `down`/`up` du conteneur, la
  base apparaît dans le dossier de l'hôte (AC-2), puis le contrat boîte noire
  passe contre `--start-conteneur` (AC-3) ;
- `MEM0_BASCULE_REEL=1` avec `MEM0_BASCULE_HISTORY_DB=<copie de history.db>` :
  répétition à blanc de la migration de `mem0-stack/README.md` sur une réplique
  de la vraie Qdrant, puis comparaison du nombre de souvenirs et des têtes de
  recherche avec la pile d'omp-console, qui n'est lue que par `inspect` et HTTP
  (AC-11, AC-12). La copie se fait par
  `"$HOME/Library/Application Support/com.omp.console/components/podman/6.1.3/bin/podman" --url "unix://$TMPDIR/podman/omp-console-api.sock" cp omp-console-mem0-http:/home/mem0/.mem0/history.db <copie>`.

```bash
export PATH=/opt/podman/bin:$PATH && podman machine start
MEM0_BASCULE_CONTENEUR=1 node --test --experimental-strip-types test/stack/mem0-stack-bascule-rust.test.ts
MEM0_BASCULE_REEL=1 MEM0_BASCULE_HISTORY_DB=<copie> node --test --experimental-strip-types test/stack/mem0-stack-bascule-rust.test.ts
podman machine stop
```

Le contrat joue aussi une phase **`rang`**, sur une instance neuve (l'IDF du BM25
ne voit que ce corpus) : la fixture commitée `scripts/mem0-http-contrat/rang.json`
porte un petit corpus, des requêtes et, capturés sur l'ancien mem0-http Python
(mem0 2.2.1), l'ordre des ids rendus par chaque recherche (`attendu`) et les
arêtes du graphe. Toute divergence d'ordre, un `semantic_score` qui n'est pas le
cosinus brut du faux embedder, un souvenir lexical rendu malgré `threshold` ou
une arête différente fait échouer le run : c'est la preuve de parité de mem0-rs.
La phase est sautée en mode externe ; une fixture illisible ou non capturée est
un refus (code 3). La fixture n'est plus recapturée : le Python qui servait de
référence est retiré.

Viser mem0-rs (binaire construit par `cargo build --manifest-path
mem0-stack/mem0-rs/Cargo.toml --locked`), sans toucher à cas.ts :

```bash
MEM0_CONTRAT_START="bash scripts/mem0-http-contrat.sh --start-rs" bash scripts/mem0-http-contrat.sh --run
```

`--start-rs` démarre le binaire sur une base SQLite neuve du répertoire de travail
de la phase ; binaire absent → `non exécuté : binaire mem0-rs absent (<chemin>)`, code 2.

La section `── Rust mem0-rs` (id `rust`, juste après `lint`) éprouve la crate
`mem0-stack/mem0-rs` : `cargo clippy --all-targets -- -D warnings` (aucun
avertissement toléré), `cargo test`, `cargo build`, puis ce même contrat contre le
binaire construit, groupe infer=true compris. Les trois étapes cargo tournent même si
l'une échoue, et leur sortie n'est imprimée qu'en cas d'échec ; la commande à
relancer est donnée par chaque ✗. Sans `cargo` (ou sans clippy) dans le `PATH`, la
section annonce le saut sans ✓ et ne fait rien échouer sur un poste ; la CI installe
clippy (`rustup component add clippy`) et pose `MEM0_OMP_REQUIRE_RUST=1`, qui
change ce saut en échec. `MEM0_OMP_SKIP_RUST` non vide ignore la section : les
copies jetables des tests le posent.

Un merge sur `main` déclenche `.github/workflows/release.yml`. Le job ne pousse
**jamais** directement sur `main` (la protection de branche refuse un commit neuf
sans statuts) : il ouvre une PR de release, attend que les trois statuts passent,
la fusionne en squash, puis pousse les tags `<plugin>-v<version>` et publie les
releases GitHub. Les versions elles-mêmes sont décidées **par le job** — `fix` ⇒
patch, `feat` ⇒ mineure, rupture déclarée ⇒ majeure, d'après les commits touchant
chaque plugin — et non par la PR mergée : personne ne monte une version à la main
(une PR qui le tente échoue en CI). `CHANGELOG.md` est écrit au même moment, une
section datée par version publiée, et les versions historiques jamais publiées sont
rattrapées par le même run. Le jeton dédié que ce job exige, ses permissions et sa
création sont dans `PUBLISHING.md` § Jeton de release ; les règles de décision, le
flux en six étapes et la commande de protection de branche aussi.

## L'API d'extension d'OMP à surveiller

L'API d'extension bouge vite. Trois points, tous signalés par un warning plutôt que
par une erreur :

- `event.prompt` sur `before_agent_start`, et la forme du retour
  `{ message: { customType, content, display, attribution } }`.
- `event.systemPrompt` (`string[]`) et `event.content` / `event.input` /
  `event.isError` sur `tool_result` — c'est par là que passent le sommaire et
  l'agrafage. Un retour de `tool_result` REMPLACE le contenu du résultat : le handler
  reconstruit toujours `[bloc mémoire, ...event.content]`.
- `SessionStopEventResult` (`{ continue, additionalContext }`) pour la relance de fin
  de session ; le runtime plafonne les continuations, et l'extension n'en demande
  qu'une par session.
- `pi.zod` : depuis la v17.2.10, zod est remplacé par `omptype` avec une façade de
  compatibilité. L'usage ici est basique et devrait passer ; si un `registerTool`
  échoue au chargement, c'est le premier endroit à regarder.
- `pi.sendUserMessage(content)` et `ctx.waitForIdle()`, utilisés par `/mem0-init`.
  Si la relecture ne démarre pas, `/mem0-init --scan-only` reste utilisable et tu
  peux coller le prompt à la main.

L'event `session_start` n'est pas critique : si ta version ne l'émet pas, le premier
`before_agent_start` fait la même vérification.
