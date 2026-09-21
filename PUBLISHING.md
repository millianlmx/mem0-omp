# Publier sur GitHub et installer via le marketplace

Ce dépôt est **à la fois** le marketplace et le plugin. Un seul repo, une seule
commande d'ajout côté utilisateur.

## Structure

```
mem0-omp/                              ← racine du dépôt = marketplace
├── .omp-plugin/marketplace.json       ← catalogue, chemin lu par OMP
├── .claude-plugin/marketplace.json    ← copie, repli compatible Claude Code
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

Le catalogue est du contenu de dépôt : un `git push` suffit, il n'y a rien à
republier ailleurs.

```bash
# bump dans les 4 fichiers porteurs de version, puis
./scripts/check.sh && git commit -am "chore: v2.4.0" && git push
```

Le bump se fait dans **quatre** fichiers : `omp-mem0-memory/package.json`,
`omp-mem0-req/package.json`, `.omp-plugin/marketplace.json` et
`.claude-plugin/marketplace.json` — les deux catalogues doivent rester identiques
octet pour octet.

L'invariant est celui que `./scripts/check.sh` vérifie, et c'est le seul qui
compte : le champ `version` de chaque entrée de `plugins[]` **égale** la `version`
du `package.json` du plugin visé, et `metadata.version` du catalogue **nomme une
version publiée** — l'une des versions d'entrée. Ce dernier champ n'est pas un
compteur libre : s'il ne correspond à aucune version de plugin, `/plugins list`
affiche un numéro qui n'existe nulle part.

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
