# mem0-omp

Tu décris une feature. Un serveur la mène seul jusqu'au merge : specs, code, tests,
revue. Il ne te dérange que pour ce qui le mérite. Et chaque agent, sur ton Mac comme
sur le serveur, connaît les décisions déjà prises dans le projet.

mem0-omp ajoute trois choses à [OMP](https://omp.sh), l'agent de code :

- **Une mémoire par projet** (plugin `omp-mem0-memory`). À chaque tour, l'agent
  reçoit les souvenirs utiles : stack, conventions, décisions d'architecture et leur
  raison, bugs déjà résolus. Il écrit lui-même ce qui restera vrai.
- **Un serveur de pipelines** (`omp-harness`, sur un VPS). `/req` cerne le besoin
  avec toi, puis le serveur enchaîne `/specs → /impl → /review → merge`, plusieurs
  features en parallèle, la nuit comme le jour, sans que ton Mac reste allumé.
- **Une app Mac et iPhone** (OMP Console) pour répondre aux questions du serveur,
  valider, suivre et lancer le travail.

## Pourquoi

Un agent de code laissé seul a trois défauts : il oublie tout d'une session à
l'autre, il s'arrête pour te demander chaque détail, ou il fonce sans garde-fou.
mem0-omp traite les trois.

- **Il se souvient.** La mémoire est partagée par tes sessions et par les agents du
  serveur. Une correction que tu fais une fois, avec sa raison, est rappelée ensuite
  à chaque agent qui touche au sujet.
- **Il avance sans toi.** Ce que les specs ne tranchent pas, l'agent le tranche en
  prenant l'option la plus réversible, et note un point de reprise. Tu relis le
  matin et tu renverses ce qui ne te va pas : seul ce qui en découle est refait.
- **Il s'arrête là où il faut.** Un schéma de données, une API publique ou une
  suppression de données ne se décident jamais sans toi. Tu valides aussi les specs
  avant le code, et chaque merge qui n'est pas à faible risque.
- **Il reste borné.** Chaque étape tourne dans un process isolé et plafonné en
  mémoire. Les tests tournent sans réseau ni clé, sous un utilisateur dédié. Un
  agent détourné ne peut ni valider son propre travail ni toucher au serveur.

## Comment ça marche

```
  Mac                                        VPS (Debian, Ubuntu ou NixOS)
 ┌───────────────────────────┐   HTTPS    ┌────────────────────────────────────┐
 │ omp + les deux plugins    │──────────▶ │ omp-harness : API, base SQLite     │
 │   /req /project /audit    │ (Tailscale)│   ├ un agent omp par étape         │
 │ OMP Console (l'app)       │──────────▶ │   ├ les tests, isolés par systemd  │
 └───────────────────────────┘            │   └ mem0-rs : la mémoire du projet │
  iPhone : OMP Console ──────────────────▶└────────────────────────────────────┘
                                                        │ merge, puis push
                                                        ▼
                                                 ton dépôt (GitHub)
```

Une feature suit toujours le même chemin :

1. **`/req`**, dans ta session : l'agent te pose ses questions une à une et rédige
   le compte rendu de besoins. Tu le valides, il part au serveur.
2. **`/specs`** : le serveur écrit les specs et leurs critères d'acceptation.
   **Tu les valides** dans l'app (ou tu les refuses avec une raison).
3. **`/impl`** : le code, avec un test par critère.
4. **`/review`** : un autre agent relit le diff, lance toute la suite de tests et
   rend un verdict. S'il trouve des points bloquants, une correction repart, puis une
   nouvelle revue.
5. **Merge** : automatique si le risque est faible, la suite verte et le diff court.
   Sinon, c'est toi qui valides.

## Installation

Il te faut :

- **Un VPS Linux**, x86_64 ou arm64, avec Docker ou podman (ou systemd : Debian 12+,
  Ubuntu 24.04+, NixOS). Par défaut le serveur réserve 16 Go de mémoire : prévois 32 Go, ou réduis
  `runner.slots` et `heavy.slots`.
- **Tailscale** sur le VPS, le Mac et l'iPhone, dans le même tailnet.
- **Un compte LLM** pour les agents du serveur : une clé d'API (Anthropic par
  exemple) ou un `/login` d'OMP.
- **Un serveur d'embeddings compatible OpenAI**, joignable en permanence par le VPS :
  oMLX sur un homelab, ou un fournisseur. La mémoire en a besoin.
- **Un Mac Apple Silicon** sous macOS 26, avec Xcode et Rust pour assembler l'app.
- **Tes dépôts** sur GitHub, ou sur tout serveur git joignable en SSH.

Compte une heure, dans l'ordre : le serveur, le Mac, l'iPhone, puis la
vérification. Les mises à jour suivent [PUBLISHING.md](PUBLISHING.md) § « Mettre à
jour » pour les plugins, et `omp-harness/README.md` § « Mettre à jour » pour le
serveur.

### 1. Le serveur

Le plus simple : en conteneurs, avec Docker ou podman, sur n'importe quel VPS (ou sur
ton Mac). Depuis un clone de ce dépôt :

```bash
git clone https://github.com/millianlmx/mem0-omp && cd mem0-omp
bash omp-harness/deploy/container/harness.sh up
```

Le script construit les images, démarre le service et sa mémoire, puis affiche les
gestes qui restent : la clé de déploiement à ajouter sur ton dépôt, son clone, la
configuration, les comptes LLM, le serveur d'embeddings et la vérification. Sans
moteur de conteneurs, `sudo bash omp-harness/deploy/install.sh` installe la même
chose avec systemd (Debian, Ubuntu), et NixOS a un module déclaratif. Tout est
détaillé dans [omp-harness/README.md](omp-harness/README.md) § « Installer le
serveur ».

Une fois le service démarré, publie l'API sur ton tailnet et note son jeton
(`harness.sh token`, ou `sudo cat /var/lib/omp-harness/state/token` avec systemd) :

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8790
```

### 2. Le Mac : l'app OMP Console

L'app se construit depuis ce dépôt, en une commande (Xcode et Rust requis) :

```bash
bash scripts/swift-app.sh
open "omp-console/build/OMP Console.app"
```

Au premier lancement, elle installe son omp (18.6.0, la même version que le
serveur) et démarre son service mémoire local, sans rien d'autre à installer. Puis
le bouton **Serveur** de la barre d'outils demande l'adresse
`https://<vps>.<tailnet>.ts.net` et le jeton noté à l'étape 1. Le détail de l'app :
[omp-console/README.md](omp-console/README.md).

L'app n'installe pas les plugins : c'est l'étape 3, « Les plugins seuls ».

### Sans l'app : la pile conteneur

Pour une autre machine que ton Mac (Linux, Mac Intel), le service mémoire tourne
dans un conteneur que tu démarres toi-même :

```bash
git clone https://github.com/millianlmx/mem0-omp
cd mem0-omp/mem0-stack
cp .env.example .env        # ajuste OMLX_BASE_URL selon podman/docker
mkdir -p mem0-rs-data       # dossier de la base SQLite (MEM0_RS_DATA_DIR)
podman compose up -d        # ou: docker compose up -d
./doctor.sh
```

`doctor.sh` teste toute la chaîne (conteneur, port, oMLX, aller-retour
écriture/relecture) et dit quoi faire à chaque échec. Une ancienne pile mem0-http se
migre avant de démarrer celle-ci :
[mem0-stack/README.md](mem0-stack/README.md#migrer-une-pile-mem0-http-existante).

### 3. Les plugins seuls

Les plugins s'installent dans OMP, une seule fois, depuis une session :

```
/marketplace add millianlmx/mem0-omp
/marketplace install omp-mem0-memory@mem0-omp
/marketplace install omp-mem0-req@mem0-omp
```

Puis **relance `omp`** : `/reload-plugins` ne recharge pas les modules d'extension.
En ligne de commande : `omp plugin marketplace add millianlmx/mem0-omp`, puis
`omp plugin install omp-mem0-memory@mem0-omp` et
`omp plugin install omp-mem0-req@mem0-omp` (`--scope project` pour un seul projet).
Sans marketplace, `omp-mem0-memory/install.sh` dépose l'extension mémoire dans
`~/.omp/agent/extensions/`.

Il n'y a **rien à faire par projet** : le plugin mémoire pose son brief au premier
démarrage dans chaque dépôt. Il parle au service de `MEM0_HTTP_URL` :

- **Service déjà joignable** (l'app, la pile conteneur, ou la mémoire du serveur,
  voir l'étape 4) : rien de plus, `/mem0-status` le confirme.
- **Aucun service** : le plugin se dégrade proprement. Le rappel est vide, les
  écritures sont refusées avec un avertissement, aucune session n'est bloquée.

### 4. Relier le Mac au serveur

**Les pipelines.** `/req`, `/project` et `/audit` envoient le travail au serveur.
Crée `~/.omp/harness.json` :

```json
{ "url": "https://vps.tailnet.ts.net", "token": "<le jeton de l'étape 1>",
  "repos": { "/Users/toi/code/mon-produit": "mon-produit" } }
```

`repos` associe un dossier du Mac au nom du dépôt déclaré sur le serveur. Sans
entrée, c'est le nom du dossier qui sert.

**Une seule mémoire.** Sans ce geste, ton Mac et le serveur ont chacun leur mémoire,
et les agents du serveur ignorent ce que tu as appris en session. Publie celle du
serveur sur le tailnet :

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8321
grep MEM0_HTTP_TOKEN ~/.omp-harness-secrets/mem0.env   # avec systemd : sudo grep … /etc/omp-harness/mem0.env
```

Puis, sur le Mac, crée `~/.omp/mem0.json`. Le plugin mémoire et l'app le lisent
tous les deux, et `MEM0_HTTP_URL` l'emporte s'il est posé :

```json
{ "url": "https://vps.tailnet.ts.net:8443", "token": "<le jeton ci-dessus>" }
```

Tu as déjà des souvenirs sur le Mac ? Copie sa base sur le serveur avant d'y écrire
quoi que ce soit (même modèle d'embedding des deux côtés, `EMBEDDING_DIMS`) :

```bash
sqlite3 ~/Library/Application\ Support/com.omp.console/mem0-rs/mem0-rs.db ".backup /tmp/mem0-rs.db"
scp /tmp/mem0-rs.db <vps>:/tmp/
```

Puis, sur le VPS : `omp-harness/README.md` § « La mémoire du projet », « Reprendre
la mémoire du Mac ».

Relance l'app : sa section **Mémoire** montre alors la mémoire du serveur, et
`/mem0-status` dans une session affiche la même adresse.

### 5. L'iPhone

L'app iOS se construit avec Xcode sur ton iPhone branché au Mac (Mode développeur,
ton compte de signature) : [omp-console/README.md](omp-console/README.md) § « Coque
iOS », puis « Installer sur un appareil réel ». Le code est dans `omp-console/ios/`.
Au lancement, **Serveur** demande la même adresse et le même jeton que sur le Mac.

### 6. Vérifier

```bash
bash omp-harness/deploy/container/harness.sh check   # sur le VPS, en conteneurs
sudo omp-harness-check                               # ou avec systemd
```

Chaque ligne dit ✓, ou ✗ avec le geste qui corrige : omp, modèles, mémoire, chaque
dépôt et l'écriture sur son distant (un essai à blanc, rien n'est poussé).

Puis sur le Mac, dans un de tes dépôts :

1. `omp`, puis `/mem0-status` : le service répond et le projet est le bon.
2. « Note que le linter de ce projet est Ruff » : l'agent appelle `mem0_add`.
   Dans une nouvelle session, « quel linter on utilise ? » : la réponse vient de la
   mémoire, sans lire de fichier.
3. `/pipelines` : la boîte du serveur s'affiche, vide.
4. `/req ajouter un fichier CONTRIBUTORS` : après tes réponses, la feature part.
   L'app la montre dans **Pipelines**, puis ses specs à valider dans **Accueil**.

## Au quotidien

| Commande | Ce qu'elle fait |
|---|---|
| `/req [demande]` | Cerne le besoin avec toi, une question à la fois, sans concevoir la solution. Une fois le compte rendu validé, la feature part au serveur, qui commence par /specs. |
| `/project [description]` | Découpe un projet en features autonomes. Celles qui touchent des modules différents tournent en parallèle, chacune mergée dès sa validation. |
| `/audit [focus]` | Un agent lit la branche principale sans rien modifier, puis propose des faiblesses à corriger et des features. `/audit liste` les montre, `/audit lancer <id> 1,3` lance celles retenues. |
| `/pipelines` | La boîte de l'humain : questions en attente, specs et verdicts à valider, décisions à relire, features en cours. |

**Changer de backend.** La même pile tourne sur le VPS et sur ton Mac. Sur le Mac,
`harness.sh up` puis `harness.sh connect` font viser la pile locale par les plugins et
l'app (pipelines et mémoire) ; `harness.sh disconnect` les ramène au VPS. Détails :
`omp-harness/README.md` § « En conteneurs ».

OMP te demande ton accord avant chaque envoi au serveur, même en mode yolo. Tout le
reste se fait dans l'app, sur le Mac ou l'iPhone :

- **Accueil** : répondre aux questions irréversibles, valider ou refuser les specs et
  les verdicts, relire les décisions que les agents ont prises seuls. Un renversement
  ne refait que ce qui découle de la décision.
- **Pipelines, Projet, Audit** : lancer et suivre.
- **Statistiques** : taux de merge, délais, corrections, état du serveur.

Le serveur choisit le modèle de chaque étape : un gros modèle pour `/req`, `/specs`
et `/review`, un modèle moyen pour `/impl` et les corrections. Ça se règle dans sa
configuration (`stepTiers`).

## La mémoire

| Quand | Ce qui se passe |
|---|---|
| Premier démarrage dans un dépôt | Le plugin écrit `.omp/mem0-brief.md` et ajoute à `AGENTS.md` un bloc qui le cite : quoi mémoriser, quoi ne pas mémoriser. Une seule fois. |
| Chaque tour | Les souvenirs proches de ta demande sont injectés, filtrés par un plancher de pertinence. Le sommaire de la mémoire part dans le prompt système : exhaustif tant qu'il n'est pas tronqué (60 entrées), au-delà de quoi il dit ce qui manque et invite à `mem0_search`. |
| Chaque `read`, `grep`, `edit`… | Le souvenir qui concerne le fichier ou le symbole est posé en tête du résultat, une fois par argument. |
| Fin de session | Si la session a produit du durable sans rien mémoriser, une relance unique demande à l'agent de l'écrire. |
| À la demande | Les outils `mem0_search`, `mem0_add`, `mem0_update`, `mem0_forget`. |

La mémoire est **cloisonnée par projet**. Le nom vient de `MEM0_PROJECT_ID`, sinon du
manifeste à la racine (`package.json`, `pyproject.toml`, `Cargo.toml`,
`Package.swift`, `*.xcodeproj`), sinon du dossier. Deux projets ne doivent jamais
porter le même nom : `/mem0-status` affiche celui qui est retenu. Une seconde portée,
`global`, garde tes préférences valables partout.

Le plugin n'écrit jamais hors d'un dépôt git, complète `AGENTS.md` sans l'écraser et
ne remplace jamais un brief que tu as modifié : `/mem0-brief --update` est le seul
chemin qui le réécrit. `MEM0_AUTOSETUP=0` coupe toute écriture.

Les commandes :

- `/mem0-status` : connexion, projet résolu, état du brief, compteurs de la session.
- `/mem0-init` : amorce un dépôt existant. Il relève l'empreinte technique sur disque
  (dépendances, outillage, CI), puis demande à l'agent de lire la doc et le code et
  d'enregistrer au plus 12 souvenirs vérifiés. `--scan-only` s'en tient à
  l'empreinte, `--force` réamorce.
- `/mem0-brief` : état du brief ; `--update` le réécrit à la version courante.
- `/mem0-dedupe` : repère les souvenirs redondants. Simulation par défaut ; rien
  n'est supprimé sans `--apply`, et l'aperçu montre le texte intégral de ce qui
  serait détruit.
- `/mem0-purge-procedures` : supprime les anciens souvenirs « procéduraux ».
  Simulation par défaut, `--apply` pour supprimer.
- `/mem0-save` : fait écrire maintenant ce que la session a produit de durable.
- `/add-phase`, `/set-phase`, `/remove-phase` : un rôle nommé (`release`,
  `deploy`…) dont l'agent relit les instructions en mémoire en fin de session.

## Config

| Variable | Défaut | Rôle |
|---|---|---|
| `MEM0_HTTP_URL` | `~/.omp/mem0.json`, sinon `http://localhost:8321` | l'adresse du service mémoire |
| `MEM0_HTTP_TOKEN` | celui de `~/.omp/mem0.json`, sinon vide | envoyé en `X-Mem0-Token` quand le service en exige un |
| `MEM0_PROJECT_ID` | — | force le nom du projet |
| `MEM0_AUTOSETUP` | `1` | `0` : le plugin n'écrit jamais dans un dépôt |
| `MEM0_QUIET` | `0` | `1` : souvenirs injectés sans être affichés |
| `MEM0_NUDGE` | `1` | `0` : pas de relance d'écriture en fin de session |
| `HARNESS_URL`, `HARNESS_TOKEN` | — | le serveur et son jeton ; à défaut, `~/.omp/harness.json` |
| `HARNESS_REPO` | nom du dossier | le nom du dépôt déclaré sur le serveur |

La configuration du serveur (dépôts, modèles, plafonds) est décrite dans
[omp-harness/README.md](omp-harness/README.md) § « Configuration ».

## Dépannage

- **Sur le VPS, commence toujours par la vérification** : `harness.sh check` en
  conteneurs (puis `harness.sh logs`), `sudo omp-harness-check` avec systemd (puis
  `journalctl -u omp-harness -e` et `journalctl -u omp-harness-mem0 -e`).
- **Un merge n'arrive pas sur GitHub** : l'événement `push_failed` du run en donne la
  raison. Le plus souvent, la clé de déploiement est en lecture seule.
- **`/req` dit « harness non configuré »** : `~/.omp/harness.json` manque, ou
  `HARNESS_URL` et `HARNESS_TOKEN` sont vides dans cette session.
- **`/mem0-status` en rouge avec la pile conteneur** :
  `cd mem0-stack && ./doctor.sh`. « socket connection was closed unexpectedly »
  veut dire que le conteneur redémarre en boucle (`podman logs --tail 80 mem0-rs`).
  Deux causes couvrent presque tout : oMLX injoignable depuis le conteneur (il faut
  `host.containers.internal` ou `host.docker.internal`, et oMLX à l'écoute sur
  `0.0.0.0`), ou un `EMBEDDING_DIMS` différent de celui de la base.
- **L'agent ignore un souvenir** : le sommaire est exhaustif tant qu'il n'est pas
  tronqué (60 entrées) ; au-delà, l'agent doit passer par `mem0_search`. Vérifie
  aussi le projet résolu dans `/mem0-status`.

## Le dépôt

```
mem0-omp/                              racine = marketplace OMP
├── .omp-plugin/marketplace.json       catalogue (repli : .claude-plugin/)
├── omp-mem0-memory/                   le plugin mémoire (un module par responsabilité, install.sh)
├── omp-mem0-req/                      le plugin des pipelines : client du serveur (/req, /project, /audit, /pipelines)
├── omp-harness/                       le serveur de pipelines du VPS
│   └── deploy/                        conteneurs (harness.sh, compose), install.sh et systemd, module NixOS
├── omp-console/                       l'app macOS (SwiftUI), le noyau partagé et l'app iOS
│   └── ios/                           le projet Xcode de l'app iOS
├── mem0-stack/                        la pile conteneur du service mémoire
│   └── mem0-rs/                       le serveur mémoire (Rust + SQLite)
├── test/                              la suite node --test
├── scripts/check.sh                   la validation avant publication
├── scripts/test-files.sh              liste les fichiers de test : tous, macOS, du diff, outillage
├── scripts/test-ac.sh                 preuve par critère : les tests du diff qui portent AC-n
├── scripts/ci-verdict.sh              verdict de l'agrégateur macOS de la CI
├── scripts/tests-instables-connus.json   tests Swift instables connus, relancés une fois
├── scripts/typecheck.sh               type-check des plugins et de test/ (tsc épinglé)
├── scripts/lint.sh                    lint et format (Biome épinglé), sans réseau
├── scripts/plugin-smoke.ts            charge les plugins dans un vrai OMP
├── scripts/swift-app.sh               tests release puis bundle .app de l'app Mac
├── scripts/ios-build.sh               compile et teste l'app iOS (Xcode)
├── scripts/app-icon.sh                dessine l'icône de l'app
├── scripts/run-console.sh             recompile et relance l'app Mac
├── scripts/recette/                   recettes manuelles, jamais lancées par la CI
├── scripts/omp-console-api.ts         sonde de l'API distante de l'app Mac
├── scripts/mem0-http-contrat.sh       contrat HTTP boîte noire du service mémoire
├── scripts/release.ts                 PR de release, tags et releases au merge
├── scripts/no-manual-bump.sh          refuse un bump de version manuel
└── scripts/release-simulation.sh      simule la release d'une PR sur une copie jetable
```

Les règles de contribution sont dans [CONTRIBUTING.md](CONTRIBUTING.md), le détail
des tests, de la CI et de la release dans [DEVELOPPEMENT.md](DEVELOPPEMENT.md).

## Tests et scripts

Un fichier de test par feature, rangé sous `test/` selon ce qu'il éprouve ; chaque
critère `<slug>/AC-<n>` n'est porté que par un test. `scripts/check.sh` est le seul
juge avant de pousser. À la racine, `package.json` donne trois alias :
`npm run check` lance `bash scripts/check.sh`, `npm run typecheck` lance
`bash scripts/typecheck.sh` et `npm test` lance `bash scripts/check.sh --sections=tests`.

```bash
npm run check                                                   # tout
bash scripts/test-files.sh --scope=changed | xargs node --test --experimental-strip-types   # les tests du diff
```

Le reste (dossiers, options de `check.sh`, contrat du service mémoire, preuves
conteneur) : [DEVELOPPEMENT.md](DEVELOPPEMENT.md).

## CI et release

Chaque PR passe `scripts/check.sh` sur Ubuntu et sur macOS, plus une simulation de sa
release. Après le merge, un job ouvre la PR de release, décide les versions d'après
les commits, écrit `CHANGELOG.md`, puis pousse les tags : rien n'est jamais poussé
directement sur `main`, et personne ne monte une version à la main. Le jeton que ce
job exige est décrit dans `PUBLISHING.md` § Jeton de release.
