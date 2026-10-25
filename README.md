# mem0-omp

Tu décris une feature à ton agent de code. Un serveur la mène jusqu'au merge :
specs, code, tests, revue. Toi, tu valides les specs et les choix qui engagent,
depuis ton Mac ou ton iPhone. Et d'une session à l'autre, l'agent se souvient de
ton projet.

mem0-omp s'installe par-dessus [OMP](https://omp.sh), l'agent de code.

## À quoi ça ressemble

Le soir, dans ton dépôt :

```
/req exporter les factures en CSV
```

L'agent te pose quelques questions (quelles colonnes ? quel séparateur ?), tu
réponds, et la demande part au serveur. Ton Mac peut s'éteindre.

Le lendemain matin, l'app te montre les specs à valider. Tu valides. Le serveur
écrit le code et un test par critère, puis un second agent relit le tout et lance
la suite de tests. Si le risque est faible, il merge seul. Sinon, il attend ton
feu vert.

Tout ce que l'agent a tranché sans toi est listé. Si un choix ne te va pas, tu le
renverses, et seul ce qui en dépend est refait.

## Pourquoi l'essayer

- **Ton agent n'oublie plus.** Stack, conventions, bugs déjà corrigés, décisions
  et leur raison : il les retrouve à chaque session. Tu corriges une fois.
- **Le travail avance sans toi.** Plusieurs features en parallèle, la nuit
  comme le jour, sur un serveur.
- **Tu gardes la main.** Un schéma de données, une API publique ou une
  suppression de données ne se décident jamais sans toi.
- **C'est cloisonné.** Chaque étape tourne isolée, et les tests tournent sans
  réseau ni clé d'API.

## Installation

Choisis ta formule :

| Tu veux | Il te faut | Étapes |
|---|---|---|
| Tout : pipelines, mémoire, apps | un VPS et un Mac | 1, 2, 3, 4 |
| Tout, sans VPS, hors ligne compris | un Mac Apple Silicon, Docker et oMLX | 1 (en local), 2, 3, 4 |
| La mémoire seule | omp | 2 (ou la pile conteneur), 3 |

Pour la formule complète :

- un VPS Linux (x86_64 ou arm64) avec Docker ou podman, 32 Go de mémoire
  conseillés ;
- [Tailscale](https://tailscale.com) sur le VPS, le Mac et l'iPhone, dans le
  même réseau ;
- une clé d'API LLM (Anthropic par défaut) ou un compte OMP ;
- un Mac Apple Silicon sous macOS 26, avec Xcode et Rust ;
- tes dépôts sur GitHub, ou sur un serveur git joignable en SSH.

### 1. Le serveur

Sur le VPS :

```bash
git clone https://github.com/millianlmx/mem0-omp && cd mem0-omp
bash omp-harness/deploy/container/harness.sh up
```

`up` demande la clé d'API, démarre le serveur et sa mémoire, puis affiche un
**code d'appairage** `omp1:…`. Garde-le pour les étapes suivantes
(`harness.sh pair` le réaffiche).

Ajoute ensuite chaque dépôt sur lequel le serveur doit travailler :

```bash
bash omp-harness/deploy/container/harness.sh add git@github.com:<toi>/<dépôt>.git
```

S'il ne peut pas pousser sur le dépôt, `add` te donne la clé de déploiement à
coller sur GitHub, avec le lien, et attend.

**Avec Portainer.** Ajoute une stack depuis le dépôt
`https://github.com/millianlmx/mem0-omp` (fichier `docker-compose.yml`), avec
`ANTHROPIC_API_KEY` et `OMP_HARNESS_REPOS` dans ses variables. La pile se monte seule
et se publie par le Tailscale du VPS. La clé de déploiement s'affiche dans les
journaux du conteneur `setup`, le code d'appairage dans ceux de `pairing`. Le détail :
[omp-harness/README.md](omp-harness/README.md) § « Avec Portainer ».

**Sans VPS.** Le même serveur tourne sur ton Mac avec oMLX, sans internet ni clé
d'API. Lance oMLX (port 8000) avec un modèle de code et
`bge-m3`, puis, dans le clone :

```bash
bash omp-harness/deploy/container/harness.sh up --omlx <modèle>
```

Il faut Docker Desktop ou podman, avec 8 Go pour sa VM, plus la place du modèle.
Le détail : [omp-harness/README.md](omp-harness/README.md) § « En conteneurs ».

**Sans conteneurs.** Installation systemd (Debian, Ubuntu) ou module NixOS :
[omp-harness/README.md](omp-harness/README.md) § « Installer le serveur ».

### 2. L'app Mac : OMP Console

Sur le Mac, dans un clone de ce dépôt :

```bash
bash scripts/swift-app.sh
open "omp-console/build/OMP Console.app"
```

Au premier lancement, l'app installe omp. Clique sur **Serveur** dans la barre
d'outils et colle le code d'appairage : l'app, omp et la mémoire de ce Mac sont
reliés au serveur. Le détail : [omp-console/README.md](omp-console/README.md).

L'app n'installe pas les plugins : c'est l'étape 3, « Les plugins dans omp ».

### Sans Mac : la pile conteneur

Pour avoir la mémoire seule sur une autre machine (Linux, Mac Intel), sans app ni
serveur, démarre le service mémoire toi-même :

```bash
git clone https://github.com/millianlmx/mem0-omp
cd mem0-omp/mem0-stack
cp .env.example .env        # ajuste OMLX_BASE_URL
mkdir -p mem0-rs-data
podman compose up -d        # ou : docker compose up -d
./doctor.sh                 # teste toute la chaîne et dit quoi corriger
```

Tu as une ancienne pile mem0-http ? Migre-la d'abord :
[mem0-stack/README.md](mem0-stack/README.md#migrer-une-pile-mem0-http-existante).

### 3. Les plugins dans omp

Dans une session omp :

```
/marketplace add millianlmx/mem0-omp
/marketplace install omp-mem0-memory@mem0-omp
/marketplace install omp-mem0-req@mem0-omp
```

Puis **relance `omp`** (`/reload-plugins` ne suffit pas). En ligne de commande,
c'est `omp plugin marketplace add millianlmx/mem0-omp` puis
`omp plugin install <plugin>@mem0-omp`, avec `--scope project` pour un seul
projet. Sans marketplace, `omp-mem0-memory/install.sh` installe la mémoire seule.

Si tu n'as pas collé le code dans l'app, relie omp au serveur une fois, puis
relance omp :

```
/pair omp1:…
```

Il n'y a rien à faire par projet : au premier démarrage dans un dépôt, le plugin
y pose ses consignes de mémoire.

- **Service mémoire déjà joignable** (serveur, app ou pile conteneur) :
  `/mem0-status` le confirme.
- **Aucun service** : le plugin se dégrade proprement. Pas de souvenirs, un
  avertissement, et aucune session bloquée.

### 4. Vérifier

Sur le VPS :

```bash
bash omp-harness/deploy/container/harness.sh check
```

Avec systemd, c'est `sudo omp-harness-check`. Chaque ligne dit ✓, ou ✗ avec la
commande qui corrige.

Puis sur le Mac, dans un de tes dépôts :

1. Lance `omp`, puis `/mem0-status` : le service répond et le projet est le bon.
2. Dis « Note que le linter de ce projet est Ruff ». Dans une nouvelle session,
   demande « quel linter on utilise ? » : la réponse vient de la mémoire.
3. `/pipelines` : la boîte du serveur s'affiche, vide.
4. `/req ajouter un fichier CONTRIBUTORS` : réponds aux questions, la feature
   part. L'app la montre dans **Pipelines**, puis ses specs à valider dans
   **Accueil**.

### Et ensuite

- **L'iPhone.** L'app iOS se construit avec Xcode (le code est dans
  `omp-console/ios/`) : [omp-console/README.md](omp-console/README.md) § « Coque
  iOS ». Elle prend le même code d'appairage et joint le serveur seule, Mac
  éteint.
- **Des souvenirs déjà sur le Mac ?** Copie-les sur le serveur avant d'y écrire :
  [omp-harness/README.md](omp-harness/README.md) § « La mémoire du projet ».
- **Mettre à jour.** Le serveur : `git pull` puis `harness.sh up`, sans rien
  perdre. Les plugins : [PUBLISHING.md](PUBLISHING.md) § « Mettre à jour ».

## Au quotidien

| Commande | Ce qu'elle fait |
|---|---|
| `/req [demande]` | Cerne le besoin avec toi, puis envoie la feature au serveur. |
| `/project [description]` | Découpe un projet en features qui avancent en parallèle. |
| `/audit [focus]` | Relit la branche principale et propose des corrections et des features. |
| `/pipelines` | Ce qui attend ta réponse : questions, specs, verdicts, décisions. |
| `/harness-follow` | Fait arriver dans la session les nouvelles du serveur. |

Pour répondre au serveur, parle à l'agent en clair : « valide », « réponds B »,
« relance », « annule ». Ou fais-le dans l'app, onglet **Accueil**, sur Mac comme
sur iPhone. omp te demande toujours ton accord avant de lancer une feature.

## La mémoire

Chaque projet a sa propre mémoire. À chaque tour, l'agent reçoit les souvenirs
utiles à ta demande, et il écrit lui-même ce qui restera vrai. Le sommaire de la
mémoire est exhaustif tant qu'il n'est pas tronqué (60 entrées) ; au-delà, il dit
ce qui manque et l'agent cherche avec `mem0_search`.
Le rappel d'un tour tient en 4 000 caractères : un souvenir plus long que
1 200 caractères y est rogné, et `mem0_search` le rend entier.

Le nom du projet vient du manifeste (`package.json`, `pyproject.toml`,
`Cargo.toml`…), sinon du dossier. `/mem0-status` affiche celui qui est retenu.

| Commande | Ce qu'elle fait |
|---|---|
| `/mem0-status` | Connexion, projet, état de la session. |
| `/mem0-init` | Amorce la mémoire d'un dépôt existant. |
| `/mem0-save` | Fait écrire maintenant ce que la session a appris. |
| `/mem0-dedupe` | Repère les doublons (rien n'est supprimé sans `--apply`). |

<details>
<summary>Variables d'environnement</summary>

| Variable | Défaut | Rôle |
|---|---|---|
| `MEM0_HTTP_URL` | `~/.omp/mem0.json`, sinon `http://localhost:8321` | l'adresse du service mémoire |
| `MEM0_HTTP_TOKEN` | celui de `~/.omp/mem0.json` | le jeton du service, s'il en exige un |
| `MEM0_PROJECT_ID` | — | force le nom du projet |
| `MEM0_AUTOSETUP` | `1` | `0` : le plugin n'écrit jamais dans un dépôt |
| `MEM0_QUIET` | `0` | `1` : souvenirs injectés sans être affichés |
| `MEM0_NUDGE` | `1` | `0` : pas de relance d'écriture en fin de session |
| `HARNESS_URL`, `HARNESS_TOKEN` | `~/.omp/harness.json` | le serveur et son jeton |
| `HARNESS_REPO` | nom du dossier | le nom du dépôt sur le serveur |

La configuration du serveur (dépôts, modèles, plafonds) :
[omp-harness/README.md](omp-harness/README.md) § « Configuration ».

</details>

## Dépannage

- **Sur le VPS, commence par `harness.sh check`**, puis `harness.sh logs`.
- **`/req` dit « harness non configuré »** : omp n'est pas relié au serveur.
  Colle le code d'appairage dans l'app, ou lance `/pair`.
- **Un merge n'arrive pas sur GitHub** : le plus souvent, la clé de déploiement
  est en lecture seule.
- **`/mem0-status` en rouge avec la pile conteneur** : lance
  `cd mem0-stack && ./doctor.sh`, il dit quoi corriger.
- **L'agent ignore un souvenir** : le sommaire est exhaustif tant qu'il n'est pas
  tronqué (60 entrées) ; au-delà, l'agent doit chercher avec `mem0_search`.
  Vérifie aussi le projet affiché par `/mem0-status`.

## Contribuer

Les règles : [CONTRIBUTING.md](CONTRIBUTING.md). L'organisation du dépôt, les
tests, la CI et la release : [DEVELOPPEMENT.md](DEVELOPPEMENT.md). La publication :
[PUBLISHING.md](PUBLISHING.md).
