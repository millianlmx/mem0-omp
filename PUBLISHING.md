# Publier sur GitHub et installer via le marketplace

Ce dépôt est **à la fois** le marketplace et le plugin. Un seul repo, une seule
commande d'ajout côté utilisateur.

## Structure

```
mem0-omp/                              ← racine du dépôt = marketplace
├── .omp-plugin/marketplace.json       ← catalogue, chemin lu par OMP
├── .claude-plugin/marketplace.json    ← copie, repli compatible Claude Code
├── CHANGELOG.md                       ← journal des versions, écrit par le job de release
├── omp-mem0-memory/                   ← le plugin mémoire
│   ├── package.json                   ← déclare omp.extensions
│   ├── extension.ts
│   └── install.sh                     ← chemin manuel, hors marketplace
├── omp-mem0-req/                      ← le plugin pipeline (/req → /specs → /impl → /review)
│   ├── package.json                   ← déclare omp.extensions
│   └── extension.ts
├── mem0-stack/                        ← le service mem0, à lancer séparément
│   └── mem0-http/                     ← l'API HTTP et sa config mem0
├── test/                              ← suite de tests, hors publication
├── scripts/check.sh
└── .github/workflows/check.yml
```

Deux fichiers font tout le travail, et ce sont ceux qu'on rate le plus souvent :

**`.omp-plugin/marketplace.json`** — le catalogue. OMP le lit en priorité, et
retombe sur `.claude-plugin/marketplace.json` s'il est absent. Publier les deux
rend le dépôt installable depuis OMP *et* depuis Claude Code. `scripts/check.sh`
vérifie qu'ils n'ont pas divergé, parce que rien d'autre ne le fera.

**`omp-mem0-memory/package.json`** — sans la clé `omp.extensions`, le plugin
s'installe sans erreur et l'extension n'est **jamais chargée**. Pas de message,
pas de commande `/mem0-*`, rien. C'est le mode de défaillance numéro un d'un
plugin marketplace.

```json
{ "omp": { "extensions": ["./extension.ts"] } }
```

Pointe un **fichier**, pas un dossier. Une entrée-dossier n'est résolue que si
elle contient un `index.{ts,js,mjs,cjs}` direct ; sinon l'installation est
rejetée à la validation, ou l'extension est silencieusement ignorée au runtime
(oh-my-pi#2713).

## Avant de pousser

```bash
# 1. Remplace le handle GitHub dans les fichiers qui portent une URL de dépôt :
grep -rl 'github.com/' . --exclude-dir=.git --exclude-dir=node_modules

# 2. Valide
./scripts/check.sh
```

Cette commande liste exactement cinq fichiers — `README.md`,
`.omp-plugin/marketplace.json`, `.claude-plugin/marketplace.json`,
`omp-mem0-memory/package.json` et ce `PUBLISHING.md` — et c'est elle qui fait
autorité : après une édition, relance-la plutôt que de te fier à cette liste.
Pour un fork, le texte à substituer est le handle : `<ton-handle>`.

Le script vérifie : JSON valide, catalogues synchronisés octet pour octet, règles
de nommage (minuscules, chiffres, tirets et points, début et fin alphanumériques,
64 caractères max), présence du `package.json` de chaque plugin, résolution réelle
de chaque entrée d'extension sur disque, **transpilation des deux `extension.ts`**,
**absence d'import de valeur depuis `@oh-my-pi/*` dans les deux**, cohérence du
tableau `commands` de chaque entrée de catalogue avec les `registerCommand()`
réellement appelés, **cohérence des versions** (voir « Mettre à jour »),
type-check du plugin pipeline contre les types de l'hôte, et la suite de tests.

Le contrôle d'import mérite une explication : `import type { ExtensionAPI }` est
effacé à la compilation, donc l'extension n'a aucune dépendance à résoudre au
runtime. Un `import` de valeur en créerait une, et elle casse selon la
plateforme — c'est la cause de toute une famille de plugins qui ne chargent pas
sous Windows (oh-my-pi#1292) ou qui importent le mauvais scope de package
(oh-my-pi#1889).

## Publier

Amorçage d'un dépôt neuf — **ce n'est pas le chemin de release** : le `git push`
initial sur `main` n'est admis qu'ici, avant que les workflows existent côté
GitHub. Ensuite, tout passe par la PR de release du job (cf. § Release
automatique), et plus jamais par un push direct sur `main`.

```bash
cd mem0-omp
chmod +x scripts/check.sh omp-mem0-memory/install.sh   # perdu par un unzip
git init -b main
git add .
git commit -m "feat: mémoire mem0 par projet pour oh-my-pi"

gh repo create mem0-omp --public --source=. --push
# ou, sans gh :
# git remote add origin git@github.com:<ton-handle>/mem0-omp.git && git push -u origin main
```

Le dépôt doit être **public** — ou accessible en lecture par le git de la
machine cible, l'installation étant un `git clone`.

## Installer

Côté utilisateur, dans une session OMP :

```
/marketplace add <ton-handle>/mem0-omp
/marketplace install omp-mem0-memory@mem0-omp
/marketplace install omp-mem0-req@mem0-omp
```

C'est bien `/marketplace`, pas `/plugin` : `/plugins` (au pluriel) existe aussi
mais ne sert qu'à lister et activer/désactiver, pas à installer. Équivalents en
ligne de commande :

```bash
omp plugin marketplace add <ton-handle>/mem0-omp
omp plugin install omp-mem0-memory@mem0-omp
omp plugin install omp-mem0-req@mem0-omp
omp plugin list          # vérifier
omp plugin doctor        # diagnostiquer
```

Les deux plugins sont indépendants, l'ordre n'a pas d'importance ; installer les
deux est la seule façon d'avoir la mémoire **et** le pipeline `/req → /specs →
/impl → /review`.

Ajoute `--scope project` pour n'installer que sur le projet courant ; par défaut
l'installation est utilisateur, donc valable partout.

**Redémarre la session après l'installation.** `/reload-plugins` rafraîchit les
skills, commandes et serveurs MCP, mais **pas** les modules d'extension : tant
que tu n'as pas relancé `omp`, les tools `mem0_*` et les commandes `/mem0-*`
n'existeront pas. C'est normal, et c'est la première chose à vérifier avant de
conclure que le plugin est cassé.

## Le stack n'est pas installé par le plugin

Le marketplace ne déploie que du code d'extension. Le service mem0 reste à
lancer à la main, une fois :

```bash
git clone https://github.com/<ton-handle>/mem0-omp
cd mem0-omp/mem0-stack && docker compose up -d
curl http://localhost:8321/health
```

Sans lui, le plugin se charge et se dégrade proprement : le recall renvoie du
vide, les écritures échouent avec un warning, `/mem0-status` affiche
`injoignable`. Aucune session n'est bloquée — c'était un objectif de conception,
pas un effet de bord.

Mentionne-le en tête du README : quelqu'un qui installe le plugin sans lire
verra `/mem0-status` en rouge et n'aura aucune idée de pourquoi.

## Mettre à jour

Le catalogue est du contenu de dépôt : rien n'est à republier ailleurs, et surtout
rien à pousser à la main.

**Ne monte plus les versions à la main.** Les quatre fichiers porteurs de version
— `omp-mem0-memory/package.json`, `omp-mem0-req/package.json`,
`.omp-plugin/marketplace.json` et `.claude-plugin/marketplace.json` (ces deux
derniers doivent rester identiques octet pour octet) — sont écrits par le **job de
release**, au moment de la fusion : il lit la dernière version publiée, déduit le
niveau des commits conventionnels, applique le bump, puis écrit le tag et la
release. Une PR qui modifie un de ces fichiers échoue en CI
(`scripts/no-manual-bump.sh`, étape du job `check`) parce que son bump doublerait
celui du job.

L'invariant, lui, ne change pas, et c'est le seul qui compte : le champ `version`
de chaque entrée de `plugins[]` **égale** la `version` du `package.json` du plugin
visé, et `metadata.version` du catalogue **nomme une version publiée** — l'une des
versions d'entrée. Ce dernier champ n'est pas un compteur libre : s'il ne
correspond à aucune version de plugin, `/plugins list` affiche un numéro qui
n'existe nulle part.

Côté utilisateur :

```
/marketplace update mem0-omp
/marketplace upgrade omp-mem0-memory@mem0-omp
/marketplace upgrade omp-mem0-req@mem0-omp
```

La version d'installation vient du champ `version` de l'entrée de catalogue ; à
défaut de `.claude-plugin/plugin.json`, puis de `package.json`, puis du SHA de
la source, puis `0.0.0`.

Si tu veux figer ce que les gens installent, épingle la source sur un commit
exact plutôt que sur une branche :

```json
"source": { "source": "github", "repo": "<ton-handle>/mem0-omp", "sha": "a1b2c3d4" }
```

## Release automatique

Un merge sur `main` déclenche `.github/workflows/release.yml`, qui exécute
`scripts/release.ts`. **Rien n'est jamais poussé directement sur `main`** : le
commit de release est porté par une PR que le job ouvre puis fusionne lui-même, et
c'est seulement ensuite que les tags et les releases sont publiés.

1. **Plan** — le moteur relit `origin/main`, repère les versions jamais publiées
   (rattrapage) et calcule le bump de chaque plugin touché depuis l'apparition de
   sa version courante ;
2. **Branche** — `release/<sha de l'événement>`, sur laquelle il écrit les
   versions, les deux catalogues et `CHANGELOG.md`, puis prouve le résultat avec
   `./scripts/check.sh` (rouge ⇒ rien n'est committé) ;
3. **PR** — poussée de la branche, puis PR vers `main` ouverte avec le jeton dédié
   (cf. § Jeton de release) ; une PR déjà ouverte pour la branche est réutilisée ;
4. **Statuts requis** — le job attend que les deux statuts de `check.yml` passent
   sur cette PR (`mergeStateStatus` ∈ `CLEAN`, `UNSTABLE`, `HAS_HOOKS`), et échoue
   en le nommant après le budget d'attente ;
5. **Fusion** — squash avec un titre et un corps explicites, puis relecture du sha
   de fusion et vérification que l'arbre fusionné est bien celui qui a passé
   `check.sh` ;
6. **Tags et releases** — tous les tags `<plugin>-v<version>` d'abord, en une seule
   poussée, puis une release GitHub par version, portant les commandes
   d'installation et de mise à jour — et « ce qui casse / quoi faire » pour un bump
   majeur.

```bash
# Ce que la CI exécute — rejouable à la main, et sans rien écrire avec --dry-run :
node --experimental-strip-types scripts/release.ts --before <sha> --after <sha> --dry-run
```

**Règles de décision** — `fix` ⇒ patch, `feat` ⇒ mineure, `!` avant le `:` ou
footer `BREAKING CHANGE:` ⇒ majeure (quel que soit le type) ; les autres types
(`docs`, `chore`, `ci`, `refactor`, `perf`, `test`, `build`, `style`) n'apportent
rien. Un commit ne compte que pour les plugins dont il touche un fichier : un
merge qui ne touche que `README.md`, `scripts/`, `test/` ou `.github/` ne bumpe
rien et ne publie rien.

**Ce que le moteur écrit** — `omp-mem0-*/package.json`, les deux catalogues
(identiques octet pour octet ; `metadata.version` = la plus grande version du
catalogue) et `CHANGELOG.md` à la racine — une section datée
`## <plugin> <version> — <AAAA-MM-JJ>` par version publiée, la plus récente en
tête. Rien d'autre. `check.sh` doit sortir 0, sinon aucun commit, aucun tag,
aucune release n'est créé.

**Rattrapage** — une version historique dont le tag manque sur le remote est
publiée par le prochain run : son tag, sa release et son entrée de `CHANGELOG.md`,
datée du commit où la version est apparue. Le premier run réel rattrape donc tout
l'historique du dépôt — dans l'ordre chronologique d'apparition des versions, qui
n'est pas l'ordre semver (une régression de version publiée est journalisée telle
qu'elle a eu lieu).

**Idempotence** — le commit de fusion porte le trailer
`Release-Event: <sha après>` ; un rejeu du même événement s'arrête sur
`· merge déjà publié` et ne republie rien. Un plugin dont le tag de la version
cible existe déjà est retiré du plan (`· déjà publié (tag …)`), une version déjà
taguée n'est jamais republiée, et une entrée de journal déjà présente n'est jamais
dupliquée. Le plan de bump se recalcule depuis le commit d'apparition de la
version courante, jamais depuis la seule plage de l'événement : un run annulé ou
perdu est donc rattrapé par le run suivant, sans qu'aucun commit ne disparaisse.

**Blocage du merge** — `main` exige les deux statuts de `check.yml`
(`check (ubuntu-latest)` et `check (macos-latest)`), donc un job rouge bloque le
merge. La commande est rejouable telle quelle (elle écrase la configuration
existante) :

```bash
gh api --method PUT -H "Accept: application/vnd.github+json" \
  repos/millianlmx/mem0-omp/branches/main/protection --input - <<'JSON'
{"required_status_checks":{"strict":false,"contexts":["check (ubuntu-latest)","check (macos-latest)"]},"enforce_admins":false,"required_pull_request_reviews":null,"restrictions":null}
JSON
```

Les contextes sont les **noms affichés** des jobs de `check.yml` : renommer un OS
de la matrice sans rejouer cette commande débloquerait le merge en silence. Ce
sont ces deux statuts que la PR de release doit obtenir avant d'être fusionnée —
d'où le jeton dédié de la section suivante, plutôt qu'un `GITHUB_TOKEN` qui ne
déclencherait aucun run.

## Jeton de release

Le job de release publie avec un jeton **dédié**, rangé dans le secret de dépôt
`RELEASE_TOKEN` et lu par `.github/workflows/release.yml`. C'est ce jeton qui
pousse la branche, ouvre la PR, la fusionne, pousse les tags et crée les releases.

Il est **obligatoire** : les événements créés par le `GITHUB_TOKEN` du dépôt ne
déclenchent aucun run de workflow, donc une PR de release ouverte avec lui resterait
indéfiniment à « statuts requis manquants » (les deux `check.yml` ne s'exécuteraient
jamais dessus) — l'auto-fusion ne pourrait pas aboutir. **Ni la pipeline ni le
workflow ne peuvent le créer** : il se crée une fois, à la main, par le
propriétaire du dépôt.

### Créer le jeton (personal access token fine-grained)

Settings → **Developer settings** → **Personal access tokens** → **Fine-grained
tokens** → **Generate new token**, puis :

| Champ | Valeur |
|---|---|
| Token name | `mem0-omp release` (libre) |
| Expiration | 90 jours, et note la date : elle devra être renouvelée |
| Resource owner | le compte propriétaire du dépôt |
| Repository access | **Only select repositories** → `mem0-omp` |
| Permissions | **Contents: Read and write**, **Pull requests: Read and write** — **Metadata: Read** est implicite, toujours incluse |

Rien de plus : ces permissions minimales suffisent au flux complet. Un jeton à
portée large (jeton classique `repo`, ou jeton d'organisation) est un risque
inutile — le job n'en a pas besoin, et il ne doit accéder qu'à ce dépôt.

### Le ranger en secret

Settings → **Secrets and variables** → **Actions** → **New repository secret**,
nom exact **`RELEASE_TOKEN`**, valeur = le jeton. C'est ce nom que lit
`release.yml` ; un autre nom passe inaperçu jusqu'à l'échec du job.

### Quand il manque ou expire

Le jeton absent, vide ou expiré fait échouer le job **à sa première étape**, avant
tout checkout, avec :

```
secret RELEASE_TOKEN absent — le job de release ne peut pas publier.
Crée-le (PUBLISHING.md, § Jeton de release), puis relance cette exécution.
```

Il n'y a **aucun repli** sur le `GITHUB_TOKEN`. La marche à suivre : régénérer un
jeton fine-grained (mêmes permissions, même dépôt), remplacer la valeur du secret,
puis relancer l'exécution concernée — le run suivant rattrape de toute façon ce qui
manque. Un jeton fine-grained inutilisé pendant un an est supprimé automatiquement
par GitHub : un job de release qui tombe sans autre explication mérite un coup
d'œil de ce côté.

## Alternatives

**Chemin manuel, sans marketplace** — `omp-mem0-memory/install.sh` dépose
l'extension dans `~/.omp/agent/extensions/` (surchargeable par
`PI_CODING_AGENT_DIR`), où OMP la découvre seule au démarrage. Aucun
enregistrement dans `settings.json` ou `config.yml` n'est nécessaire : le
dossier `extensions/` du répertoire agent est une racine de découverte native.
Utile pour itérer sur ton propre poste sans passer par un commit.

**Développement local** — pointe un marketplace sur un dossier plutôt que sur
un dépôt :

```
/marketplace add ./chemin/vers/mem0-omp
```

**npm** — `omp plugin install <paquet>` fonctionne pour les paquets npm, mais
les sources `npm` **dans un catalogue marketplace** sont analysées puis rejetées
à l'installation (« npm plugin sources are not yet supported »). Si tu publies
aussi sur npm, garde le catalogue sur une source relative ou `github`.

**Monorepo** — si tu préfères séparer le plugin du stack Docker, la source
`git-subdir` pointe un sous-dossier d'un autre dépôt sans le dupliquer :
`{ "source": "git-subdir", "url": "...", "path": "packages/omp-mem0-memory" }`.
