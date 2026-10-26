# omp-harness — le serveur de pipelines

Un process Node, une base SQLite, une API REST + SSE, sur un VPS. Le serveur mène
chaque feature de bout en bout (`/specs → /impl → /review ⇄ correction → merge`) avec
un agent OMP par étape. Ce qui est réversible, il le décide seul et en garde un point
de reprise. Ce qui ne l'est pas (schéma de données, API publique, suppression), il le
garde pour toi. Les plugins et l'app OMP Console en sont les clients.

## Installer le serveur

Trois façons, mêmes garanties : chaque agent et chaque job de tests est isolé, plafonné
en mémoire, et les tests tournent sans réseau ni clé.

- **En conteneurs** (Docker ou podman) : le même déploiement sur n'importe quel VPS
  et sur ton Mac, ce qui permet de changer de backend en une commande.
- **Avec Portainer** : l'URL du dépôt dans Portainer, et la pile se monte seule, sans
  terminal.
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
arrêter les runs en cours (`harness.sh reload`). Pour un projet node, le `package.json`
de `main` est lu : un script `test:touched` donne `tests.touched` = `npm run -s test:touched -- {files}`
(sinon `npm test -- {files}`), `tests.pattern` vaut `test/**/*.test.ts` si un dossier
`test/` existe (sinon `**/*.test.{ts,js}`), et les scripts `lint` et `typecheck` deviennent
des `checks` nommés. Si la clé
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
du Mac : le push vers le distant échoue (événement `push_failed`, trois essais
espacés), le run attend l'humain avec la raison ; `retry` ou la validation, en ligne,
le poussent.

**Changer de backend.** Sur la machine où tu travailles :

```bash
bash omp-harness/deploy/container/harness.sh connect      # plugins et app visent la pile de cette machine
bash omp-harness/deploy/container/harness.sh disconnect   # retour au réglage précédent (le VPS)
```

`connect` réécrit `~/.omp/harness.json` et `~/.omp/mem0.json` en gardant tes
correspondances dossier → dépôt, et met les anciens fichiers de côté. Relance omp et
l'app ensuite.

### Avec Portainer

`docker-compose.yml`, à la racine du dépôt, monte tout le serveur sans terminal :
le harness, sa mémoire et ses embeddings. Il faut Docker sur l'hôte, Portainer qui le
pilote, et Tailscale installé sur l'hôte et connecté (`tailscale up`) : la pile n'en
embarque pas, elle se publie par celui de l'hôte.

1. Dans Portainer : **Stacks › Add stack › Repository**. URL :
   `https://github.com/millianlmx/mem0-omp`, référence `refs/heads/main`, chemin du
   compose : `docker-compose.yml`.
2. Dans **Environment variables**, au minimum :

   | Variable | Valeur |
   |---|---|
   | `ANTHROPIC_API_KEY` | la clé des agents (ou `OPENROUTER_API_KEY`) |
   | `OMP_HARNESS_REPOS` | tes dépôts, séparés par des virgules : `git@github.com:toi/a.git,git@github.com:toi/b.git` |

3. **Deploy the stack**. La première fois, la construction des images prend quelques
   minutes.

Ensuite, tout se lit dans les journaux des conteneurs :

- **`setup`** affiche la clé SSH du service. Pose-la en clé de déploiement de chaque
  dépôt, case « Allow write access » cochée.
- **`repos`** déclare les dépôts. Tant qu'une clé manque, il donne le lien GitHub où la
  poser et réessaie toutes les 30 s : rien à redéployer.
- **`pairing`** publie le harness et sa mémoire sur le tailnet par le Tailscale de
  l'hôte (son socket, `/var/run/tailscale`), puis affiche le code d'appairage `omp1:…`,
  à coller dans l'app ou avec `/pair`. Si Tailscale manque ou n'est pas connecté sur
  l'hôte, il le dit et attend. Redémarre-le pour réafficher le code.

`setup`, `repos`, `runner-image` et `test-image` s'arrêtent une fois leur travail
fait : l'état « exited » est normal. Le tailnet doit avoir MagicDNS et HTTPS activés,
comme pour `harness.sh up`. `pairing` règle le `tailscale serve` de l'hôte comme le
ferait `harness.sh up` : le port 443 vers le harness, le port 8443 vers la mémoire, au
nom de la machine sur le tailnet (`https://<vps>.<tailnet>.ts.net`). Si l'hôte sert
déjà autre chose sur ces ports (Portainer sur 443, par exemple), choisis-en d'autres
avec `OMP_HARNESS_TAILNET_PORT` et `OMP_HARNESS_TAILNET_MEM0_PORT` : `pairing` y
publie le harness et la mémoire, et le code d'appairage porte ces ports. Un `tailscale
serve` sur un port déjà pris remplace ce qui y était publié. Avec
`OMP_HARNESS_TAILSCALE_SERVE=0`, `pairing` ne touche pas au `tailscale serve` de
l'hôte : publie toi-même `127.0.0.1:8790` et `127.0.0.1:8321` sur ces deux ports.

Si HTTPS n'est pas activé sur le tailnet, `tailscale serve` écrit un lien
d'activation dans les journaux de `pairing` et attend qu'il soit suivi ; le code
s'affiche ensuite, sans rien relancer.

Les autres variables, facultatives :

| Variable | Défaut | Rôle |
|---|---|---|
| `OMP_HARNESS_ROOT` | `/var/lib/omp-harness` | les données, sur l'hôte |
| `OMP_HARNESS_SECRETS` | `/var/lib/omp-harness-secrets` | les secrets, sur l'hôte (les clés LLM n'y sont lues que par les runners) |
| `OMLX_BASE_URL`, `OMLX_API_TOKEN` | l'Ollama de la pile | un serveur d'embeddings à toi |
| `OMLX_EMBED_MODEL`, `EMBEDDING_DIMS` | `bge-m3`, `1024` | son modèle et sa dimension |
| `OMP_HARNESS_PORT`, `OMP_HARNESS_MEM0_PORT` | `8790`, `8321` | les ports, sur la boucle locale de l'hôte |
| `OMP_HARNESS_SOCKET` | `/var/run/docker.sock` | le socket du moteur |
| `OMP_HARNESS_TAILSCALE_RUN` | `/var/run/tailscale` | le dossier du socket de tailscaled sur l'hôte |
| `OMP_HARNESS_TAILNET_PORT`, `OMP_HARNESS_TAILNET_MEM0_PORT` | `443`, `8443` | les ports https du harness et de la mémoire sur le tailnet, ceux du code d'appairage |
| `OMP_HARNESS_TAILSCALE_SERVE` | `1` | `0` : `pairing` ne touche pas au `tailscale serve` de l'hôte |

Chaque redéploiement (**Pull and redeploy**, ou une variable changée) relit les
variables : la clé du modèle et la liste des dépôts suivent, le jeton de la mémoire,
la clé SSH et `config.json` sont gardés. Pour la vérification, ouvre la console du
conteneur `harness` et lance `omp-harness-check`. Les autres réglages (modèles,
plafonds) se font dans `config.json`, sous `OMP_HARNESS_ROOT`, puis en redémarrant
`harness`.

Cette pile et `harness.sh up` ne cohabitent pas sur le même hôte : elles prennent les
mêmes images, le même réseau et les mêmes ports. Le mode tout en local sur oMLX et la
connexion des runners à un compte OMP (`harness.sh login`) restent propres à
`harness.sh`.

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
    "tests": { "touched": "npm run -s test:touched -- {files}", "full": "npm test", "pattern": "test/**/*.test.ts" },
    "checks": { "lint": "npm run -s lint" },
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

### Sauvegarder et restaurer la base

Runs, décisions, escalades et journal vivent dans `harness.sqlite`, sous `dataDir`
(`/var/lib/omp-harness/state` avec systemd, `~/.omp-harness/state` en conteneurs).
Le service en prend lui-même des instantanés (`VACUUM INTO` : une copie cohérente,
prise sans l'arrêter) dans `<dataDir>/backups` : `harness-periodique-<date>.sqlite`
chaque jour, `harness-migration-<date>-v<n>.sqlite` avant chaque migration du
schéma (`n` : la version d'avant). Réglages : `backups.*` (§ Configuration). Copie
ce dossier hors du serveur si le disque compte.

Pour restaurer, service arrêté (une restauration ramène la base à la date de la
copie : ce qui a suivi est perdu, les worktrees et les branches restent) :

```bash
# avec systemd
sudo systemctl stop omp-harness
sudo rm -f /var/lib/omp-harness/state/harness.sqlite-wal /var/lib/omp-harness/state/harness.sqlite-shm
sudo install -o omp-harness -g omp-harness -m 0600 \
  /var/lib/omp-harness/state/backups/harness-periodique-<date>.sqlite /var/lib/omp-harness/state/harness.sqlite
sudo systemctl start omp-harness

# en conteneurs (docker, ou podman)
docker compose -p omp-harness stop harness
cd ~/.omp-harness/state
rm -f harness.sqlite-wal harness.sqlite-shm
cp backups/harness-periodique-<date>.sqlite harness.sqlite
docker compose -p omp-harness start harness
```

Une copie d'avant migration se restaure de même, avec la version du service qui
l'a écrite : une version plus récente la migre à nouveau au démarrage.

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
| `repos[].merge` | `local` | `local` : squash sur `main` puis push ; `gh` : une PR posée en `gh pr merge --squash --auto`, le run reste `merging` jusqu'à la fusion constatée (checks requis de la branche protégée) |
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
| `models.fast`, `models.standard`, `models.heavy` | `[]` | la chaîne de modèles de chaque niveau, dans l'ordre de bascule sur une cause de `runner.failoverOn` (429, 5xx, réseau) ; vide, elle prend celle du niveau au-dessus ; un admin les remplace depuis les apps (`PUT /v1/models`) |
| `stepTiers` | `req`, `specs`, `review` : `heavy` ; `impl`, `fix` : `standard` | le niveau de chaque étape ; la dernière correction avant le plafond passe toujours en `heavy` |
| `providers.<nom>` | — | `capacity` et `refillPerMinute` : le débit permis par fournisseur (ceux déclarés depuis les apps s'y ajoutent) |
| `providersEnvFile`, `providersModelsFile` | `providers.env`, `providers.models.yml` à côté de `tokenFile` | les clés et le `models.yml` des fournisseurs déclarés depuis les apps |
| `review.specsGate` | `"auto"` | la feature attend ta validation entre `/specs` et `/impl` : `true` toujours, `false` jamais, `"auto"` seulement si les specs découpent, laissent `## Modules` vide, touchent à l'irréversible, ou ouvrent un projet |
| `review.fixCap` | `3` | les corrections automatiques avant de te passer la main |
| `review.maxDiffLines` | `300` | au-delà, pas d'auto-merge |
| `review.autoMergeRisk` | `"medium"` | le risque le plus haut du verdict qui s'auto-merge encore (`"low"` pour serrer) |
| `review.diffCount` | `"code"` | les lignes comptées face à `maxDiffLines` : `"code"` exclut tests, docs, CHANGELOG, manifestes et verrous ; `"all"` compte tout |
| `review.escalationTimeoutSec` | `3600` | passé ce délai, une escalade ouverte (sauf une suppression) est tranchée sur la recommandation de l'agent, décision `auto_timeout` à relire ; `null` : jamais |
| `review.mergeRetries` | `3` | les merges arrêtés (conflit, suite rouge, fusion refusée ou non constatée) relancés seuls — après 5, 15 puis 60 min — avant de te passer la main ; à part des corrections |
| `review.crossProvider` | `true` | la revue commence la chaîne de son niveau au premier modèle d'un autre fournisseur que celui de la dernière implémentation (une chaîne à un seul fournisseur ne change rien) |
| `challenge.steps` | `["req", "specs"]` | les étapes relues par le contradicteur avant leur clôture ; `[]` le coupe |
| `challenge.tier` | `"heavy"` | le niveau du contradicteur ; il commence la chaîne au premier modèle d'un autre fournisseur que l'auteur relu |
| `review.mergePollSec`, `review.mergeWaitSec` | `60`, `7200` | en mode `gh`, la cadence de relecture de la PR (`gh pr view`) après `--auto`, et l'attente maximale de sa fusion ; au-delà, le merge est arrêté (`mergeRetries`) |
| `runner.retryBackoffSec` | `[120, 600, 1800]` | l'attente avant chaque relance d'une étape échouée ; sa longueur est le nombre de relances si `stepRetries` n'est pas déclaré. Quota, réseau, fournisseur, délai : la liste se consomme entière, même cause répétée ; contexte, runner, sortie manquante, inconnu : deux fois de suite ⇒ l'humain. Liste épuisée ⇒ l'humain (`retry` relance), jamais `failed` |
| `runner.stepRetries` | longueur de `retryBackoffSec` | le nombre de relances d'une étape échouée |
| `runner.failoverOn` | `["rate_limit", "server_error", "network"]` | les causes d'échec d'un prompt qui font basculer sur le fournisseur suivant de la chaîne |
| `notify.url`, `notify.events` | `null`, escalades, specs prêtes, verdict, échec, projet fini, merge, feature muette, budget dépassé, plafond journalier atteint | une URL ntfy (ou webhook) qui reçoit un POST par événement de la liste : corps texte court, en-têtes `Title` (RFC 2047 si accentué), `Priority`, `Tags`, `Click` (la PR d'un merge) ; `null` : aucune notification. Fire-and-forget : une erreur d'envoi n'arrête rien et n'est journalisée (`notify_failed`) qu'une fois par heure |
| `memory.runnerMode` | `true` | les agents reçoivent `MEM0_MODE=runner` : pas de rappel mémoire par tour ni d'épinglage, les outils `mem0_*` restent |
| `dreams.checkMinutes` | `60` | le rêve de la mémoire (§ La mémoire du projet) : chaque dépôt au repos (aucun run en cours) est examiné au plus toutes les N minutes ; `null` coupe les rêves. Sans `oracle`, rien |
| `dreams.minFacts`, `dreams.maxDelayHours` | `5`, `24` | la session de rêve ne part que s'il y a au moins `minFacts` faits nouveaux en mémoire, ou un fait nouveau qui attend depuis `maxDelayHours` heures ; `POST /v1/dreams` passe outre |
| `dreams.tier` | `"standard"` | le niveau de modèle de la session de rêve |
| `repos[].tests.pattern` | `null` | le glob des fichiers de test (`test/**/*.test.ts`) qui filtre `{files}` de `tests.touched` ; aucun fichier retenu ⇒ « aucun test touché », réussi |
| `repos[].checks` | `{}` | des commandes nommées (`{ "lint": "bash scripts/lint.sh" }`) que l'agent lance par `run_tests {scope: "check", check: "lint"}` |
| `runner.slots`, `heavy.slots` | `5`, `2` | agents et jobs de tests simultanés |
| `runner.memoryMax`, `heavy.memoryMax` | `1G`, `4G` | le plafond mémoire de chacun |
| `heavy.timeoutSec` | `1800` | la durée maximale d'un job de tests |
| `heavy.env` | `{}` | l'environnement des tests, et rien d'autre |
| `oracle` | `{ "url": "http://127.0.0.1:8321" }` (posé par l'installation) | la mémoire du projet ; `null` la coupe |
| `listen` | `127.0.0.1:8790` | l'écoute de l'API, publiée par Tailscale |
| `repos[].maxParallel` | `null` | les runs de ce dépôt vivants à la fois, au plus : un gros dépôt ne prend pas tous les runners aux autres |
| `runner.stepTimeoutSec` | `5400` | la durée maximale d'une étape (prompts, relance et bascules compris) : au-delà, le runner est arrêté et l'étape échoue, relançable |
| `events.retentionDays` | `30` | le journal d'événements est purgé au-delà (au démarrage, puis chaque heure), le direct des sessions aussi |
| `backups.intervalHours`, `backups.keep` | `24`, `7` | un instantané de la base toutes les 24 h (le premier au démarrage si le dernier a plus d'un intervalle), les 7 derniers gardés ; `intervalHours: null` les coupe |
| `backups.beforeMigration` | `true` | un instantané juste avant de migrer le schéma d'une base existante (les 7 derniers gardés) ; s'il échoue, le service refuse de migrer et ne démarre pas |
| `backups.dir` | `null` (`<dataDir>/backups`) | le dossier des instantanés (0700, fichiers 0600) : un autre disque, ou un montage sauvegardé ailleurs |
| `health.tickStaleSec`, `health.minFreeMiB` | `120`, `1024` | les seuils de `GET /v1/health` : le dernier tour du scheduling date de moins de 120 s, il reste au moins 1 Gio libre sous `dataDir` et `worktreesDir` ; au-delà, 503 |
| `monitoring.runBudgetUsd`, `monitoring.pauseOnBudget` | `null`, `false` | le coût (en dollars, d'après omp) d'une feature au-delà duquel tu es prévenu (`budget_exceeded`) ; avec `pauseOnBudget`, la feature attend aussi ton accord : l'étape en cours est arrêtée dès que son coût franchit le plafond (sans attendre sa fin, jusqu'à `stepTimeoutSec`), et une relance lui accorde un budget de plus |
| `monitoring.dailyBudgetUsd` | `null` | le plafond de dépense de tout le serveur sur le jour UTC (runs et audits). Atteint : les étapes en cours finissent, mais aucune étape ni analyse ne démarre — chaque feature retourne en file avant sa prochaine étape (`admission_refused`, raison `daily_budget`), `daily_budget_reached` part une fois par jour — jusqu'à minuit UTC ou un plafond relevé ; tout repart alors seul |
| `monitoring.stallMin`, `monitoring.stallToolMin` | `15`, `45` | les minutes sans un mot de l'agent avant l'alerte `stalled` (la seconde quand un outil tourne, une suite de tests par exemple) ; `null` : jamais |
| `monitoring.slowFactor` | `2` | une étape plus longue que ce multiple de la médiane de son type alerte (`step_slow`) ; `null` : jamais |
| `monitoring.fixLoop` | `2` | à partir de ce nombre de corrections, la boucle revue ⇄ correction alerte (`fix_loop`) ; `null` : jamais |
| `monitoring.sampleSec`, `monitoring.keep` | `15`, `480` | la santé du serveur (`GET /v1/metrics`) : un point toutes les 15 s, les 2 dernières heures gardées en mémoire |
| `apns` | `null` | `{ keyFile, keyId, teamId, topic, sandbox }` : la clé `.p8` d'Apple qui met à jour les Live Activities de l'app iOS app fermée ; `null` : elles ne bougent que l'app ouverte |
| `clientsFile` | à côté de `tokenFile` | les clients nommés (empreintes de jetons, rôles, dépôts), relu à chaque changement ; illisible (JSON cassé à la main), le dernier jeu lu reste en vigueur, l'erreur est journalisée une fois et `add`/`revoke` refusent de l'écraser |

Un `kill -HUP` du service (`harness.sh reload`, ou `systemctl kill -s HUP
omp-harness`) relit la configuration et recharge les dépôts : un dépôt ajouté sert
tout de suite, un dépôt retiré qui a encore des runs vivants est gardé jusqu'à leur
fin. Une configuration invalide est refusée, l'ancienne reste en place.

## Une feature, pas à pas

- **Artefacts tracés.** /req écrit des besoins `B-n : verbe objet contraintes` et
  des critères `AC-n (B-m) : Given/When/Then` co-signés par leur besoin. /specs
  ajoute un relevé du dépôt (chemins, symboles, conventions avec leurs lignes, pour
  que /impl ne relise pas le dépôt), des spécifications `S-n (AC-…)` assez précises
  pour écrire le test avant le code, une section `## Modules` obligatoire et un
  `## Découpage` (`split_feature` au-delà du plafond de diff). /impl nomme chaque
  test avec son `AC-n`, pose un `checkpoint` après chaque incrément cohérent,
  corrige `specs.md` plutôt que d'implémenter à côté d'une spec ambiguë, et note
  dans `## Reste` ce qui n'est pas livré.
- **Ce que le service vérifie en fin d'étape** (`steps.ts`). /specs : `## Modules`
  vide, un besoin `B-n` sans critère `AC-m (B-n)` ou un critère cité par aucune
  `S-k (AC-m)` valent une relance, puis un échec `missing_output`. Un `## Découpage`
  qui liste des features (`- titre — demande — modules`) devient un projet
  « Découpage de « … » » (une seule fois, même si tu refais /specs), le run
  courant garde sa part. /impl : un `## Reste` non vide ouvre un run de suite
  « Suite de « … » » sur les mêmes modules (une seule fois).
- **Interruption.** Une étape coupée (échéance, fournisseur, réseau, runner mort)
  laisse un commit `wip(<étape>): interrompu (tentative N)` et la tentative
  suivante reçoit la consigne de repartir de `git diff <base>` et de l'artefact,
  pas de zéro. L'échec porte sa cause (`timeout`, `rate_limit`, `network`,
  `provider`, `context`, `runner`, `missing_output`, `aborted`, `other`) : la
  machine en déduit la relance, son délai, ou le passage à l'humain.
- **Contradicteur.** En fin de /req et de /specs (`challenge.steps`), avant que le
  run ne prenne l'artefact pour acquis, l'auteur rend son runner et un agent neuf le
  relit en lecture seule (`challenge.ts`) : autre contexte et, si la chaîne de
  `challenge.tier` en a un, autre fournisseur que l'auteur. Il cherche ce qui ferait
  livrer autre chose que ce qui était demandé — lecture concurrente de la demande,
  besoin manquant ou inventé, critère qu'une implémentation fausse satisferait, cas
  limite ouvert, spec intestable ou hors besoins — et rend au plus 8 constats
  (`challenge_report`), chacun avec l'extrait qui le prouve et une gravité
  (`bloquant`, `majeur`, `mineur`). Ce qu'il a écrit est jeté. L'auteur, sur un runner
  neuf, corrige ou réfute chaque constat non mineur dans la section `## Contradicteur`
  de l'artefact (`C-n : corrigé — …` / `C-n : réfuté — …`, une relance s'il en manque) ;
  une ambiguïté de produit devient une `clarification`. Un bloquant réfuté ou laissé
  sans réponse est un **désaccord** : la porte des specs (`"auto"`) le soumet à
  l'humain avec le rapport (`contradicteur.md`, événement `challenge`). Un
  contradicteur en panne ne bloque rien (événement `challenge` en échec). Il relit
  l'artefact fini, à la porte : il ne surveille pas l'étape pendant qu'elle travaille.
- **Specs gelées.** À la clôture de /specs, le service garde une copie des specs
  (celles que tu valides). /impl peut corriger une spec ambiguë dans `specs.md`, mais
  la revue et l'auto-merge jugent sur les critères de la copie : un critère retiré ou
  réécrit depuis est montré à la revue (texte validé et texte actuel), doit figurer
  dans sa table, et refuse l'auto-merge (« critère(s) validé(s) modifié(s) depuis
  /specs »). Un critère ajouté doit être prouvé, sans bloquer.
- **Décisions.** Ce que les specs, la mémoire ou le code ne tranchent pas, l'agent
  le tranche par l'option la plus réversible, avec l'outil `decision` (`chosen` et
  2 à 4 `options`). Le service en fait un commit `decision: … → …` (point de
  reprise). Chaque décision porte sa situation (`context`, en Markdown) : tu la
  lis depuis l'app, au milieu de tes autres projets, sans la session sous les
  yeux ; le service refuse une décision sans elle. Une question de produit ou d'UX non tranchée (`clarification`) se décide
  de la même façon, seul : tu pourras renverser après coup. Une décision cite
  celles dont elle découle (`dependsOn`).
- **Escalades.** Schéma de données, API publique, suppression : l'agent ne
  l'applique pas, contourne et termine le reste. Avant d'escalader, le service
  cherche dans la mémoire une décision que tu as déjà tranchée (tag
  `harness,decision`, score ≥ 0,8, même catégorie) : s'il en trouve une, ta
  réponse s'applique comme un checkpoint « tranché par l'humain le … (souvenir …) »,
  sans question. Sinon l'escalade porte l'option recommandée par l'agent, sa
  raison (`rationale`) et ce qu'emporte chaque option (`impacts`, exigés). Les
  questions partent ensemble en fin d'étape, et l'étape reprend quand tu as tout
  répondu.
- **Renverser une décision.** Ta raison rejoint la mémoire. Si rien n'en découle,
  rien n'est annulé : l'étape en cours (ou une correction après la revue) applique
  ta nouvelle option sur le code actuel. Si des décisions en découlent, le service
  reverte les commits de la décision et de ses dépendantes : seules celles-là
  tombent, le travail indépendant fait après reste dans l'arbre (si le revert entre
  en conflit, retour dur au point de reprise et les indépendantes sont
  réappliquées). Après un merge, le commit squash est reverté sur `main` et un run
  de suite s'ouvre. Une décision prise à l'échéance d'une escalade (`auto_timeout`)
  se renverse comme les autres.
- **Revue.** Elle tourne de préférence chez un autre fournisseur que celui qui a
  implémenté (`review.crossProvider` : premier modèle d'un autre fournisseur dans la
  chaîne de son tier), et lit req, specs puis le diff : elle juge critère par critère
  avant d'ouvrir `impl.md`, dont le compte rendu ne prouve rien.
  À l'entrée de la première revue (après le rebase), le service met la
  suite complète en route avant même le prompt ; le `run_tests scope: full` de
  l'agent rejoint ce job. L'agent de revue lit req, specs et impl, relit le diff
  complet à la première passe et seulement le diff depuis la revue précédente
  ensuite (`sinceSha` = HEAD à la fin de la revue précédente ; chaque bloquant
  levé est vérifié un par un ; suite complète seulement quand il n'en reste
  aucun — si elle manque encore, le service la réclame une fois), puis rend un
  verdict structuré (`review_verdict`) avec une table AC par AC (`criteria` : id,
  test nommé, `pass` | `fail` | `untested`) et une confiance honnête. Une suite
  complète rouge devient un bloquant « suite complète rouge : … », quoi qu'en dise
  la revue. Auto-merge si : aucun bloquant, risque ≤ `review.autoMergeRisk`, suite
  verte sur l'arbre exact, diff court (`review.diffCount`), aucune escalade
  ouverte, confiance forte, chaque `AC-n` de specs.md prouvé `pass`, et tous les
  fichiers touchés relus. Un point non vérifié ne bloque que s'il cite un `AC-n` ;
  sinon tu valides, et tu lis le code si le verdict est faible.
- **Correction.** L'agent reçoit le verdict complet (bloquants, risques, points
  non vérifiés), corrige, et écrit `.harness/fix.md` : chaque levée avec sa
  preuve.
- **Merge.** Rebase sur `main`, squash, puis push sur le distant. Un push refusé par le
  dépôt (branche protégée, droit manquant) n'est **pas** un merge : le run attend
  l'humain avec la raison (« push refusé : … », événement `push_failed`) ; une
  coupure réseau est réessayée trois fois avant. En mode `gh`, la PR est posée en
  `--auto` et le run reste `merging` jusqu'à ce que GitHub l'ait fusionnée. Un merge
  arrêté (conflit, suite rouge, fusion non constatée) repart seul après 5, 15 puis
  60 min (`review.mergeRetries`). Mergée mais mauvaise ? `POST /v1/runs/{id}/revert` :
  le commit squash est défait sur `main` (poussé, ou PR de revert en mode `gh`),
  événement `reverted`, et un run de suite reprend la feature. L'oracle garde de chaque
  feature mergée son résumé, ses modules, ses risques résiduels, ce que la revue n'a pas
  vérifié et ses décisions — celles prises seules marquées « (choix de l'agent, non
  validé) ».

## La mémoire du projet

L'oracle du serveur **est** la mémoire mem0 du projet, la même que celle des
sessions du Mac une fois appairé (`/pair`, README racine § « Installation »).

- **Même portée.** Une portée non déclarée est calculée à partir des manifestes de
  `main` (`package.json`, `pyproject.toml`, `Cargo.toml`, `Package.swift`, puis
  `.xcodeproj`), avec la même table que le plugin (`omp-mem0-memory/state.ts`).
  `GET /v1/status` l'affiche par dépôt.
- **Agents branchés.** Chaque agent charge le plugin mémoire (`runner.extensions`)
  avec `MEM0_PROJECT_ID=<portée>`, `MEM0_AUTOSETUP=0` (rien n'est écrit dans le
  dépôt, donc rien dans la PR), `MEM0_NUDGE=0` et, avec `memory.runnerMode`
  (vrai par défaut), `MEM0_MODE=runner` : ni rappel par tour ni épinglage — la
  section Oracle du prompt est la seule source, et les outils `mem0_*` restent pour
  écrire les pièges durables en fin d'étape. Le service écrit lui-même en mémoire
  les besoins, chaque feature mergée et chaque correction humaine **avec sa
  raison**.
- **Isolée.** `mem0-rs` tourne dans son conteneur (base en `~/.omp-harness/mem0`), ou
  sous `omp-mem0` avec systemd (base en `/var/lib/omp-mem0`, 0700), hors du budget
  des runs. Un jeton commun le relie au service et aux agents ; les jobs de tests ne
  voient ni la base ni le jeton. Injoignable, la mémoire dégrade sans bloquer.

**Le rêve de la mémoire** (`dreams.ts`). Quand un dépôt est au repos, le service lit
le dossier de consolidation de sa portée dans mem0-rs (`GET /memory/dream/dossier` :
les faits écrits depuis la dernière consolidation, les faits qui leur sont reliés, les
observations et les mental models). S'il y a assez de nouveau (`dreams.minFacts`, ou
un fait qui attend depuis `dreams.maxDelayHours`), un runner (`dreams.tier`, même
session que les audits) le relit en LECTURE SEULE dans un worktree détaché de `main` —
le dépôt fait autorité contre un souvenir — et rend par l'outil hôte
`dream_consolidate` des **observations** (croyances fondées sur des faits, affinées
plutôt qu'écrasées), des liens de **cause**, les observations devenues fausses et les
**mental models** périmés réécrits. mem0-rs valide et applique d'un bloc ; un refus
(une preuve qui n'est pas un fait de la portée…) revient au modèle avec sa raison, qui
corrige et rappelle l'outil. Rien n'est persisté côté harness : le filigrane vit dans
mem0-rs, et un rêve interrompu reprend au prochain examen. Chaque rêve publie
`dream_state` (`dreaming`, puis `done`, `skipped` ou `failed`). Les autres phases du
rêve (réindexation, paires proches, oubli) tournent dans mem0-rs, sur son propre LLM
(`mem0-stack/mem0-rs/README.md` § Rêve).

**Reprendre la mémoire du Mac**, avant d'écrire quoi que ce soit sur le serveur (même
modèle d'embedding des deux côtés, `EMBEDDING_DIMS`). Sur le Mac, copie sa base :

```bash
sqlite3 ~/Library/Application\ Support/com.omp.console/mem0-rs/mem0-rs.db ".backup /tmp/mem0-rs.db"
scp /tmp/mem0-rs.db <vps>:/tmp/
```

Puis sur le VPS :

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
| `admin` | tout, plus gérer les clients (`/v1/clients`), les fournisseurs LLM, les abonnements et les modèles (`/v1/providers`, `/v1/oauth`, `/v1/models`) |

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

## Les fournisseurs LLM, déclarés depuis les apps

Un client `admin` déclare les fournisseurs et choisit les modèles depuis l'écran
« Fournisseurs » des apps Mac et iOS (ou `/v1/providers`, `/v1/models`), sans toucher
au serveur :

- **les fournisseurs connus d'omp** — `anthropic`, `openai`, `openrouter`, `google`,
  `mistral`, `xai` : une clé suffit (elle va dans la variable qu'omp lit déjà :
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`…) ;
- **les fournisseurs compatibles OpenAI** (`openai-compatible`) — Ollama, vLLM,
  LiteLLM, un oMLX joint par Tailscale… : un nom (`vps-ollama`), une adresse
  (`http://127.0.0.1:11434/v1`), un protocole (`openai-completions` par défaut), des
  modèles (`{id, contextWindow?, maxTokens?}`) et, au besoin, une clé
  (`VPS_OLLAMA_API_KEY`). Ils sont écrits dans le `models.yml` des runners.

- **les abonnements** (`oauth`) — Claude Pro/Max, ChatGPT Plus/Pro, Gemini, Z.AI… :
  aucune clé, une connexion OAuth menée depuis les apps (section « Abonnements »). omp
  la déroule chez les runners (`omp --mode rpc --profile pipeline`, même image et même
  HOME qu'eux) et confie à l'app deux gestes : ouvrir le lien dans un navigateur, puis
  coller le code d'autorisation ou l'URL de retour. Les identifiants restent dans le
  HOME des runners : ils ne passent ni par le service, ni par l'API, ni par la base.
  Cet omp ne reçoit aucune clé ; comme omp refuse de démarrer sans modèle, il porte
  une clé factice d'un fournisseur sans abonnement (`GROQ_API_KEY`), qui ne fait
  paraître aucun abonnement connecté.
  Un abonnement qu'aucune chaîne ne pourrait nommer (`openai-codex`…) est déclaré
  `oauth` à la connexion ; `anthropic` (Claude Pro/Max) garde sa sorte. Une connexion
  à la fois ; en isolation systemd, elle se fait au terminal
  (`sudo -u omp-runner -H omp --profile pipeline`, puis `/login`). Les fournisseurs
  qu'omp ne sait connecter qu'au terminal (GitHub Copilot) rendent son message.

Puis les chaînes : pour chaque tier (`fast`, `standard`, `heavy`), la liste ordonnée
des `fournisseur/modèle` à essayer (bascule sur le suivant après un rate limit, un 5xx ou une panne réseau ; seul de sa chaîne, un fournisseur est réessayé après son `retry-after`). Une
capacité et un remplissage par minute (`capacity`, `refillPerMinute`) donnent au
fournisseur son seau à jetons. Tout s'applique au prochain runner, sans redémarrage,
et survit aux redémarrages (base SQLite, `providers`/`settings`).

**Les clés n'entrent jamais en base ni dans une réponse.** Elles vivent dans
`providers.env` (0600, à côté du jeton : `providersEnvFile`), et arrivent aux runners
selon l'isolation :

| Isolation | Clés | `models.yml` des compatibles |
|---|---|---|
| `none` | ajoutées à l'environnement du runner | `providersModelsFile` (à poser soi-même) |
| `container` | `providers.env` monté en `/run/secrets/providers.env`, lu (jamais sourcé) par l'entrée | écrit dans le HOME monté des runners, bloc `omlx` d'un `up --omlx` gardé |
| `systemd` | lues par le lanceur root (`PROVIDERS_ENV_FILE`) : seulement des `*_API_KEY` aux valeurs simples | posé par le lanceur sous `~omp-runner/.omp/profiles/<profil>/agent/`, écrit **par** `omp-runner` (`runuser`) |

Une clé déclarée ici passe après `runner.env` (écrit par root) et l'emporte ; les
autres variables de `runner.env` restent à root. Le lanceur ne lit un fichier du
service que s'il est régulier, n'est pas un lien et n'appartient pas à root.

## API

`Authorization: Bearer <jeton>` sur toutes les routes, sauf `GET /v1/health` (version
du service, `api`, `features`). La colonne « Rôle » est le rôle minimal.

`GET /v1/health` vérifie aussi le service : `checks.db` (une lecture de la base),
`checks.scheduler` (`ageSec`, l'âge du dernier tour du scheduling, borné par
`health.tickStaleSec`) et `checks.disk` (`freeMiB`, le moins libre de `dataDir` et
`worktreesDir`, borné par `health.minFreeMiB`). Au moindre échec il répond **503**
avec `ok: false`, le corps gardant `api`, `version` et `features` : la sonde des
piles compose (`healthcheck` du service `harness`) et toute supervision lisent le
code, un client qui ne veut que la version lit le corps quel que soit le code.

Le flux `GET /v1/events` est borné : un client qui ne lit plus est coupé dès que
4 Mio l'attendent (il reprend par `Last-Event-ID`, rien n'est perdu), le jeton est
relu à chaque ping (toutes les 15 s : un client révoqué perd aussi son flux ouvert)
et le rejeu d'un retard va par lots de 500, au rythme où le client lit.

| Route | Rôle | Effet |
|---|---|---|
| `GET /v1/me` | viewer | Le client du jeton : nom, rôle, dépôts. |
| `GET /v1/status` | viewer | Compteurs par état et par dépôt, runs vivants, slots et files d'attente, `MemAvailable`, jetons par fournisseur. |
| `GET /v1/repos` | viewer | Les dépôts que le client voit (nom, scope, branche, merge, `maxParallel`). |
| `GET /v1/runs?state=…&repo=…` · `POST /v1/runs` `{repo, title, request, modules?, req?, priority?}` | viewer · operator | Lister, créer. `repo` est un **nom** déclaré dans la configuration, jamais un chemin. `req` : le compte rendu de besoins établi en /req interactif (section `## Besoins`) ; le run part alors de /specs. Sans `modules`, ils sont déduits de l'oracle avant l'admission (événement `modules`). |
| `GET /v1/runs/{id}` | viewer | Run (avec sa révision `rev`, aussi en `ETag`, `notBefore`, `mergeRetries`, `lastFailCause`), étapes, décisions, escalades (avec `recommended`, `options`, `context`, `rationale`, `impacts`), tests, artefacts. |
| `GET /v1/runs/{id}/session?before=…&limit=…` | viewer | Le direct de la session du runner, écrit en base (rejouable, même après un redémarrage ; rétention de `events.retentionDays`) : une page d'entrées (`entries`, les 200 dernières par défaut, celles qui précèdent `before` sinon) et `more` s'il en reste de plus anciennes, `live` (le run est conduit en ce moment) et `cursor`, le curseur du journal d'où suivre la suite par `GET /v1/events?run={id}&live=1&after={cursor}`. |
| `GET /v1/runs/{id}/session/{seq}` | viewer | Une entrée du direct et son détail, jamais poussé dans le flux : pour un outil, `view` (son rendu lisible, comme dans le terminal d'OMP : `{headline, blocks, agents}`, chaque bloc `{kind, role, title, format, text, fields, items, agents}` — `kind` parmi `text`, `fields`, `list`, `agents`, `format` parmi `markdown`, `code`, `diff`, `command`, `plain`, `role` un code que les apps traduisent ; voir `tool-view.ts`), `args` et `result` (le JSON brut de ses arguments et de son résultat, 32 000 et 64 000 caractères au plus) et `output` (sa sortie entière, 64 000 caractères au plus, début et fin gardés) — ceux qui s'écrivent s'il tourne encore ; pour un paragraphe plus long que son entrée, son texte entier dans `output`. Secrets masqués ; 404 si l'entrée est inconnue. `GET /v1/audits/{id}/session/{seq}` : la même chose pour l'analyse d'un audit. |
| `POST /v1/runs/{id}/escalations` `{answers: [{id, answer, reason?}]}` | operator | Répondre au lot, avec ta raison si tu en as une (elle part dans l'oracle). Le run reprend quand tout est répondu. |
| `POST /v1/runs/{id}/decisions/{n}/accept` · `POST /v1/runs/{id}/decisions/accept` | operator | Accepter une décision prise seule, ou toutes celles du run d'un geste (`{accepted: n}`). |
| `POST /v1/runs/{id}/decisions/{n}/reverse` `{option, reason}` | operator | Renverser : correction sur l'état courant, ou revert des commits de N et de ses dépendantes si des décisions en découlent (retour dur au checkpoint N seulement si ce revert entre en conflit). Run mergé : revert du squash sur `main` puis run de suite. Raison dans l'oracle. |
| `POST /v1/runs/{id}/validate` `{approve, reason?}` | operator | Valider les specs (run en `awaiting_human` à l'étape `specs`) ou un verdict, ou les refuser avec une raison : /specs refait, ou correction. La raison part dans l'oracle. |
| `POST /v1/runs/{id}/cancel` | operator | Annuler (la branche reste). |
| `POST /v1/runs/{id}/retry` | operator | Relancer un run `failed` ou `awaiting_human` à son étape, tout de suite (409 sinon). |
| `POST /v1/runs/{id}/revert` | operator | Défaire le commit squash d'un run mergé sur `main` et ouvrir un run de suite (`{run}`) ; 409 si le run n'est pas mergé. |
| `POST /v1/runs/{id}/priority` `{priority}` | operator | Changer la priorité d'admission (et de la file des tests). |
| `GET /v1/escalations` | viewer | Escalades ouvertes, **batchées par run** (écran iOS). |
| `GET /v1/decisions?status=auto,auto_timeout` | viewer | La relecture du matin : les décisions prises seules par l'agent, ou à l'échéance d'une escalade. |
| `GET /v1/inbox` | viewer | La boîte de l'humain d'un appel : escalades batchées, runs à valider (specs ou verdict), décisions prises seules (à part, hors du compte bloquant `pendingCount` = escalades ouvertes + runs en attente), features en cours, audits ouverts, curseur du flux. Chaque escalade et chaque décision dit l'étape qui l'a posée (`step`). |
| `GET /v1/projects` · `POST /v1/projects` `{repo, title, priority?, features: [{title, request, modules?}]}` · `GET /v1/projects/{id}` | viewer · operator · viewer | /project. La liste porte le décompte des runs de chaque projet par état. Le projet et ses runs naissent dans la même transaction. |
| `GET /v1/audits` · `POST /v1/audits` `{repo, focus?}` · `GET /v1/audits/{id}` | viewer · operator · viewer | /audit : `queued` → `analysing` → `proposed`. Chaque proposition rendue porte `kind`, `modules`, `rationale`, `evidence` (`fichier:ligne`, non vide pour une faiblesse), `dependsOn` (index des propositions prérequises), `impact` et `effort` (`low` · `medium` · `high`). |
| `GET /v1/dreams` · `POST /v1/dreams` `{repo}` | viewer · operator | Le rêve de la mémoire : le dernier rêve de chaque dépôt (`state` `dreaming` · `done` · `skipped` · `failed`, `facts`, `reason`, `report` de mem0-rs) ; `POST` demande un rêve, examiné au prochain tour sans seuil de faits ni attente du repos (202 ; 409 sans oracle). |
| `POST /v1/audits/{id}/launch` `{items: [index], title?}` · `POST /v1/audits/{id}/cancel` | operator | Lancer les propositions retenues en projet (ordonnées selon `dependsOn` : une feature prend un `projectOrder` postérieur à ses prérequis retenus ; 400 si les dépendances bouclent), ou annuler. |
| `GET /v1/stats` | viewer | Les statistiques des dépôts du client, avec l'état du scheduler. Les séries du tableau de bord de l'Accueil : `runs.byDay` (les 14 derniers jours, chacun présent : créés, mergés, échoués), `runs.byRepo` (par dépôt : en cours, mergés, échoués, mergés sur 7 jours), `usage.byRepoLast7Days` (le coût de chaque dépôt sur 7 jours). |
| `GET /v1/clients` · `POST /v1/clients` `{name, role?, repos?}` · `DELETE /v1/clients/{name}` | admin | Lister, créer (le jeton n'est rendu qu'à la création), révoquer. |
| `GET /v1/providers` | admin | Les fournisseurs (déclarés par l'API ou par la configuration, `source`), leurs modèles et limites, `hasKey` et `keyHint` (4 derniers caractères) — jamais la clé ; les chaînes de modèles en vigueur (`models`, `modelsSource`), les sortes et protocoles permis. |
| `PUT /v1/providers/{name}` `{kind, apiKey?, baseUrl?, api?, models?, capacity?, refillPerMinute?}` · `DELETE /v1/providers/{name}` | admin | Déclarer ou modifier un fournisseur (`apiKey` absent : la clé reste ; `""` : retirée), le retirer (409 tant qu'une chaîne le nomme). Événement `providers_changed`. |
| `PUT /v1/models` `{models: {fast, standard, heavy} \| null}` | admin | Les chaînes de modèles de chaque tier (`[{provider, model}]`) ; `null` revient à celles de la configuration. |
| `GET /v1/oauth` | admin | Les fournisseurs qu'omp sait connecter en OAuth (`providers: [{id, name, available, authenticated}]`, l'état chez les runners) et la connexion en cours (`login`, ou `null`). |
| `POST /v1/oauth/{name}/login` | admin | Lance la connexion OAuth d'un fournisseur (201, `login`) ; 409 si une autre est en cours, 501 en isolation systemd. |
| `GET /v1/oauth/logins/{id}` · `POST /v1/oauth/logins/{id}/answer` `{value}` · `DELETE /v1/oauth/logins/{id}` | admin | L'état d'une connexion (`state` : `starting`, `waiting`, `verifying`, `done`, `failed`, `cancelled` ; `url`, `instructions`, `prompt`, `progress`, `error`), le code ou l'URL de retour copiés du navigateur (409 si elle n'en attend pas), l'abandon. |
| `GET /v1/events?run=…&live=1` | viewer | SSE, filtré par les dépôts du client. `id:` = curseur du journal. Événements journalisés : `run_created`, `run_state`, `run_failed`, `priority`, `step_started`, `step_done`, `step_timeout`, `checkpoint`, `split`, `follow_up`, `decision`, `decision_auto_timeout`, `escalation`, `escalations` (le lot), `review`, `specs_ready`, `verdict`, `retried`, `audit_state`, `heavy_*`, `rate_limited`, `model_failover`, `rebased`, `merge_queued`, `merged`, `push_failed`, `reverted`, `revert_failed`, `project_done` (le dernier run d'un projet est terminal : `merged`, `notMerged`), `notify_failed`, `progress`… (catalogue : `events.ts`). `live=1` ajoute `activity` (les outils des runners) et `session` (le direct des sessions : `payload.entry` = `{seq, at, step, kind, text, tool, status, detail, call, endedAt, hasDetails, agents}`, `kind` parmi `text`, `thinking`, `tool`, `notice` ; un outil porte son appel en une ligne (`call` : sa commande, son chemin, ses sous-agents…) à côté de son intention (`text`), la fin de sa sortie (`detail`, mise à jour au plus toutes les 500 ms tant qu'il tourne) et `endedAt` ; un appel `task` porte ses sous-agents en une ligne chacun (`agents` : `{id, name, agent, status, task, activity}`, mis à jour en direct) ; un appel `progress` n'est pas un outil mais un paragraphe de l'agent (`kind: text`) ; `hasDetails` : le détail se lit par `GET /v1/runs/{id}/session/{seq}` ; une entrée de même `seq` remplace la précédente, un paragraphe qui s'écrit est renvoyé entier au plus toutes les 500 ms ; textes bornés, secrets masqués) : éphémères, sans `id:`, jamais rejoués. |

Les gestes acceptent `If-Match: "<rev>"` (412 si le run a changé depuis). Un rôle
insuffisant rend 403, un dépôt non permis 403 à la création et 404 en lecture. Une
erreur imprévue rend 500 `erreur interne (réf. <8 hex>)` : sa cause (qui peut citer un
chemin ou une commande) ne va qu'au journal du service, sous la même référence.

## Architecture

| Case du schéma | Où | Ce qui le garantit |
|---|---|---|
| **Clients** : HTTPS + SSE, auth, point d'entrée unique | `http.ts`, `auth.ts`, `queries.ts` | Un jeton par client (empreinte SHA-256, comparée en temps constant), un rôle, des dépôts permis ; chaque route déclare son rôle minimal. Écoute sur `127.0.0.1` ; Tailscale ou un reverse proxy TLS publie l'API. Le flux SSE se rejoue depuis `Last-Event-ID`, filtré par dépôt. |
| **SQLite** : source de vérité, un seul écrivain | `db.ts` (façade de `db/`, un fichier par domaine), `events.ts` | Runs, étapes, décisions (checkpoints), escalades, artefacts, journal d'événements, cache heavy et tests lancés. Seul le service ouvre la base. Runners et jobs heavy passent par lui. Transactions réentrantes : les abonnés ne voient un événement qu'au COMMIT. Migrations numérotées (`PRAGMA user_version`). |
| **Pipeline Service** : machine à états, reprise au checkpoint, relances différées | `machine.ts`, `context.ts`, `orchestrator.ts`, `steps.ts` | Machine pure, table des transitions (`TRANSITIONS`) : toute écriture d'état passe par `context.transition`, en compare-and-swap, avec ses événements dans la même transaction. Une boucle async par run actif. Au redémarrage, chaque run `running` revient à son dernier commit (checkpoint) et repart avec un nouveau runner. Une étape qui échoue pour une cause relançable est remise en file avec `notBefore = maintenant + runner.retryBackoffSec[tentative]`. Les causes qui se résolvent en attendant (`rate_limit`, `network`, `provider`, `server_error`, `timeout`) consomment toute la liste, même répétées ; les autres (`context`, `runner`, `missing_output`, `other`) passent à l'humain dès deux échecs de suite. Liste épuisée ⇒ `awaiting_human` avec la cause (l'humain relance par `retry`) ; `failed` est réservé au non relançable. Un correcteur qui ne change rien conteste : la revue repart dans un runner neuf, et la seconde contestation passe à l'humain. Un run `failed` ou `awaiting_human` se relance (`retry`) à son étape. |
| **Scheduler** : 5 runners, 2 heavy, jetons par fournisseur, MemAvailable, équité | `scheduler.ts`, `orchestrator.ts` | Un slot runner par run vivant, admis au meilleur rang (priorité, reprise, dépôt et projet les moins servis, ancienneté), dans la limite de `repos[].maxParallel` ; un run dont `notBefore` n'est pas passé, ou dont les modules sont encore en déduction, n'est pas candidat. Un slot heavy par `run_tests`, attendu dans une file (priorité puis arrivée). Un seau à jetons par fournisseur (un jeton par prompt) avec bascule. Admission seulement si `MemAvailable − enveloppe ≥ réserve`. Un refus d'admission est écrit une fois par attente. À chaque tour, les escalades ouvertes depuis plus de `review.escalationTimeoutSec` sont tranchées sur la recommandation de l'agent. |
| **/project** : modules, parallèle si disjoint, rebase, merge immédiat | `planner.ts`, `orchestrator.ts` | Modules déclarés, sinon lus dans le texte de la feature et ses souvenirs de besoins (tag `besoins`) — pour un run seul aussi, avant son admission —, puis précisés par la section `## Modules` des specs ou l'outil `set_modules`. Les modules connus sont les dossiers jusqu'à deux niveaux, les fichiers de la racine, et les fichiers `.ts` d'un dossier plat (plus de 8). Chevauchement par préfixe de chemin, et un ensemble inconnu chevauche tout. Rebase sur `main` avant /review. En cas de conflit, le service fusionne `main` et le runner résout les marqueurs dans les fichiers, sans git. Merge squash dès la validation ; un merge arrêté est relancé seul (`review.mergeRetries`, 5/15/60 min). |
| **Runners OMP** : 1 par étape, 1 Go, profil pipeline, échéance, bascule | `runner.ts`, `runner-session.ts`, `rpc.ts`, `host-tools.ts` | `omp --mode rpc --no-ui --no-lsp --profile pipeline` dans un service transitoire (`systemd-run --wait --pipe`, stdio gardés) `MemoryMax=1G`, `OOMScoreAdjust=300`, qui n'écrit que dans son worktree et ne lit que son clone (§ Sécurité). Une seule session pour les runs et les audits : bascule de fournisseur, changement de tier, et échéance de l'étape (`runner.stepTimeoutSec`) au-delà de laquelle le runner est arrêté. Chaque erreur de prompt est classée (`classifyPromptError` : `rate_limit` — 429/529 et messages de quota —, `server_error` 5xx, `network`, `context`, `other`) ; une cause de `runner.failoverOn` fait passer au fournisseur suivant de la chaîne (`set_model`, même conversation) ; chaîne à un seul fournisseur (ou tous à sec) ⇒ attente du `retry-after` du fournisseur (sinon 60 s), bornée par l'échéance, puis réessai du même, 3 fois au plus (`provider_retry`). L'erreur rendue à l'étape porte `cause` et `retryAfterMs`. Le runner de la revue reste vivant pendant review → fix (cache de prompt) ; fix → review repart à neuf. Les autres meurent en fin d'étape ou à l'escalade. |
| **Merges** : un dépôt à la fois, jamais « merged » avant `main` | `merger.ts` | Une file par dépôt : deux merges du même dépôt ne se disputent jamais `main`, le second se rebase sur le premier ; les dépôts différents mergent en parallèle. Mode `gh` : `gh pr merge --squash --auto`, puis `gh pr view` toutes les `mergePollSec` jusqu'à la fusion constatée (borne `mergeWaitSec`). Mode `local` : un push refusé ⇒ `awaiting_human` « push refusé : … », réseau ⇒ réessayé. Merge arrêté ⇒ `queued` avec `notBefore` (5/15/60 min), compté dans `mergeRetries`. `revert(run)` : `git revert` du squash dans un worktree jetable, push (ou PR `--auto`), événement `reverted`, run de suite. |
| **Notifications** : ntfy, fire-and-forget | `notify.ts`, `context.ts` | Abonné au journal (`store.onEvent`) : chaque événement de `notify.events` part en `POST notify.url` avec `Title`/`Priority`/`Tags`/`Click`. Le titre est français et court (« Question — <feature> », « Verdict à valider — … », « Mergé — … »). Une erreur est journalisée (`notify_failed`) au plus une fois par heure, jamais levée. |
| **Politique de décision** | `decisions.ts` | Outil hôte `decision` (`options` obligatoires, 2 à 4, `chosen` parmi elles ; `context`, la situation lisible hors de la session, obligatoire ; `impacts`, une conséquence par option, obligatoires pour une escalade). Une décision réversible — ou une `clarification` de produit/UX — devient un commit WIP `decision: … → …` (trailer `Harness-Decision: run/N`, remappé après rebase). Le schéma de données, l'API publique et les suppressions partent en escalade, batchée en fin d'étape. Le service durcit une catégorie, il ne l'adoucit jamais. Une décision cite celles dont elle découle (`dependsOn`). |
| **Heavy** : systemd, 4 Go, 300 %, user dédié, sans réseau ni clé, cache, dédoublonnage, OOM | `heavy.ts`, `proc.ts` | Le runner attend, bloqué sur `run_tests`. Le cache est lu avant tout lancement, par clé tree hash du répertoire de travail + commande + env ; seul un VERT y entre, un rouge frais est relancé une fois (`heavy_fail_retry`) et jamais resservi. Deux appels de même clé partagent un seul process (`heavy_joined`) ; l'arrêt d'un appelant le désabonne, le dernier parti tue le job (SIGTERM puis SIGKILL, unité arrêtée, slot rendu). Scope `touched` : `tests.pattern` filtre les fichiers, aucun retenu ⇒ vert « rien lancé » (`heavy_skipped`) ; scope `check` : une commande nommée de `repos[].checks`, une clé de cache par nom. Un OOM donne un échec structuré et 2 relances, sans entrée de cache. |
| **Worktrees** : 1 par run, artefacts, WIP, petites PR, caches de build, revert ciblé | `git.ts` | Branche `harness/<slug>`. Artefacts dans `.harness/` (exclu de git, versés dans la base). `CARGO_TARGET_DIR` par worktree, sccache et store pnpm partagés. Le tree hash du cache heavy part d'une copie de l'index du worktree (git ne relit que ce qui a changé). `diffLines(mode)` : `code` ignore `test/**`, `*.test.*`, `Tests/`, `*.md`, `CHANGELOG*`, `package.json`, `*.lock` — ce qui compte face à `review.maxDiffLines` (`review.diffCount`). `revertRange(de, à)` défait une plage de commits en un seul commit `revert: …` (checkpoints vides sautés) ; un conflit est abandonné, l'arbre rendu propre, et ses fichiers rendus — le renversement d'une décision ne perd plus le travail indépendant. |
| **Oracle** : mem0-rs, scope projet | `oracle.ts` | Lu par toutes les étapes et /project (`recall`), et par les escalades (`recallDecisions` : les souvenirs `harness,decision` seulement, filtrés ici car mem0-rs ne filtre les étiquettes que par égalité stricte). En écriture : les besoins `B-n` du compte rendu (`briefOfReq`, ≤ 500 car.), chaque feature mergée (knowledge-updater : résumé, modules, risques, non vérifié, décisions) et chaque décision humaine **avec sa raison**, sa catégorie, ses options et son contexte. Rendu au prompt avec l'étiquette principale et la date courte. Injoignable, il dégrade sans bloquer. |
| **Backends LLM** : trois tiers, multi-provider | `config.ts` (`models`, `stepTiers`), `machine.ts` (`stepTier`), `runner-session.ts` | Trois chaînes : `models.fast`, `models.standard`, `models.heavy` (une chaîne vide prend celle du tier au-dessus). `stepTiers` donne le tier de chaque étape. Par défaut, heavy là où l'on juge (/req, /specs, /review, qui décide de l'auto-merge) et standard là où l'on exécute des specs précises (/impl, /impl --fix). La dernière correction avant le plafond passe en heavy. Review → fix garde son runner : seul le modèle change (`set_model`, événement `model_tier`). Sur une cause de `runner.failoverOn`, `set_model` fait passer le **même** runner au fournisseur suivant. |
| **Sortie /review** : verdict structuré, auto-merge | `verdict.ts` | Outil hôte `review_verdict`, avec la table AC par AC (`criteria`) et une `confidence` obligatoires. Auto-merge si aucun bloquant, risque ≤ `review.autoMergeRisk`, suite complète **verte sur l'arbre exact** (cache heavy, jamais l'avis du runner), diff ≤ `review.maxDiffLines`, aucune escalade ouverte, confiance forte, chaque `AC-n` des specs gelées à la clôture de /specs (`_specs.baseline.md`), et de ceux ajoutés depuis, en `pass`, aucun critère gelé retiré ou réécrit (`criteriaDrift`), et tous les fichiers touchés (git) relus par la revue. Un point non vérifié ne bloque que s'il cite un `AC-n`. Sinon l'humain lit le verdict, et le code seulement si le verdict est faible. |
| **Système** : zram, oomd, budget 14 Go | `deploy/` | `omp-harness.slice` 16G ⊃ runners 5G + heavy 8G + service 1G. OOM : heavy (800), puis runners (300), jamais le service (-900, `ManagedOOMPreference=omit`). zram 8 Go. |
| **Validation des specs** (ajout) | `machine.ts`, `gestures.ts` | `review.specsGate` (`"auto"` par défaut) : après /specs, le run attend l'humain — toujours (`true`), jamais (`false`), ou seulement si les specs découpent, laissent les modules vides, touchent à l'irréversible, ouvrent un projet ou laissent un désaccord avec le contradicteur (`"auto"`, raisons dans celle du run) —, modules réservés. L'accord lance /impl. Un refus refait /specs avec sa raison, qui part aussi dans l'oracle. |
| **Contradicteur** (ajout) | `challenge.ts`, `steps.ts`, `runner-session.ts` | En fin de /req et /specs : l'auteur rend son runner (un run, un slot, un runner), un runner neuf (`<unité>-contradicteur`, arrêtée aussi à la reprise après redémarrage) relit l'artefact avec `progress`, `oracle_recall` et `challenge_report` seulement ; ses écritures sont jetées (`resetTo` sur le commit de l'auteur, artefacts remis depuis la base). L'auteur répond sur un runner neuf (`<unité>-reponse`). Les passages sont gardés en base (`_contradicteur.json`, invisible) et rendus dans `contradicteur.md`, que seul le service écrit. |
| **/audit** (ajout) | `audits.ts` | Un runner lit `main` dans un worktree détaché, sans rien commiter, et rend jusqu'à 10 propositions (faiblesse ou feature, modules, `evidence` fichier:ligne obligatoire pour une faiblesse, `dependsOn` par titre — résolu en index, refusé s'il est inconnu, se cite ou boucle —, `impact`, `effort`) par l'outil hôte `audit_propose` ; l'appel est refusé avec la raison tant que ces règles ne tiennent pas. Le prompt reçoit les runs ouverts du dépôt et les souvenirs « Feature mergée » (rappel `feature mergée <dépôt>`) pour ne pas proposer de doublon. Une analyse qui échoue (runner, réseau, échéance) repart une fois, runner et worktree neufs, avant `failed` ; pas quand le modèle a répondu sans proposer. L'humain choisit : les propositions retenues partent en projet, planifié comme un /project, dans l'ordre topologique de `dependsOn`. |
| **Rêve de la mémoire** (ajout) | `dreams.ts` | Un dépôt au repos dont la mémoire a assez de faits nouveaux est confié à un runner en lecture seule (worktree détaché de `main`), qui consolide le dossier de mem0-rs en observations, causes et mental models par l'outil hôte `dream_consolidate` ; mem0-rs valide et applique d'un bloc, un refus revient au modèle. Après l'admission des runs : un rêve ne prend qu'un slot que nul run n'attend. |
| **Statistiques** (ajout) | `stats.ts` | Calculées à la demande sur la base : runs par état, taux de merge, délai médian, étapes et durées, corrections, tests heavy (cache, relances), décisions, audits. |
| **Boucle humaine** | `gestures.ts`, `http.ts` | Les gestes d'un run passent un par un, chacun dans une transaction, avec son auteur ; `If-Match` refuse un geste fait sur une vue périmée. Répondre aux escalades (avec une raison, qui part dans l'oracle avec les options et le contexte), relancer un run échoué ou en attente (`retry`), accepter une décision ou toutes d'un geste, renverser une décision. Si rien ne découle de la décision N, il n'y a pas de retour arrière : l'étape en cours (ou une correction après la revue) applique l'option sur l'état courant, et les autres décisions tiennent. Si des décisions en découlent (`dependsOn`, transitivement), le service **reverte** les commits de N et de ses dépendantes (du checkpoint N au checkpoint de la première survivante postérieure, sinon HEAD) : le travail indépendant d'après reste dans l'arbre, les checkpoints tiennent ; si ce revert entre en conflit, retour dur au checkpoint N et les indépendantes sont réappliquées par consigne. Un run déjà mergé : revert du commit squash sur `main`, puis un run de suite qui porte l'option (si le revert ne passe pas — push refusé —, événement `revert_failed` et run de suite seul). Sans réponse humaine passé `review.escalationTimeoutSec`, chaque escalade ouverte (jamais une suppression, ni une escalade sans recommandation) reçoit l'option recommandée : décision `auto_timeout` avec son checkpoint, renversable comme les autres, événement `decision_auto_timeout`, souvenir tagué `harness,decision,auto_timeout`, et le run reprend. |

## Sécurité et écarts assumés au schéma

- **Runners et heavy en services transitoires, pas en `--scope`.** Une scope ne
  porte ni `User=`, ni `PrivateNetwork=`, ni bac à sable de fichiers. Runner et job
  partent donc en `systemd-run --wait --pipe` : mêmes limites cgroup, stdio gardés,
  plus l'isolation demandée.
- **Un runner systemd vaut un conteneur.** Sans bac à sable, les worktrees (créés en
  `UMask=0002`, inscriptibles par `omp-work`) et les clones étaient lisibles et
  inscriptibles d'un dépôt à l'autre : un agent du dépôt A pouvait écrire dans le
  worktree vivant du dépôt B, qui s'auto-merge, par-dessus le cloisonnement des
  clients. Le lanceur impose donc au runner `User=omp-runner`, `NoNewPrivileges`,
  `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, masque
  tous les worktrees et tous les clones (`TemporaryFileSystem=… :ro`) puis rend son
  seul worktree en écriture (`BindPaths`) et son seul clone en lecture
  (`BindReadOnlyPaths`, `REPOS_ROOT/<dépôt>` : `/var/lib/omp-harness/repos/<dépôt>`),
  et cache l'état du service, la mémoire et les sockets de l'hôte (`RUNNER_HIDDEN`).
  Seul son HOME s'ajoute en écriture. Ses clés (`runner.env`, puis les `*_API_KEY` de
  l'API, puis la scope mémoire) passent par un fichier root 0600 de
  `/run/omp-harness-launcher` que systemd lit au démarrage (`EnvironmentFile=`) :
  jamais sur la ligne de commande ni dans les propriétés de l'unité, que tout user
  local lit. Sans lanceur (`launcher: []`), un runner systemd est refusé plutôt que
  lancé en root.
- **Le service durci sans casser sudo.** `NoNewPrivileges` reste éteint (sudo vers le
  lanceur). Sous `User=`, systemd ne pose un filtre seccomp qu'avec
  `NoNewPrivileges=yes`, qu'il impose alors : `ProtectKernel*`, `PrivateDevices`,
  `RestrictAddressFamilies`, `LockPersonality`, `RestrictRealtime`,
  `RestrictSUIDSGID` (qui interdirait de plus le setgid des dossiers de worktrees)
  sont donc écartés. Restent les espaces de montage : `ProtectSystem=full`,
  `ProtectHome`, `PrivateTmp`, `ProtectControlGroups` (systemd-run demande les unités
  à PID 1, il n'écrit pas les cgroups). `strict` est écarté : le lanceur, lancé dans
  cet espace, écrit sous `/run` et dans le HOME des runners, et les dossiers de
  données se déplacent par la configuration.
- **Les outils du runner sont des outils hôtes RPC.** `decision`, `progress`,
  `oracle_recall`, `checkpoint` et `set_modules` à toutes les étapes,
  `split_feature` en /specs et /impl, `run_tests` (`touched` | `full` | `check`) dès
  /impl et `review_verdict` en revue sont déclarés par `set_host_tools` et exécutés
  par le service. Le runner n'a ni accès à la base ni jeton d'API, et rien n'est à
  installer dans son profil.
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
  - côté runner, la commande est épinglée sur `OMP_BIN`, le worktree est exactement
    `WORKTREES_ROOT/<dépôt>/<feature>` et le clone `REPOS_ROOT/<dépôt>`, et le
    lanceur pose lui-même l'user `omp-runner`, le bac à sable et les clés de
    `/etc/omp-harness/runner.env`, que root seul lit.

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
la dernière boîte, signalée hors ligne. « Session en direct », sur une feature, lit
`GET /v1/runs/{id}/session` puis suit ses événements `session` : ce que l'agent écrit,
son raisonnement et chaque outil, avec sa commande et son résultat, en temps réel
(ses arguments et sa sortie entière s'ouvrent par `GET /v1/runs/{id}/session/{seq}`) — et, en onglets,
les fichiers touchés et leurs différences, la sortie des tests en direct et la frise.
L'Accueil montre les alertes de la veille et le coût des features ; Statistiques, la
consommation, la comparaison des modèles, les tests instables et la santé du serveur ;
l'iPhone suit une feature sur l'écran verrouillé (Live Activity, poussée par APNs
quand `apns` est configuré). Le client est partagé
(`omp-console/Sources/ConsoleClient/Harness*.swift`) : voir `omp-console/README.md`
§ « Serveur de pipelines ».

### Les Live Activities app fermée (APNs)

L'iPhone peut suivre une feature sur l'écran verrouillé (« Suivre sur l'écran
verrouillé », menu d'une feature). App ouverte, l'app met l'activité à jour elle-même ;
app fermée, c'est le serveur qui la pousse par APNs, avec le jeton que l'app lui
enregistre (`POST /v1/push/activities` ; `DELETE /v1/push/activities/{jeton}` ne retire
que les jetons du client qui appelle, tous pour un admin). Il lui faut une clé d'Apple (compte du
programme développeur) :

1. Sur developer.apple.com, *Certificates, Identifiers & Profiles ▸ Keys ▸ +* :
   cocher **Apple Push Notifications service (APNs)**, enregistrer, puis télécharger
   la clé `AuthKey_<KEYID>.p8` (une seule fois possible). Noter son **Key ID**, et le
   **Team ID** (en haut à droite du compte).
2. Copier la clé sur le serveur, lisible par lui seul : dans le dossier de données
   (`~/.omp-harness/apns.p8` en conteneurs, `OMP_HARNESS_ROOT` avec Portainer,
   `/var/lib/omp-harness/apns.p8` avec systemd), `chmod 600`.
3. Dans `config.json` :

   ```json
   "apns": {
     "keyFile": "/chemin/absolu/apns.p8",
     "keyId": "<Key ID>",
     "teamId": "<Team ID>",
     "topic": "com.omp.console.ios",
     "sandbox": true
   }
   ```

   `topic` est l'identifiant de bundle de l'app iOS (changé si tu l'as changé dans
   Xcode). `sandbox` vaut `true` pour une app installée depuis Xcode, `false` pour
   TestFlight ou l'App Store.
4. `harness.sh restart` (ou `systemctl restart omp-harness`).

Une activité dont le jeton est refusé par Apple est oubliée ; sans `apns`, rien ne
part et l'activité ne bouge que l'app ouverte.
