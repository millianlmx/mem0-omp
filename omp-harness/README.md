# omp-harness — le serveur de pipelines

Un process Node, une base SQLite, une API REST + SSE, sur un VPS. Le serveur mène
chaque feature de bout en bout (`/specs → /impl → /review ⇄ correction → merge`) avec
un agent OMP par étape. Ce qui est réversible, il le décide seul et en garde un point
de reprise. Ce qui ne l'est pas (schéma de données, API publique, suppression), il le
garde pour toi. Les plugins et l'app OMP Console en sont les clients.

## Installer le serveur

Deux façons, mêmes garanties : chaque agent et chaque job de tests est isolé, plafonné
en mémoire, et les tests tournent sans réseau ni clé.

- **En conteneurs** (Docker ou podman) : le même déploiement sur n'importe quel VPS
  et sur ton Mac, ce qui permet de changer de backend en une commande.
- **Avec systemd** (Debian, Ubuntu, NixOS) : installé dans le système, sans moteur de
  conteneurs.

### En conteneurs (Docker ou podman)

Il ne faut que le moteur et git. Sous Linux : Docker Engine, ou podman rootless
(recommandé : son socket ne donne pas root). Sur un Mac : Docker Desktop ou OrbStack,
ou une machine podman en mode rootful.

```bash
bash omp-harness/deploy/container/harness.sh up
bash omp-harness/deploy/container/harness.sh add git@github.com:<toi>/<dépôt>.git
```

`up`, lancé depuis un clone de ce dépôt :

1. crée la racine (`~/.omp-harness`) et les secrets (`~/.omp-harness-secrets`, jamais
   montés dans le service), une clé SSH et la configuration ;
2. demande la clé d'API des agents (`ANTHROPIC_API_KEY` dans l'environnement évite
   la question ; Entrée sans clé, puis `harness.sh login`, pour un compte OMP) ;
3. construit les images, démarre le service, sa mémoire et un Ollama pour les
   embeddings, qui télécharge `bge-m3` ;
4. publie le service (443) et la mémoire (8443) en HTTPS sur ton tailnet, si
   Tailscale est là (`tailscale serve`, avec sudo au besoin) ;
5. sous podman rootless, installe une unité systemd utilisateur qui redémarre la pile
   au boot (Docker le fait seul) ;
6. affiche le **code d'appairage** : `/pair <code>` dans omp, ou la feuille
   **Serveur** de l'app.

Relancé, `up` met à jour et redémarre sans toucher aux secrets ni à la
configuration. `harness.sh pair` réaffiche le code. `harness.sh client add <nom>`
crée un client de plus et affiche SON code (voir « Plusieurs clients, plusieurs
projets »).

`add` clone le dépôt en nu, éprouve l'écriture sur son distant (un essai à blanc),
devine ses commandes de test d'après ses manifestes (`package.json`, `Cargo.toml`,
`go.mod`, `pyproject.toml`) et le déclare dans `~/.omp-harness/config.json`, puis recharge les dépôts du service sans
arrêter les runs en cours (`harness.sh reload`). Si la clé
du service n'a pas accès, il l'affiche avec le lien GitHub où la poser (case « Allow
write access ») et réessaie quand tu valides. Une URL `https://github.com/…` est
convertie en SSH. Les commandes devinées, les modèles et le reste se règlent ensuite
dans `config.json` (voir « Configuration »), puis `harness.sh reload` (les dépôts) ou
`harness.sh restart` (le reste).

| Variable de `up` | Effet |
|---|---|
| `OMLX_BASE_URL` | Ton serveur d'embeddings compatible OpenAI, au lieu de l'Ollama intégré (première installation ; ensuite, `mem0.env`) ; avec `--omlx`, celui des agents aussi |
| `OMLX_API_TOKEN`, `OMLX_CONTEXT_WINDOW` | Avec `--omlx` : la clé d'oMLX, et la fenêtre de contexte du modèle (131072) |
| `OMP_HARNESS_TAILSCALE=0` | Ne publie rien : le service reste sur `127.0.0.1` |
| `OMP_HARNESS_ENGINE` | `docker` ou `podman` (défaut : podman s'il est installé) |
| `OMP_HARNESS_PORT` | Le port local du service (8790) |

`harness.sh check` vérifie tout sans rien modifier ; `logs`, `restart` et `down` font
ce qu'ils disent.

**Comment c'est isolé.** Le service tourne dans son conteneur et lance chaque agent
et chaque job de tests en **conteneur frère**, par le socket du moteur :

| | Agent (`omp-harness-runner`) | Job de tests (image du dépôt, `node:22` par défaut) |
|---|---|---|
| Mémoire | `--memory 1G`, sans swap | `--memory 4G`, sans swap, `--cpus 3` |
| OOM | `--oom-score-adj 300` | `--oom-score-adj 800` : tué avant un agent |
| Réseau | celui du compose (mémoire, fournisseurs LLM) | aucun (`--network none`) |
| Montages | son worktree, le clone en lecture, son HOME, ses clés | son worktree, le clone en lecture |
| Droits | `--cap-drop ALL`, `no-new-privileges` | `--cap-drop ALL`, `no-new-privileges` |

Les clés LLM ne vivent que dans `runner.env`, monté dans les agents et nulle part
ailleurs. Le service a accès au socket du moteur : avec Docker « rootful », c'est un
accès root à la machine. Préfère podman rootless sur un VPS partagé. Un dépôt peut
avoir sa propre image de tests (`repos[].testImage`, par exemple une image Rust).

**Le Mac, tout en local.** `harness.sh up` y monte la même pile ; la mémoire y est
publiée sur le port 8322, car l'app tient déjà le 8321. Avec oMLX lancé en natif
(port 8000), qui sert un modèle de code et `bge-m3` :

```bash
bash omp-harness/deploy/container/harness.sh up --omlx <modèle>
```

`<modèle>` est l'identifiant que liste `curl -s 127.0.0.1:8000/v1/models`. `up` vérifie
d'abord qu'oMLX le sert, puis :

- met toutes les étapes sur `omlx/<modèle>` (`models.heavy`, les autres tiers vides),
  avec deux agents et un job de tests à la fois au plus (`runner.slots`, `heavy.slots`) ;
- déclare oMLX dans le `models.yml` des agents
  (`~/.omp-harness/runner-home/.omp/profiles/pipeline/agent/`), joint par
  `host.docker.internal` (Docker) ou `host.containers.internal` (podman) ;
- donne à la mémoire les embeddings et le modèle d'oMLX (`mem0.env`) ;
- ne demande aucune clé d'API ;
- écrit `~/.omp/agent/models.yml` pour l'omp du Mac s'il n'existe pas (sinon, dit quoi
  y ajouter) : choisis ensuite `omlx/<modèle>` avec `/model`.

Le mode est gardé : un `up` sans option le conserve, `up --anthropic` remet les agents
chez Anthropic. `OMLX_API_TOKEN` passe la clé d'oMLX s'il en exige une, et
`OMLX_CONTEXT_WINDOW` la fenêtre du modèle (131072 par défaut).

La VM de Docker Desktop ou de podman doit avoir 8 Go (`up` le signale) ; le modèle
compte en plus, hors VM. Hors ligne, les features avancent et fusionnent dans le clone
du Mac : le push vers le distant échoue (événement `push_failed`) et part avec le
merge suivant fait en ligne.

**Changer de backend.** Sur la machine où tu travailles :

```bash
bash omp-harness/deploy/container/harness.sh connect      # plugins et app visent la pile de cette machine
bash omp-harness/deploy/container/harness.sh disconnect   # retour au réglage précédent (le VPS)
```

`connect` réécrit `~/.omp/harness.json` et `~/.omp/mem0.json` en gardant tes
correspondances dossier → dépôt, et met les anciens fichiers de côté. Relance omp et
l'app ensuite.

### Avec systemd

Trois users se partagent la machine : `omp-harness` (le service, sa base, son
jeton), `omp-runner` (les agents et leurs comptes LLM) et `omp-heavy` (les tests,
sans réseau ni clé). Une quatrième, `omp-mem0`, tient la mémoire du projet
(`mem0-rs`, sur `127.0.0.1:8321`).

#### Debian ou Ubuntu

**1. Les prérequis.** Node ≥ 22.6, git, curl, ssh-keygen, sudo, systemd ≥ 250, et
Rust ≥ 1.89 pour compiler `mem0-rs` :

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs git curl openssh-client sudo systemd-oomd systemd-zram-generator
curl --proto '=https' -sSf https://sh.rustup.rs | sh -s -- -y && . ~/.cargo/env
```

Les tests de tes dépôts tournent sous `omp-heavy`, avec le PATH du système : leurs
outils (npm, cargo, pytest…) doivent être installés pour tout le système, pas
seulement dans ton compte. Si tes dépôts sont en Rust, installe aussi `sccache`, ou
retire `RUSTC_WRAPPER` de `heavy.env` dans la configuration.

**2. L'installation**, depuis un clone de ce dépôt :

```bash
cargo build --release --locked --manifest-path mem0-stack/mem0-rs/Cargo.toml
sudo install -m 0755 mem0-stack/mem0-rs/target/release/mem0-rs /usr/local/bin/mem0-rs
sudo bash omp-harness/deploy/install.sh
```

Le script pose omp 18.6.0 (`/usr/local/bin/omp`, la version de l'app Mac, vérifiée
par son empreinte), le service et ses unités systemd, le lanceur root, la mémoire,
`omp-harness-check`, et une clé SSH pour le service. Il ne remplace jamais une
configuration déjà posée : relancé, il met à jour le code et redémarre le service.

**3. La clé de déploiement.** Le service pousse ses merges sur ton dépôt avec sa
propre clé. Ajoute-la au dépôt **avec l'écriture** (GitHub : Settings ▸ Deploy keys ▸
Add deploy key ▸ Allow write access) :

```bash
sudo cat /var/lib/omp-harness/.ssh/id_ed25519.pub
```

En mode `"merge": "gh"` (une PR par feature, fusionnée par `gh`), installe aussi
`gh` et connecte-le : `sudo -u omp-harness -H gh auth login`.

**4. Le clone.** Un clone nu par dépôt, au nom de `omp-harness` :

```bash
sudo -u omp-harness git clone --bare git@github.com:<toi>/<dépôt>.git /var/lib/omp-harness/repos/<dépôt>
```

**5. La configuration.** `sudoedit /etc/omp-harness/config.json` : remplace le dépôt
d'exemple par les tiens, et garde ou change les modèles (voir « Configuration ») :

```json
"repos": [
  {
    "name": "mon-produit",
    "path": "/var/lib/omp-harness/repos/mon-produit",
    "tests": { "touched": "npm test -- {files}", "full": "npm test" },
    "merge": "local",
    "remote": "origin"
  }
]
```

**6. Les comptes LLM des agents.** Une clé d'API dans `/etc/omp-harness/runner.env`
(root seul la lit, le lanceur la passe aux agents) :

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-…' | sudo tee -a /etc/omp-harness/runner.env >/dev/null
```

Ou un compte OMP : `sudo -u omp-runner -H omp --profile pipeline`, puis `/login`.

**7. La mémoire.** `mem0-rs` calcule ses vecteurs avec un serveur compatible OpenAI,
qui doit rester joignable par le VPS. Dans `/etc/omp-harness/mem0.env`, renseigne
`OMLX_BASE_URL` (et `OMLX_API_TOKEN` s'il en faut un), et `EMBEDDING_DIMS` s'il
diffère de 1024 (bge-m3). Puis `sudo systemctl restart omp-harness-mem0`.

**8. Vérifier, démarrer, publier.**

```bash
sudo omp-harness-check
sudo systemctl enable --now omp-harness
sudo tailscale serve --bg --https=443 http://127.0.0.1:8790
sudo cat /var/lib/omp-harness/state/token
```

`omp-harness-check` ne modifie rien. Chaque ligne dit ✓, ou ✗ avec le geste qui
corrige : omp, lanceur, modèles, mémoire, jeton, puis pour chaque dépôt le clone, la
lecture du distant et l'écriture (un `push --dry-run`, qui s'authentifie sans rien
pousser). L'adresse `https://<vps>.<tailnet>.ts.net` et le jeton se saisissent dans
la feuille « Serveur » de l'app, sur le Mac et l'iPhone ; omp les lit dans
`~/.omp/harness.json` (`{ "url": "https://<vps>.<tailnet>.ts.net", "token": "…" }`).

#### NixOS

`install.sh` écrit dans `/etc` et `/usr/local`, que NixOS gère lui-même. Le module
`deploy/nixos/module.nix` déclare la même chose : users, dossiers et droits, sudoers
du lanceur, tranches, services, oomd, zram, la clé SSH du service et
`omp-harness-check`. omp vient de son propre flake, épinglé sur la version de l'app
Mac :

```nix
# flake.nix du VPS
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    omp.url = "github:can1357/oh-my-pi/v18.6.0";
    mem0-omp = { url = "github:millianlmx/mem0-omp"; flake = false; };
  };
  outputs = { nixpkgs, omp, mem0-omp, ... }: {
    nixosConfigurations.vps = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        "${mem0-omp}/omp-harness/deploy/nixos/module.nix"
        ({ pkgs, ... }: {
          services.omp-harness = {
            enable = true;
            ompPackage = omp.packages.${pkgs.system}.omp;
            heavyPackages = [ pkgs.nodejs_22 ];      # les outils des tests de tes dépôts
            tailscale.serve = true;                  # l'API (443) et la mémoire (8443) sur le tailnet
            # embeddings : un Ollama local sert bge-m3 à la mémoire (défaut, rien à installer ailleurs)
            settings = {                            # fusionné sur les défauts, sans secret
              models.standard = [ { provider = "anthropic"; model = "claude-sonnet-5-5"; } ];
              models.heavy = [ { provider = "anthropic"; model = "claude-opus-5-5"; } ];
              repos = [ {
                name = "mon-produit";
                path = "/var/lib/omp-harness/repos/mon-produit";
                tests = { touched = "npm test -- {files}"; full = "npm test"; };
                merge = "local";
                remote = "origin";
              } ];
            };
          };
        })
      ];
    };
  };
}
```

Sans flakes, importe le module depuis un clone et prends omp par
`(builtins.getFlake "github:can1357/oh-my-pi/v18.6.0").packages.${pkgs.system}.omp`
(flakes activées dans `nix.settings.experimental-features`). La première
construction d'omp peut prendre du temps.

Puis `sudo nixos-rebuild switch`, et les gestes qui ne se déclarent pas, dans le
même ordre que sur Debian (étapes 3, 4, 6 et 8) :

```bash
sudo cat /var/lib/omp-harness/.ssh/id_ed25519.pub          # clé de déploiement, avec l'écriture
sudo -u omp-harness git clone --bare git@github.com:<toi>/mon-produit.git /var/lib/omp-harness/repos/mon-produit
echo 'ANTHROPIC_API_KEY=sk-ant-…' | sudo tee -a /etc/omp-harness/runner.env >/dev/null
sudo omp-harness-check
sudo systemctl restart omp-harness
```

La machine doit être sur le tailnet (`services.tailscale.enable = true;`, et
`services.tailscale.authKeyFile` pour la connecter sans geste) : avec
`tailscale.serve = true`, le service `omp-harness-tailscale-serve` publie l'API et la
mémoire dès que le nœud est connecté, et les retire à l'arrêt. Sans lui, publie à la
main : `sudo tailscale serve --bg --https=443 http://127.0.0.1:8790`.

**Les embeddings.** `embeddings.enable` (vrai par défaut) déclare `services.ollama` sur
`127.0.0.1:11434`, qui télécharge `bge-m3` au premier démarrage ; mem0-rs y est
pointé. `embeddings.llmModel = "qwen3:1.7b";` ajoute un modèle de chat pour
l'extraction de souvenirs (`infer`), que ni le harness ni le plugin ne demandent par
défaut. `embeddings.enable = false;` et `mem0.environment.OMLX_BASE_URL` désignent un
serveur ailleurs.

`omp-harness-secrets` crée une fois `/etc/omp-harness/{env,runner.env,mem0.env}`
(root seul, jamais dans le store) avec le jeton de la mémoire ; un `OMLX_API_TOKEN`
s'ajoute à la main dans `mem0.env`.

### Mettre à jour

Les runs en cours reprennent à leur dernier point de reprise après le redémarrage.

- **Debian** : `git pull`, puis `sudo bash omp-harness/deploy/install.sh`. Pour
  recompiler `mem0-rs`, refais les deux commandes `cargo build` et `install` de
  l'étape 2.
- **NixOS** : `nix flake update mem0-omp`, puis `sudo nixos-rebuild switch`.
- **En conteneurs** : `git pull`, puis `bash omp-harness/deploy/container/harness.sh up`.

### Développer sans systemd

Passe `runner.isolation` et `heavy.isolation` à `none` et `launcher` à `[]`, puis :
`node --experimental-strip-types omp-harness/main.ts --config ma-config.json`. Les
tests (`test/harness/`) font tourner le service complet avec de vrais process, du
vrai git et la vraie base ; les agents y sont un faux `omp` RPC
(`test/support/fake-omp-rpc.ts`).

## Configuration

`/etc/omp-harness/config.json` ne fait que surcharger les défauts
(`deploy/config.example.json` en montre un jeu complet). Les clés utiles :

| Clé | Défaut | Rôle |
|---|---|---|
| `repos[].name` | — | le nom par lequel les clients désignent le dépôt (jamais un chemin) |
| `repos[].path` | — | le clone nu du service |
| `repos[].tests.touched` | `npm test -- {files}` | les tests des fichiers touchés ; `{files}` reçoit la liste |
| `repos[].tests.full` | `npm test` | la suite complète, lancée par `/review` |
| `repos[].merge` | `local` | `local` : squash sur `main` puis push ; `gh` : une PR fusionnée par `gh` |
| `repos[].remote` | `null` | le distant poussé après un merge (`origin`) ; `null` garde les merges sur le VPS |
| `repos[].mainBranch` | `main` | la branche principale |
| `repos[].scope` | lue dans les manifestes | le nom du projet dans la mémoire, le même que sur le Mac |
| `repos[].testImage` | `container.testImage` | l'image des tests de ce dépôt, en conteneurs |
| `runner.isolation`, `heavy.isolation` | `systemd` | `systemd`, `container` (Docker ou podman) ou `none` (développement) |
| `container.command` | `["docker"]` | le CLI du moteur ; il parle aussi à l'API de podman |
| `container.runnerImage` | `omp-harness-runner:local` | l'image des agents : omp épinglé, git, le plugin mémoire |
| `container.testImage` | `docker.io/library/node:22-bookworm` | l'image des tests par défaut |
| `container.network` | `null` | le réseau des agents (celui du compose, qui porte la mémoire) |
| `container.runnerEnvFile`, `container.runnerHome` | `null` | les clés des agents et leur HOME, chemins de l'hôte |
| `models.fast`, `models.standard`, `models.heavy` | `[]` | la chaîne de modèles de chaque niveau, dans l'ordre de bascule sur un 429 ; vide, elle prend celle du niveau au-dessus |
| `stepTiers` | `req`, `specs`, `review` : `heavy` ; `impl`, `fix` : `standard` | le niveau de chaque étape ; la dernière correction avant le plafond passe toujours en `heavy` |
| `providers.<nom>` | — | `capacity` et `refillPerMinute` : le débit permis par fournisseur |
| `review.specsGate` | `true` | la feature attend ta validation entre `/specs` et `/impl` |
| `review.fixCap` | `3` | les corrections automatiques avant de te passer la main |
| `review.maxDiffLines` | `300` | au-delà, pas d'auto-merge |
| `runner.slots`, `heavy.slots` | `5`, `2` | agents et jobs de tests simultanés |
| `runner.memoryMax`, `heavy.memoryMax` | `1G`, `4G` | le plafond mémoire de chacun |
| `heavy.timeoutSec` | `1800` | la durée maximale d'un job de tests |
| `heavy.env` | `{}` | l'environnement des tests, et rien d'autre |
| `oracle` | `{ "url": "http://127.0.0.1:8321" }` (posé par l'installation) | la mémoire du projet ; `null` la coupe |
| `listen` | `127.0.0.1:8790` | l'écoute de l'API, publiée par Tailscale |
| `repos[].maxParallel` | `null` | les runs de ce dépôt vivants à la fois, au plus : un gros dépôt ne prend pas tous les runners aux autres |
| `runner.stepTimeoutSec` | `5400` | la durée maximale d'une étape (prompts, relance et bascules compris) : au-delà, le runner est arrêté et l'étape échoue, relançable |
| `events.retentionDays` | `30` | le journal d'événements est purgé au-delà (au démarrage, puis chaque heure) |
| `clientsFile` | à côté de `tokenFile` | les clients nommés (empreintes de jetons, rôles, dépôts), relu à chaque changement |

Un `kill -HUP` du service (`harness.sh reload`, ou `systemctl kill -s HUP
omp-harness`) relit la configuration et recharge les dépôts : un dépôt ajouté sert
tout de suite, un dépôt retiré qui a encore des runs vivants est gardé jusqu'à leur
fin. Une configuration invalide est refusée, l'ancienne reste en place.

## Une feature, pas à pas

- **Décisions.** Ce que les specs, la mémoire ou le code ne tranchent pas, l'agent
  le tranche par l'option la plus réversible, avec l'outil `decision`. Le service en
  fait un commit `decision: … → …` (point de reprise). Une décision cite celles dont
  elle découle (`dependsOn`).
- **Escalades.** Schéma de données, API publique, suppression : l'agent ne
  l'applique pas, contourne et termine le reste. Les questions partent ensemble en
  fin d'étape, et l'étape reprend quand tu as tout répondu.
- **Renverser une décision.** Ta raison rejoint la mémoire. Si rien n'en découle,
  rien n'est annulé : l'étape en cours (ou une correction après la revue) applique
  ta nouvelle option sur le code actuel. Si des décisions en découlent, le service
  revient au point de reprise : seules celles-là tombent, les autres sont
  réappliquées. Après un merge, un run de suite s'ouvre.
- **Revue.** L'agent de revue lance la suite complète et rend un verdict structuré
  (`review_verdict`). Bas risque, suite verte sur l'arbre exact et diff court :
  auto-merge. Sinon, tu valides ; tu lis le code si le verdict est faible.
- **Merge.** Rebase sur `main`, squash, puis push sur le distant. Un push refusé
  laisse un événement `push_failed` avec la raison.

## La mémoire du projet

L'oracle du serveur **est** la mémoire mem0 du projet, la même que celle des
sessions du Mac une fois appairé (`/pair`, README racine § « Installation »).

- **Même portée.** Une portée non déclarée est calculée à partir des manifestes de
  `main` (`package.json`, `pyproject.toml`, `Cargo.toml`, `Package.swift`, puis
  `.xcodeproj`), avec la même table que le plugin (`omp-mem0-memory/state.ts`).
  `GET /v1/status` l'affiche par dépôt.
- **Agents branchés.** Chaque agent charge le plugin mémoire (`runner.extensions`)
  avec `MEM0_PROJECT_ID=<portée>`, `MEM0_AUTOSETUP=0` (rien n'est écrit dans le
  dépôt, donc rien dans la PR) et `MEM0_NUDGE=0`. Le service écrit lui-même en
  mémoire les besoins, chaque feature mergée et chaque correction humaine **avec sa
  raison**.
- **Isolée.** `mem0-rs` tourne dans son conteneur (base en `~/.omp-harness/mem0`), ou
  sous `omp-mem0` avec systemd (base en `/var/lib/omp-mem0`, 0700), hors du budget
  des runs. Un jeton commun le relie au service et aux agents ; les jobs de tests ne
  voient ni la base ni le jeton. Injoignable, la mémoire dégrade sans bloquer.

**Reprendre la mémoire du Mac**, une fois la copie `/tmp/mem0-rs.db` posée sur le VPS
(README racine, étape 4) :

```bash
# en conteneurs (docker, ou podman)
docker compose -p omp-harness stop mem0
rm -f ~/.omp-harness/mem0/mem0-rs.db-wal ~/.omp-harness/mem0/mem0-rs.db-shm
cp /tmp/mem0-rs.db ~/.omp-harness/mem0/mem0-rs.db
docker compose -p omp-harness start mem0

# avec systemd
sudo systemctl stop omp-harness-mem0
sudo rm -f /var/lib/omp-mem0/mem0-rs.db-wal /var/lib/omp-mem0/mem0-rs.db-shm
sudo install -o omp-mem0 -g omp-mem0 -m 0600 /tmp/mem0-rs.db /var/lib/omp-mem0/mem0-rs.db
sudo systemctl start omp-harness-mem0
```

## Plusieurs clients, plusieurs projets

Un serveur sert plusieurs dépôts, plusieurs projets par dépôt et plusieurs clients à
la fois (le Mac, l'iPhone, un collègue, une CI).

**Les clients.** Chacun a son jeton, son rôle et ses dépôts (`auth.ts`) :

| Rôle | Peut |
|---|---|
| `viewer` | lire : boîte, runs, projets, audits, statistiques, flux |
| `operator` | lire, créer runs, projets et audits, faire les gestes (escalades, décisions, validations, annulation, priorité) |
| `admin` | tout, plus gérer les clients (`/v1/clients`) |

Un client borné à des dépôts ne voit rien des autres : listes et flux filtrés, 404
sur un run d'ailleurs, 403 à la création. Le jeton historique (`tokenFile`) reste le
client `admin` sur tous les dépôts : les codes d'appairage déjà distribués marchent.

```bash
bash omp-harness/deploy/container/harness.sh client add ipad viewer mon-produit   # son code d'appairage
bash omp-harness/deploy/container/harness.sh client list
bash omp-harness/deploy/container/harness.sh client revoke ipad
# avec systemd (Debian ou NixOS) : le jeton seul s'affiche, à coller avec l'adresse dans la feuille « Serveur »
sudo omp-harness-client add ipad viewer mon-produit
sudo omp-harness-client list
sudo omp-harness-client revoke ipad
```

Le fichier ne garde que l'empreinte SHA-256 de chaque jeton ; une révocation vaut à
la requête suivante. Un client borné à des dépôts ne reçoit pas la mémoire dans son
code (elle couvre tous les projets du serveur).

**L'auteur de chaque geste** est gardé : créateur du run (`createdBy`), réponse aux
escalades (`answeredBy`), décision acceptée ou renversée (`decidedBy`), et `by` dans
les événements du journal.

**Deux clients sur le même run.** Les gestes d'un run passent un par un. Chaque run
porte une révision (`rev`, +1 à chaque écriture) rendue en `ETag` par
`GET /v1/runs/{id}` ; un geste envoyé avec `If-Match: "<rev>"` est refusé (412) si un
autre client a agi entre-temps : il relit au lieu d'agir sur une vue périmée.

**L'admission équitable.** À chaque tour, les runs en file sont admis un par un, au
meilleur rang : priorité (`priority`, de -1000 à 1000, à la création ou par
`POST /v1/runs/{id}/priority`), puis les runs repris (escalade répondue), puis le
dépôt et le projet qui ont le moins de runs vivants, puis l'ancienneté. Un arriéré
sur un dépôt ne prive donc pas les autres, et `repos[].maxParallel` plafonne un
dépôt. Les tests heavy attendent leur slot dans une file servie par priorité puis
par ordre d'arrivée : personne ne double personne. Les merges d'un même dépôt
passent l'un après l'autre (le second se rebase sur le `main` du premier) ; les
dépôts différents mergent en parallèle.

## API

`Authorization: Bearer <jeton>` sur toutes les routes, sauf `GET /v1/health` (version
du service, `api`, `features`). La colonne « Rôle » est le rôle minimal.

| Route | Rôle | Effet |
|---|---|---|
| `GET /v1/me` | viewer | Le client du jeton : nom, rôle, dépôts. |
| `GET /v1/status` | viewer | Compteurs par état et par dépôt, runs vivants, slots et files d'attente, `MemAvailable`, jetons par fournisseur. |
| `GET /v1/repos` | viewer | Les dépôts que le client voit (nom, scope, branche, merge, `maxParallel`). |
| `GET /v1/runs?state=…&repo=…` · `POST /v1/runs` `{repo, title, request, modules?, req?, priority?}` | viewer · operator | Lister, créer. `repo` est un **nom** déclaré dans la configuration, jamais un chemin. `req` : le compte rendu de besoins établi en /req interactif (section `## Besoins`) ; le run part alors de /specs. |
| `GET /v1/runs/{id}` | viewer | Run (avec sa révision `rev`, aussi en `ETag`), étapes, décisions, escalades, tests, artefacts. |
| `POST /v1/runs/{id}/escalations` `{answers: [{id, answer}]}` | operator | Répondre au lot. Le run reprend quand tout est répondu. |
| `POST /v1/runs/{id}/decisions/{n}/accept` | operator | Accepter une décision prise seule. |
| `POST /v1/runs/{id}/decisions/{n}/reverse` `{option, reason}` | operator | Renverser : correction sur l'état courant, ou reprise au checkpoint N si des décisions en découlent. Raison dans l'oracle. |
| `POST /v1/runs/{id}/validate` `{approve, reason?}` | operator | Valider les specs (run en `awaiting_human` à l'étape `specs`) ou un verdict, ou les refuser avec une raison : /specs refait, ou correction. La raison part dans l'oracle. |
| `POST /v1/runs/{id}/cancel` | operator | Annuler (la branche reste). |
| `POST /v1/runs/{id}/priority` `{priority}` | operator | Changer la priorité d'admission (et de la file des tests). |
| `GET /v1/escalations` | viewer | Escalades ouvertes, **batchées par run** (écran iOS). |
| `GET /v1/decisions?status=auto` | viewer | La relecture du matin. |
| `GET /v1/inbox` | viewer | La boîte de l'humain d'un appel : escalades batchées, runs à valider (specs ou verdict), décisions prises seules, features en cours, audits ouverts, curseur du flux. |
| `GET /v1/projects` · `POST /v1/projects` `{repo, title, priority?, features: [{title, request, modules?}]}` · `GET /v1/projects/{id}` | viewer · operator · viewer | /project. La liste porte le décompte des runs de chaque projet par état. Le projet et ses runs naissent dans la même transaction. |
| `GET /v1/audits` · `POST /v1/audits` `{repo, focus?}` · `GET /v1/audits/{id}` | viewer · operator · viewer | /audit : `queued` → `analysing` → `proposed`. |
| `POST /v1/audits/{id}/launch` `{items: [index], title?}` · `POST /v1/audits/{id}/cancel` | operator | Lancer les propositions retenues en projet, ou annuler. |
| `GET /v1/stats` | viewer | Les statistiques des dépôts du client, avec l'état du scheduler. |
| `GET /v1/clients` · `POST /v1/clients` `{name, role?, repos?}` · `DELETE /v1/clients/{name}` | admin | Lister, créer (le jeton n'est rendu qu'à la création), révoquer. |
| `GET /v1/events?run=…&live=1` | viewer | SSE, filtré par les dépôts du client. `id:` = curseur du journal. Événements journalisés : `run_created`, `run_state`, `priority`, `step_started`, `step_done`, `step_timeout`, `decision`, `escalation`, `escalations` (le lot), `review`, `specs_ready`, `verdict`, `audit_state`, `heavy_*`, `rate_limited`, `model_failover`, `rebased`, `merge_queued`, `merged`, `progress`… (catalogue : `events.ts`). `live=1` ajoute `activity` (les outils des runners) : éphémère, sans `id:`, jamais rejoué. |

Les gestes acceptent `If-Match: "<rev>"` (412 si le run a changé depuis). Un rôle
insuffisant rend 403, un dépôt non permis 403 à la création et 404 en lecture.

## Architecture

| Case du schéma | Où | Ce qui le garantit |
|---|---|---|
| **Clients** : HTTPS + SSE, auth, point d'entrée unique | `http.ts`, `auth.ts`, `queries.ts` | Un jeton par client (empreinte SHA-256, comparée en temps constant), un rôle, des dépôts permis ; chaque route déclare son rôle minimal. Écoute sur `127.0.0.1` ; Tailscale ou un reverse proxy TLS publie l'API. Le flux SSE se rejoue depuis `Last-Event-ID`, filtré par dépôt. |
| **SQLite** : source de vérité, un seul écrivain | `db.ts`, `events.ts` | Runs, étapes, décisions (checkpoints), escalades, artefacts, journal d'événements, cache heavy et tests lancés. Seul le service ouvre la base. Runners et jobs heavy passent par lui. Transactions réentrantes : les abonnés ne voient un événement qu'au COMMIT. Migrations numérotées (`PRAGMA user_version`). |
| **Pipeline Service** : machine à états, reprise au checkpoint | `machine.ts`, `context.ts`, `orchestrator.ts`, `steps.ts` | Machine pure, table des transitions (`TRANSITIONS`) : toute écriture d'état passe par `context.transition`, en compare-and-swap, avec ses événements dans la même transaction. Une boucle async par run actif. Au redémarrage, chaque run `running` revient à son dernier commit (checkpoint) et repart avec un nouveau runner. |
| **Scheduler** : 5 runners, 2 heavy, jetons par fournisseur, MemAvailable, équité | `scheduler.ts`, `orchestrator.ts` | Un slot runner par run vivant, admis au meilleur rang (priorité, reprise, dépôt et projet les moins servis, ancienneté), dans la limite de `repos[].maxParallel`. Un slot heavy par `run_tests`, attendu dans une file (priorité puis arrivée). Un seau à jetons par fournisseur (un jeton par prompt) avec bascule. Admission seulement si `MemAvailable − enveloppe ≥ réserve`. Un refus d'admission est écrit une fois par attente. |
| **/project** : modules, parallèle si disjoint, rebase, merge immédiat | `planner.ts`, `orchestrator.ts` | Modules déclarés, sinon lus dans l'oracle, puis précisés par la section `## Modules` des specs. Chevauchement par préfixe de chemin, et un ensemble inconnu chevauche tout. Rebase sur `main` avant /review. En cas de conflit, le service fusionne `main` et le runner résout les marqueurs dans les fichiers, sans git. Merge squash dès la validation. |
| **Runners OMP** : 1 par étape, 1 Go, profil pipeline, échéance | `runner.ts`, `runner-session.ts`, `rpc.ts`, `host-tools.ts` | `omp --mode rpc --no-ui --no-lsp --profile pipeline` dans une scope `MemoryMax=1G` sous `choom -n 300`. Une seule session pour les runs et les audits : bascule de fournisseur, changement de tier, et échéance de l'étape (`runner.stepTimeoutSec`) au-delà de laquelle le runner est arrêté. Le runner de la revue reste vivant pendant review ⇄ fix (cache de prompt). Les autres meurent en fin d'étape ou à l'escalade. |
| **Merges** : un dépôt à la fois | `merger.ts` | Une file par dépôt : deux merges du même dépôt ne se disputent jamais `main`, le second se rebase sur le premier ; les dépôts différents mergent en parallèle. |
| **Politique de décision** | `decisions.ts` | Outil hôte `decision`. Une décision réversible devient un commit WIP `decision: … → …` (trailer `Harness-Decision: run/N`, remappé après rebase). Le schéma de données, l'API publique et les suppressions partent en escalade, batchée en fin d'étape. Le service durcit une catégorie, il ne l'adoucit jamais. Une décision cite celles dont elle découle (`dependsOn`). |
| **Heavy** : systemd, 4 Go, 300 %, user dédié, sans réseau ni clé, cache, OOM | `heavy.ts` | Le runner attend, bloqué sur `run_tests`. Le cache est lu avant tout lancement, par clé tree hash du répertoire de travail + commande + env. Un OOM donne un échec structuré et 2 relances, sans entrée de cache. |
| **Worktrees** : 1 par run, artefacts, WIP, petites PR, caches de build | `git.ts` | Branche `harness/<slug>`. Artefacts dans `.harness/` (exclu de git, versés dans la base). `CARGO_TARGET_DIR` par worktree, sccache et store pnpm partagés. Un diff de plus de 300 lignes interdit l'auto-merge. |
| **Oracle** : mem0-rs, scope projet | `oracle.ts` | Lu par /req, /specs et /project. En écriture : les comptes rendus de besoins, chaque feature mergée (knowledge-updater) et chaque correction humaine **avec sa raison**. Injoignable, il dégrade sans bloquer. |
| **Backends LLM** : trois tiers, multi-provider | `config.ts` (`models`, `stepTiers`), `machine.ts` (`stepTier`), `runner-session.ts` | Trois chaînes : `models.fast`, `models.standard`, `models.heavy` (une chaîne vide prend celle du tier au-dessus). `stepTiers` donne le tier de chaque étape. Par défaut, heavy là où l'on juge (/req, /specs, /review, qui décide de l'auto-merge) et standard là où l'on exécute des specs précises (/impl, /impl --fix). La dernière correction avant le plafond passe en heavy. Review ⇄ fix garde son runner : seul le modèle change (`set_model`, événement `model_tier`). Sur un 429, `set_model` fait passer le **même** runner au fournisseur suivant. |
| **Sortie /review** : verdict structuré, auto-merge | `verdict.ts` | Outil hôte `review_verdict`. Bas risque + suite complète **verte sur l'arbre exact** (cache heavy, jamais l'avis du runner) + diff ≤ 300 lignes : auto-merge. Sinon l'humain lit le verdict, et le code seulement si le verdict est faible. |
| **Système** : zram, oomd, budget 14 Go | `deploy/` | `omp-harness.slice` 16G ⊃ runners 5G + heavy 8G + service 1G. OOM : heavy (800), puis runners (300), jamais le service (-900, `ManagedOOMPreference=omit`). zram 8 Go. |
| **Validation des specs** (ajout) | `machine.ts`, `gestures.ts` | `review.specsGate` (vrai par défaut) : après /specs, le run attend l'humain, modules réservés. L'accord lance /impl. Un refus refait /specs avec sa raison, qui part aussi dans l'oracle. |
| **/audit** (ajout) | `audits.ts` | Un runner lit `main` dans un worktree détaché, sans rien commiter, et rend jusqu'à 10 propositions (faiblesse ou feature, modules) par l'outil hôte `audit_propose`. L'humain choisit : les propositions retenues partent en projet, planifié comme un /project. |
| **Statistiques** (ajout) | `stats.ts` | Calculées à la demande sur la base : runs par état, taux de merge, délai médian, étapes et durées, corrections, tests heavy (cache, relances), décisions, audits. |
| **Boucle humaine** | `gestures.ts`, `http.ts` | Les gestes d'un run passent un par un, chacun dans une transaction, avec son auteur ; `If-Match` refuse un geste fait sur une vue périmée. Relire, accepter, renverser une décision. La raison part dans l'oracle. Si rien ne découle de la décision N, il n'y a pas de retour arrière : l'étape en cours (ou une correction après la revue) applique l'option sur l'état courant, et les autres décisions tiennent. Si des décisions en découlent (`dependsOn`, transitivement), le service fait un retour dur au checkpoint N : seules ces dépendantes tombent, les indépendantes sont réappliquées. Un run déjà mergé ouvre un run de suite. |

## Sécurité et écarts assumés au schéma

- **Heavy en service transitoire, pas en `--scope`.** Une scope ne porte ni
  `User=` ni `PrivateNetwork=`. Le job part donc en `systemd-run --wait --pipe` :
  mêmes limites cgroup, plus l'isolation demandée.
- **Les outils du runner sont des outils hôtes RPC.** `run_tests`, `decision`,
  `review_verdict`, `oracle_recall` et `progress` sont déclarés par
  `set_host_tools` et exécutés par le service. Le runner n'a ni accès à la base ni
  jeton d'API, et rien n'est à installer dans son profil.
- **Trois users au lieu d'un.** `omp-harness` tient la base et le jeton,
  `omp-runner` les clés LLM et les worktrees, `omp-heavy` rien. Un runner détourné
  par une injection de prompt ne peut pas s'auto-valider par l'API.
- **Un lanceur root pour systemd.** Autoriser `systemd-run` au service
  reviendrait à lui donner root (`-p User=root`). Le service passe donc par
  `deploy/omp-harness-systemd-run`, appelé par `sudo` sans `SETENV` ni `-E`, ce
  qui remet l'environnement à zéro. Le lanceur valide chaque mot de la ligne :
  - côté heavy, `User=omp-heavy`, `PrivateNetwork=yes`, `ProtectSystem=strict`,
    `PrivateTmp` et `RuntimeMaxSec` sont obligatoires ;
  - les chemins doivent être absolus et rester sous les racines déclarées ;
  - le lanceur ajoute lui-même `ProtectHome` et masque, par `InaccessiblePaths`,
    l'état du service, les logins des runners et les sockets de l'hôte ;
  - côté runner, la commande est épinglée sur `OMP_BIN`, et il est relancé sous
    `omp-runner` avec les clés de `/etc/omp-harness/runner.env`, que root seul lit.

  Il refuse tout le reste (code 64). Sa configuration est lue ligne à ligne,
  jamais exécutée.
- **Git ne fait jamais confiance au worktree.** Un runner peut réécrire le fichier
  `.git` de son worktree. Le service passe donc un `--git-dir` explicite, retrouvé
  dans le dossier d'administration du clone, et force `core.hooksPath=/dev/null` et
  `core.fsmonitor=false`. Le clone est en `core.sharedRepository=0640` : son gitdir
  n'est inscriptible que par le service.
- **Artefacts sans lien.** `.harness/*.md` est lu et écrit en `O_NOFOLLOW`, puis
  vérifié par `/proc/self/fd`. Un lien vers le jeton du service n'est jamais
  ingéré.

## Les apps

OMP Console, sur Mac comme sur iPhone et iPad, est le poste de l'humain ; chaque app
joint seule ce serveur, aucune ne dépend de l'autre. Ses cinq sections de Pilotage
(Accueil, Pipelines, Projet, Audit, Statistiques) joignent le serveur en https, par le
code d'appairage (`harness.sh pair`) collé une fois dans la feuille « Serveur » — ou
l'adresse publiée par Tailscale et le jeton du service. Sur l'iPhone, la section
Mémoire lit la mémoire de ce serveur, dont le même code porte l'adresse. Elles
suivent `GET /v1/events` et relisent la boîte à chaque événement ; une coupure garde
la dernière boîte, signalée hors ligne. Le client est partagé
(`omp-console/Sources/ConsoleClient/Harness*.swift`) : voir `omp-console/README.md`
§ « Serveur de pipelines ».
