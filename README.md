# memory-omp

Tu décris une feature à ton agent de code. Un serveur la mène jusqu'au merge :
specs, code, tests, revue. Toi, tu valides les specs et les choix qui engagent,
depuis ton Mac ou ton iPhone. Et d'une session à l'autre, l'agent se souvient de
ton projet.

memory-omp s'installe par-dessus [OMP](https://omp.sh), l'agent de code.

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

Pour que l'app approuve les envois du poste de travail, appaire-la avec le code
approbateur de `harness.sh approver` (§ « Le poste de travail »).

L'app n'installe pas les plugins : c'est l'étape 3, « Les plugins dans omp ».

### Sans Mac : la pile conteneur

Pour avoir la mémoire seule sur une autre machine (Linux, Mac Intel), sans app ni
serveur, démarre le service mémoire toi-même :

```bash
git clone https://github.com/millianlmx/mem0-omp
cd mem0-omp/memory-stack
cp .env.example .env        # ajuste OMLX_BASE_URL
mkdir -p memory-rs-data
podman compose up -d        # ou : docker compose up -d
./doctor.sh                 # teste toute la chaîne et dit quoi corriger
```

Tu as une ancienne pile mem0-http ? Migre-la d'abord :
[memory-stack/README.md](memory-stack/README.md#migrer-une-pile-mem0-http-existante).

### 3. Les plugins dans omp

Dans une session omp :

```
/marketplace add millianlmx/mem0-omp
/marketplace install omp-memory@mem0-omp
/marketplace install omp-memory-req@mem0-omp
```

Puis **relance `omp`** (`/reload-plugins` ne suffit pas). En ligne de commande,
c'est `omp plugin marketplace add millianlmx/mem0-omp` puis
`omp plugin install <plugin>@mem0-omp`, avec `--scope project` pour un seul
projet. Sans marketplace, `omp-memory/install.sh` installe la mémoire seule.

Si tu n'as pas collé le code dans l'app, relie omp au serveur une fois, puis
relance omp :

```
/pair omp1:…
```

Il n'y a rien à faire par projet : au premier démarrage dans un dépôt, le plugin
y pose ses consignes de mémoire.

- **Service mémoire déjà joignable** (serveur, app ou pile conteneur) :
  `/memory-status` le confirme.
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

1. Lance `omp`, puis `/memory-status` : le service répond et le projet est le bon.
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
  éteint ; pour qu'elle approuve les envois du poste, colle-lui plutôt le code de
  `harness.sh approver`. **Sans rien coller :** le Mac affiche un QR code
  (feuille **Serveur**, **Appairer un iPhone**), ou le serveur
  (`harness.sh pair-qr`, avec `qrencode`). L'appareil photo de l'iPhone l'ouvre
  dans l'app, qui reçoit son propre jeton (révocable seul) : le code vaut 10
  minutes et un seul usage.
- **Des souvenirs déjà sur le Mac ?** Copie-les sur le serveur avant d'y écrire :
  [omp-harness/README.md](omp-harness/README.md) § « La mémoire du projet ».
- **Mettre à jour.** Le serveur : `git pull` puis `harness.sh up`, sans rien
  perdre. Les plugins : [PUBLISHING.md](PUBLISHING.md) § « Mettre à jour ». Une
  installation d'avant le renommage de la mémoire : § « Passer aux noms memory
  (mise à niveau) » plus bas.

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

## Le poste de travail

L'extension Chrome `omp-chrome` donne au serveur des yeux et des mains dans ton
navigateur. Elle observe comment tu travailles, transcrit tes meetings et exécute
les actions que l'agent lui demande. Après quelques heures d'observation (8 h par
défaut), l'agent 24/24 du serveur commence à faire seul les petites tâches
répétitives. Tu consultes le profil qu'il a établi et le journal de ses décisions
dans l'app, section **Poste**, sur Mac comme sur iPhone.

**Une règle ne se règle pas.** Avant d'envoyer un message à quelqu'un d'autre que
toi, l'agent te demande toujours la permission, quel que soit le mode. L'envoi
attend ton accord dans l'app (**Accueil** et **Poste**). Sans réponse, il expire et
vaut refus. Un message dont tous les destinataires figurent dans tes adresses part
sans attendre.

**Seules les apps approuvent.** Le code d'appairage ordinaire est lu par omp et par
l'extension : une session omp pourrait s'en servir pour s'approuver elle-même. Les
approbations, les refus et les réglages du poste exigent donc le **code approbateur**,
que seul le serveur imprime :

```bash
bash omp-harness/deploy/container/harness.sh approver   # sur le serveur ; un nouvel appel invalide l'ancien code
```

Avec Portainer, lance `omp-harness-stack approver` dans la console du conteneur
`harness` (**Containers › harness › Console**, `/bin/sh`) ; sous systemd,
`sudo omp-harness-client approver` n'imprime que le jeton.

Colle ce code dans la feuille **Serveur** de l'app, sur le Mac comme sur l'iPhone.
omp (`/pair`) et l'extension le refusent : garde-leur le code de `harness.sh pair`
(avec Portainer, celui des journaux de `pairing`).

Pour installer l'extension, prends `omp-chrome.zip` dans la dernière
[release](https://github.com/millianlmx/mem0-omp/releases) et décompresse-le
(`shasum -a 256 -c omp-chrome.zip.sha256` le vérifie). Ou construis-la dans le clone :

```bash
bash scripts/chrome-extension.sh        # construit omp-chrome/dist
```

Puis, dans Chrome : `chrome://extensions`, **Mode développeur**, **Charger
l'extension non empaquetée**, et choisis le dossier décompressé (ou
`omp-chrome/dist`). Dans les réglages de l'extension, colle le code d'appairage
`omp1:…` et autorise le micro.

La transcription se fait sur ton Mac, par [oMLX](https://github.com/jundot/omlx)
avec un modèle Whisper chargé. Dans les réglages de l'extension, donne l'adresse
d'oMLX (la base `http://127.0.0.1:8000/v1` de son tableau de bord convient), sa clé
d'API s'il en exige une, et le modèle tel que le liste `GET /v1/models` (par exemple
`whisper-large-v3-turbo-4bit`). **Enregistrer** vérifie qu'oMLX répond, accepte la
clé et sert ce modèle ; sinon, **Transcrire cet onglet** refuse de démarrer et dit
quoi corriger. Une erreur en cours de meeting passe l'icône de l'extension à `ERR`.
L'extension refuse toute adresse de transcription qui n'est pas locale. L'audio ne
quitte jamais le Mac, seul le texte part au serveur. Sur l'onglet du meeting, ouvre l'extension
puis **Transcrire cet onglet**. Ta voix (le micro) et celle des autres (l'onglet)
sont transcrites séparément dès l'activation, et c'est à toi de prévenir les
participants.

| Autonomie | Ce que fait l'agent 24/24 |
|---|---|
| Auto (défaut) | Observe jusqu'au seuil d'heures observées, puis agit. |
| Observer | Rien : le profil continue de s'établir. |
| Proposer | Chaque action qu'il envisage attend ton accord. |
| Agir | Fait seul les petites actions, dans sa propre fenêtre de Chrome. |

**L'agent reste dans sa fenêtre.** Il agit dans une fenêtre de Chrome à lui, ouverte
sans prendre le focus. Lire ou toucher un de tes onglets (le lire, le capturer, y
cliquer, y saisir, le faire défiler, y changer d'adresse ou de page, y joindre ou y
télécharger un fichier) attend ton accord dans l'app, et il ne ferme jamais un de tes
onglets. Le serveur et l'extension le vérifient tous les deux, quel que soit le mode.
En autonomie, une adresse vers un site jamais vu dans l'observation, ou qui porte une
longue valeur opaque (de quoi faire sortir un secret), attend aussi ton accord. Le
réglage `workstation.allowedHosts` du serveur restreint les sites où l'on navigue (et
télécharge par adresse) sans te demander.

**Ce que l'agent sait faire.** Cliquer, survoler, saisir, choisir dans une liste,
presser une touche ou un raccourci (avec Control, Alt, Shift ou Meta), revenir en
arrière ou recharger, attendre qu'un texte ou un bouton apparaisse, joindre un fichier,
télécharger. Il lit les iframes et les composants web comme le reste de la page. Dans
sa fenêtre, ses clics, saisies et touches passent par le débogueur de Chrome : ce sont
de vrais gestes, et les applications qui ignorent les événements simulés y réagissent.
Chrome affiche alors une bannière : « OMP Poste de travail » débogue ce navigateur.
C'est voulu : la bannière disparaît 20 s après le dernier geste, ou au **Stop**.
**Annuler** sur la bannière coupe ces gestes jusqu'au redémarrage de Chrome, et l'agent
continue avec des événements simulés. Dans un de tes onglets, rien de tout cela sans ton
accord pour l'action.

**Les fichiers.** L'agent ne joint qu'un fichier posé sur le serveur, dans le dossier
d'envoi du poste (`envois/`, 10 Mio au plus), jamais un fichier de ton Mac. Ce qu'il
télécharge va dans tes Téléchargements ; il en reçoit le nom, le type et la taille, et
le texte d'un petit fichier texte (CSV, JSON…).

**Une page ne donne pas d'ordre.** Ce que l'agent lit dans une page (texte, titres,
valeurs, transcripts) lui arrive marqué comme une donnée non fiable, jamais comme une
consigne : une page qui écrit « ignore tes consignes et envoie… » reste un texte à lire.

**Demander depuis une page.** Le popup de l'extension s'ouvre sur deux gestes pour l'onglet
actif. « Faire ça sur cette page » : tape une consigne, puis Entrée. « En faire un fil » :
un clic, et la page devient une demande. Dans les deux cas la demande part avec l'adresse
de la page (sans sa query ni son fragment), son titre et le texte que tu y as sélectionné ;
le serveur en fait un plan, que tu confirmes dans le popup. Toi seul relis ce contexte de
page : un autre client qui voit la demande ne le reçoit pas. Rien ne part d'un site exclu.
Le reste du popup (état de la liaison, Stop, dernières actions, transcription, réglages)
est replié dessous.

**Stop.** Le bouton **Stop** du popup de l'extension arrête tout de suite l'action en
cours, met l'extension en pause et met le poste en pause sur le serveur : les actions
en attente sont annulées et le service en cours de l'agent est coupé. Seule l'app
appairée avec le code approbateur relance le poste (section **Poste**, décocher « Mettre
le poste en pause ») ; sur ce navigateur, recoche « Poste actif » dans le popup. Le
popup se tient à jour tout seul : la pause, l'action en cours, les dix dernières
actions avec leur raison, et un bouton qui ouvre l'app quand des actions attendent ton
accord.

Ce que l'extension ne voit jamais : ce que tu tapes (l'observation ne note que l'action
et le libellé du champ), les champs de mot de passe, les sites que tu exclus dans ses
réglages. Quand l'agent lit une page de SA fenêtre (ou une des tiennes, avec ton
accord), il en reçoit le texte visible (8 000 caractères au plus), le nom des éléments
et la valeur des champs, sauf les champs secrets (mot de passe, carte, code à usage
unique) ; l'adresse d'un de tes onglets perd sa query. L'observation se met en pause
depuis l'extension ou depuis l'app, et le serveur oublie les observations au bout de
30 jours, les captures d'écran au bout de 24 h.

Dans une session omp, les outils `workstation_status`, `workstation_profile`,
`workstation_activity`, `workstation_meetings`, `workstation_journal` et
`workstation_act` font agir l'agent sur le poste et lui font écouter ce qui s'y
passe. Le détail du serveur : [omp-harness/README.md](omp-harness/README.md)
§ « Le poste de travail ».

## La mémoire

Chaque projet a sa propre mémoire. À chaque tour, l'agent reçoit les souvenirs
utiles à ta demande, et il écrit lui-même ce qui restera vrai. Le sommaire de la
mémoire est exhaustif tant qu'il n'est pas tronqué (60 entrées) ; au-delà, il dit
ce qui manque et l'agent cherche avec `memory_search`.
Le rappel d'un tour tient en 4 000 caractères : un souvenir plus long que
1 200 caractères y est rogné, et `memory_search` le rend entier.

Les souvenirs sont **reliés**. L'agent relie avec `memory_link` un bug à sa cause, une
convention à celle qu'elle remplace ; le rappel et la recherche montrent ces liens
sous chaque souvenir. Et la mémoire **rêve** quand le projet est au repos : elle
propose de fusionner les doublons, consolide les faits en observations et réécrit
une synthèse du projet (architecture, conventions, décisions, pièges, préférences)
que l'agent lit en tête de session. Rien n'est supprimé sans ton accord :
`/memory-dream` montre les propositions.

Le nom du projet vient du manifeste (`package.json`, `pyproject.toml`,
`Cargo.toml`…), sinon du dossier. `/memory-status` affiche celui qui est retenu.

| Commande | Ce qu'elle fait |
|---|---|
| `/memory-status` | Connexion, projet, état de la session. |
| `/memory-init` | Amorce la mémoire d'un dépôt existant. |
| `/memory-save` | Fait écrire maintenant ce que la session a appris. |
| `/memory-dedupe` | Repère les doublons (rien n'est supprimé sans `--apply`). |
| `/memory-dream` | Journal du rêve de la mémoire et propositions à accepter ou refuser. |

<details>
<summary>Variables d'environnement</summary>

| Variable | Défaut | Rôle |
|---|---|---|
| `MEMORY_HTTP_URL` | `~/.omp/memory.json`, sinon `http://localhost:8321` | l'adresse du service mémoire |
| `MEMORY_HTTP_TOKEN` | celui de `~/.omp/memory.json` | le jeton du service, s'il en exige un |
| `MEMORY_PROJECT_ID` | — | force le nom du projet |
| `MEMORY_AUTOSETUP` | `1` | `0` : le plugin n'écrit jamais dans un dépôt |
| `MEMORY_QUIET` | `0` | `1` : souvenirs injectés sans être affichés |
| `MEMORY_NUDGE` | `1` | `0` : pas de relance d'écriture en fin de session |
| `HARNESS_URL`, `HARNESS_TOKEN` | `~/.omp/harness.json` | le serveur et son jeton |
| `HARNESS_REPO` | nom du dossier | le nom du dépôt sur le serveur |
| `OMP_HARNESS_LOCAL_SESSIONS` | `1` | `0` : la session ne se signale pas au serveur ([omp-memory-req/README.md](omp-memory-req/README.md)) |

La configuration du serveur (dépôts, modèles, plafonds) :
[omp-harness/README.md](omp-harness/README.md) § « Configuration ».

</details>

## Passer aux noms memory (mise à niveau)

La mémoire ne s'appelle plus mem0 : le produit, les dossiers, les plugins, le
service, les variables, les outils et les commandes disent désormais « memory ».
Cette version est la **version de transition** : elle lit encore tous les anciens
noms, sans rien déplacer ni supprimer. **Rien à faire pendant la transition** :
chaque installation se met à jour par sa commande habituelle, et garde ses
souvenirs, son jeton et son port. Quand l'ancien et le nouveau nom existent
ensemble, le nouveau l'emporte.

Les replis disparaissent à la **version qui suit** la version de transition (la
première version publiée de chaque composant qui contient ce renommage, commit
`feat(memory)`). Pour ne pas dépendre d'eux, renomme ce qui suit à ton rythme, un
type d'installation à la fois, le service arrêté quand tu déplaces des données.
Les variables d'outillage des contributeurs suivent la même règle : `MEM0_<X>` →
`MEMORY_<X>`.

### Plugins et catalogue

| Avant | Maintenant |
|---|---|
| plugins `omp-mem0-memory`, `omp-mem0-req` | `omp-memory`, `omp-memory-req` |
| outils `mem0_search`, `mem0_add`, `mem0_update`, `mem0_link`, `mem0_forget` | `memory_search`, `memory_add`, `memory_update`, `memory_link`, `memory_forget` |
| commandes `/mem0-status`, `/mem0-init`, `/mem0-brief`, `/mem0-dedupe`, `/mem0-purge-procedures`, `/mem0-save`, `/mem0-dream` | `/memory-status`, `/memory-init`, `/memory-brief`, `/memory-dedupe`, `/memory-purge-procedures`, `/memory-save`, `/memory-dream` |
| en-tête `X-Mem0-Token` | `X-Memory-Token` (les clients à jour envoient les deux) |
| `~/.omp/mem0.json` | `~/.omp/memory.json` |
| `MEM0_HTTP_URL`, `MEM0_HTTP_TOKEN`, `MEM0_PROJECT_ID`, `MEM0_MODE`, `MEM0_AUTOSETUP`, `MEM0_NUDGE`, `MEM0_NO_GLOBAL`, `MEM0_QUIET`, `MEM0_CHECK_DEPTH` | `MEMORY_HTTP_URL`, `MEMORY_HTTP_TOKEN`, `MEMORY_PROJECT_ID`, `MEMORY_MODE`, `MEMORY_AUTOSETUP`, `MEMORY_NUDGE`, `MEMORY_NO_GLOBAL`, `MEMORY_QUIET`, `MEMORY_CHECK_DEPTH` |
| `MEM0_TOKEN_<NOM>`, ce que nomme `memory.tokenEnv` d'un dépôt | `MEMORY_TOKEN_<NOM>` |
| `.omp/mem0-brief.md` d'un dépôt | `.omp/memory-brief.md` |
| bloc `<!-- mem0:brief vN -->` … `<!-- /mem0:brief -->` de `AGENTS.md` | `<!-- memory:brief vN -->` … `<!-- /memory:brief -->` |

Les anciens noms d'outils et de commandes restent des alias de même effet pendant
la transition ; le brief et la documentation ne citent que les nouveaux.

**Passer des anciens plugins aux nouveaux.** Pendant la transition, le catalogue
garde son nom `mem0-omp` (OMP refuse de mettre à jour un catalogue dont le nom a
changé) et porte les quatre entrées. La mise à jour par les commandes habituelles
marche : `omp plugin marketplace update mem0-omp`, puis
`omp plugin upgrade omp-mem0-memory@mem0-omp` et
`omp plugin upgrade omp-mem0-req@mem0-omp` (ajoute `--scope project` pour un
plugin installé sur un seul projet). Elle livre le même code que les nouvelles
entrées, sous les anciens noms de plugins. Pour passer aux nouveaux noms de
plugins, dans cet ordre, **d'abord désinstalle les anciens, ensuite installe les
nouveaux** :

```bash
omp plugin marketplace update mem0-omp
omp plugin uninstall omp-mem0-memory@mem0-omp
omp plugin uninstall omp-mem0-req@mem0-omp
omp plugin install omp-memory@mem0-omp
omp plugin install omp-memory-req@mem0-omp
```

Puis relance `omp`. N'installe **jamais** `omp-memory` à côté d'un
`omp-mem0-memory` qui n'a pas été mis à jour : les outils, le rappel et le
checkpoint seraient en double.

**Le brief des dépôts.** L'ancien `.omp/mem0-brief.md` peut être supprimé : plus
rien ne le lit. Un ancien bloc `mem0:brief` de `AGENTS.md` qui n'a pas été édité est
remplacé par le plugin à jour, au démarrage d'une session locale. Un bloc édité à la
main, ou celui d'un dépôt qui ne voit que des sessions sans autosetup (les runners),
se remplace par `/memory-brief --update` ; sinon il cite, au retrait des replis, des
outils `mem0_*` qui n'existeront plus. Attention : un `--update` lancé avec un plugin
pas encore à jour réécrit l'ancien bloc. Mets le plugin à jour d'abord.

**Le fichier de réglages.** `~/.omp/mem0.json` ne se renomme en `memory.json` qu'une
fois à jour **tous** ses écrivains de la machine : l'appairage (`omp-memory-req`),
l'app Mac et `harness.sh`. Les écrivains à jour écrivent là où les lecteurs lisent
(`memory.json` s'il existe, sinon `mem0.json`) et ne créent jamais `memory.json` ;
un écrivain pas à jour réécrirait `mem0.json`, que le nouveau fichier masquerait.

**À la version qui retire les replis.** Le catalogue devient `memory-omp` : retire-le
puis rajoute-le, puis réinstalle les plugins sous leurs nouveaux noms.

```bash
omp plugin uninstall omp-memory@mem0-omp
omp plugin uninstall omp-memory-req@mem0-omp
omp plugin marketplace remove mem0-omp
omp plugin marketplace add millianlmx/mem0-omp
omp plugin install omp-memory@memory-omp
omp plugin install omp-memory-req@memory-omp
```

Les entrées `omp-mem0-memory` et `omp-mem0-req` disparaissent du catalogue avec les
replis.

### Pile manuelle

| Avant | Maintenant |
|---|---|
| dossier `mem0-stack/`, sa crate `mem0-stack/mem0-rs/` | `memory-stack/`, `memory-stack/memory-rs/` |
| `mem0-rs-data` (`MEM0_RS_DATA_DIR`) | `memory-rs-data` (`MEMORY_RS_DATA_DIR`) |
| `MEM0_RS_PORT`, `MEM0_RS_CONTAINER` | `MEMORY_RS_PORT`, `MEMORY_RS_CONTAINER` |
| image `mem0-rs:local`, binaire `mem0-rs` | `memory-rs:local`, `memory-rs` |
| base `~/.mem0/mem0-rs.db` (`MEM0_DB_PATH`) | `~/.memory/memory-rs.db` (`MEMORY_DB_PATH`) |
| `MEM0_HTTP_TOKEN`, `MEM0_HTTP_TOKENS`, `MEM0_HTTP_TOKENS_FILE`, `MEM0_PORT` | `MEMORY_HTTP_TOKEN`, `MEMORY_HTTP_TOKENS`, `MEMORY_HTTP_TOKENS_FILE`, `MEMORY_PORT` |
| `MEM0_SEARCH_FUSION`, `MEM0_RRF_K`, `MEM0_DREAM_INTERVAL_MINUTES`, `MEM0_DREAM_QUIET_MINUTES`, `MEM0_DREAM_PAIRS`, `MEM0_DREAM_FORGET_DAYS` | `MEMORY_SEARCH_FUSION`, `MEMORY_RRF_K`, `MEMORY_DREAM_INTERVAL_MINUTES`, `MEMORY_DREAM_QUIET_MINUTES`, `MEMORY_DREAM_PAIRS`, `MEMORY_DREAM_FORGET_DAYS` |
| `MEM0_BACKUP_INTERVAL_HOURS`, `MEM0_BACKUP_KEEP`, `MEM0_BACKUP_FILE`, `MEM0_BACKUP_REMOTE_CMD`, `MEM0_BACKUP_REMOTE_TIMEOUT_SECONDS` | `MEMORY_BACKUP_INTERVAL_HOURS`, `MEMORY_BACKUP_KEEP`, `MEMORY_BACKUP_FILE`, `MEMORY_BACKUP_REMOTE_CMD`, `MEMORY_BACKUP_REMOTE_TIMEOUT_SECONDS` |
| `MEM0_LOG_DIR`, `MEM0_LOG_RETENTION_DAYS`, journal `mem0-AAAA-MM-JJ.jsonl` (`src: "mem0"`) | `MEMORY_LOG_DIR`, `MEMORY_LOG_RETENTION_DAYS`, `memory-AAAA-MM-JJ.jsonl` (`src: "memory"`) |
| clé `mem0` de `GET /health`, métriques `mem0_*` | clé `memory`, métriques `memory_*` (les deux sont émises pendant la transition) |
| `MEM0_RS_*` (outillage : binaire, cible, migration) | `MEMORY_RS_*` |

`git pull` renomme `mem0-stack/` en `memory-stack/`, mais laisse dans `mem0-stack/`
ton `.env` et ton dossier `mem0-rs-data/` (git ne les suit pas). Pendant la
transition, la commande habituelle lancée dans `mem0-stack/` (`podman compose up -d
--build`, ou `docker compose`) démarre toujours le service sur ce `.env` et cette
base, par un compose de repli qui reste dans `mem0-stack/`. Dans `memory-stack/`,
`compose up` refuse de démarrer tant que `../mem0-stack/.env` ou
`../mem0-stack/mem0-rs-data/` existe sans son équivalent, et nomme la commande qui
les déplace ; `./doctor.sh` signale les mêmes restes. Pour passer au nouveau
dossier, le service arrêté, depuis `memory-stack/` :

```bash
mv ../mem0-stack/.env ../mem0-stack/mem0-rs-data .
```

Le service redémarre sur les mêmes souvenirs et le même jeton. Pour renommer aussi
le dossier de données, change ensemble `MEM0_RS_DATA_DIR=./mem0-rs-data` en
`MEMORY_RS_DATA_DIR=./memory-rs-data` dans `.env` et `mem0-rs-data` en `memory-rs-data`
sur le disque (`mv mem0-rs-data memory-rs-data`), puis renomme les autres variables
`MEM0_*` de ton `.env`. Si la base porte encore le nom `mem0-rs.db`, renomme-la
aussi, avec ses fichiers voisins (`mem0-rs.db-wal`, `mem0-rs.db-shm`,
`mem0-rs.db.lock`), en `memory-rs.db…`. Le compose de repli de `mem0-stack/`
disparaît avec les replis : après la version qui les retire, seule `memory-stack/`
démarre le service.

### harness.sh

| Avant | Maintenant |
|---|---|
| `${OMP_HARNESS_ROOT}/mem0` | `${OMP_HARNESS_ROOT}/memory` |
| `$SECRETS/mem0.env` et `$SECRETS/mem0/` | `$SECRETS/memory.env` et `$SECRETS/memory/` |
| `OMP_HARNESS_MEM0_PORT`, `OMP_HARNESS_MEM0_ENV`, `OMP_HARNESS_TAILNET_MEM0_PORT`, `OMP_HARNESS_REBUILD_MEM0` | `OMP_HARNESS_MEMORY_PORT`, `OMP_HARNESS_MEMORY_ENV`, `OMP_HARNESS_TAILNET_MEMORY_PORT`, `OMP_HARNESS_REBUILD_MEMORY` |
| `MEM0_URL`, `MEM0_HTTP_TOKEN`, `MEM0_HTTP_URL` (vigie et runners), `CORPO_MEM0_TOKEN` | `MEMORY_URL`, `MEMORY_HTTP_TOKEN`, `MEMORY_HTTP_URL`, `CORPO_MEMORY_TOKEN` |
| service compose `mem0` (`http://mem0:8321`) | service `memory` (`http://memory:8321`) |
| `monitoring/mem0.token` | `monitoring/memory.token` |
| `~/.omp/mem0.json` (écrit par `harness.sh connect` et `disconnect`) | `~/.omp/memory.json` |

Le service compose garde sa clé `mem0` pendant la transition, avec l'alias réseau
`memory` : une configuration qui vise encore `http://mem0:8321` joint toujours le
service. Le profil de supervision lit toujours le jeton dans `monitoring/mem0.token`,
le fichier que tu as créé ; seul son `job_name` est devenu `memory`. Pour passer aux
nouveaux noms à la main, le serveur arrêté, renomme `mem0` en `memory` sous `ROOT`
(`${OMP_HARNESS_ROOT}`, `/var/lib/omp-harness` par défaut) et sous `SECRETS`
(`${OMP_HARNESS_SECRETS}`), le lien compris si `memory` y est un lien vers `mem0` :

```bash
cd "$OMP_HARNESS_ROOT" && { [ ! -L memory ] || rm memory; } && mv mem0 memory
cd "$OMP_HARNESS_SECRETS" && { [ ! -L memory ] || rm memory; } && mv mem0 memory
mv "$OMP_HARNESS_SECRETS/mem0.env" "$OMP_HARNESS_SECRETS/memory.env"   # si ce fichier existe
```

Renomme ensuite les variables `MEM0_*` des fichiers sous `ROOT` et `SECRETS`
(`compose.env`, `published.env`, `memory.env`). À la version qui retire les replis :
clé de service `mem0` → `memory`, et `monitoring/mem0.token` →
`monitoring/memory.token` (renomme le fichier, et le chemin lu par
`prometheus.yml`).

### Portainer

| Avant | Maintenant |
|---|---|
| `${OMP_HARNESS_ROOT}/mem0`, `${OMP_HARNESS_SECRETS}/mem0` | `${OMP_HARNESS_ROOT}/memory`, `${OMP_HARNESS_SECRETS}/memory` |
| `mem0.env` dans les secrets | `memory.env` |
| variables `OMP_HARNESS_MEM0_PORT`, `OMP_HARNESS_TAILNET_MEM0_PORT`, `MEM0_BACKUP_REMOTE_CMD` de la stack | `OMP_HARNESS_MEMORY_PORT`, `OMP_HARNESS_TAILNET_MEMORY_PORT`, `MEMORY_BACKUP_REMOTE_CMD` |
| service compose `mem0`, `oracle.url` = `http://mem0:8321`, `MEM0_HTTP_URL` | service `memory`, `http://memory:8321`, `MEMORY_HTTP_URL` |
| `monitoring/mem0.token` | `monitoring/memory.token` |

La stack se met à jour comme avant (redéploie depuis le dépôt). Pendant la
transition, le dossier `memory` créé au démarrage est un lien vers l'ancien
`mem0`, qui garde données et secrets là où ils sont, et la clé de service `mem0`
garde l'alias réseau `memory`. Pour renommer à la main, la stack arrêtée : même
geste que pour `harness.sh`, sous `ROOT` (`${OMP_HARNESS_ROOT}`) et sous `SECRETS`
(`${OMP_HARNESS_SECRETS}`), en supprimant d'abord le lien `memory` avant de
renommer `mem0` en `memory`, puis `memory/mem0.env` en `memory/memory.env`. Dans le
`config.json` persistant, remplace `http://mem0:8321` par `http://memory:8321`
une fois la clé de service renommée. Le jeton de supervision garde le nom
`monitoring/mem0.token` pendant la transition, puis devient `memory.token`.

### Debian

| Avant | Maintenant |
|---|---|
| unité `omp-harness-mem0.service` | `omp-harness-memory.service` |
| `/etc/omp-harness/mem0.env`, `deploy/mem0.env.example` | `/etc/omp-harness/memory.env`, `deploy/memory.env.example` |
| `/var/lib/omp-mem0`, base `mem0-rs.db` | `/var/lib/omp-memory`, `memory-rs.db` |
| utilisateur et groupe système `omp-mem0` | `omp-memory` |
| `MEM0_DB_PATH`, `MEM0_HTTP_TOKEN`, `OMP_HARNESS_REBUILD_MEM0` | `MEMORY_DB_PATH`, `MEMORY_HTTP_TOKEN`, `OMP_HARNESS_REBUILD_MEMORY` |
| `monitoring/mem0.token` | `monitoring/memory.token` |

`install.sh` arrête et désactive l'ancienne unité, installe la nouvelle sur les
mêmes données et les mêmes secrets, sans en changer la propriété : le service garde
pendant la transition l'utilisateur `omp-mem0` et le dossier `/var/lib/omp-mem0`
(0700). Ne les renomme pas avant : la version de transition tourne encore sous
`omp-mem0`. Au retrait des replis, pour passer au nouveau nom à la main, le
service arrêté et juste avant d'y mettre à jour :

```bash
sudo systemctl stop omp-harness-memory.service
sudo usermod -l omp-memory omp-mem0 && sudo groupmod -n omp-memory omp-mem0
sudo mv /var/lib/omp-mem0 /var/lib/omp-memory
sudo usermod -d /var/lib/omp-memory omp-memory
sudo chown -R omp-memory:omp-memory /var/lib/omp-memory
sudo mv /etc/omp-harness/mem0.env /etc/omp-harness/memory.env
```

Renomme aussi `mem0-rs.db` en `memory-rs.db` (et ses fichiers voisins) dans
`/var/lib/omp-memory`, et fais pointer `MEMORY_DB_PATH` de `memory.env` sur
`/var/lib/omp-memory/memory-rs.db`. Lance ensuite `install.sh` de la version qui
retire les replis, qui redémarre le service.

### NixOS

| Avant | Maintenant |
|---|---|
| `services.omp-harness.mem0.enable`, `services.omp-harness.mem0.environment` | `services.omp-harness.memory.enable`, `services.omp-harness.memory.environment` |
| `services.omp-harness.tailscale.mem0HttpsPort` | `services.omp-harness.tailscale.memoryHttpsPort` |
| utilisateur et groupe système `omp-mem0`, `/var/lib/omp-mem0` | `omp-memory`, `/var/lib/omp-memory` |
| `/etc/omp-harness/mem0.env` | `/etc/omp-harness/memory.env` |
| `MEM0_DB_PATH` (`/var/lib/omp-mem0/mem0-rs.db`) | `MEMORY_DB_PATH` (`/var/lib/omp-memory/memory-rs.db`) |
| unité `omp-harness-mem0.service` | `omp-harness-memory.service` |
| `monitoring/mem0.token` | `monitoring/memory.token` |

Les anciennes options sont acceptées pendant la transition, avec un avertissement
qui nomme leur remplaçante ; si les deux sont posées, la nouvelle l'emporte. Le
module garde l'utilisateur `omp-mem0` et le dossier `/var/lib/omp-mem0` : ne les
renomme pas avant la version qui retire les replis. À celle-ci, renomme tes options
dans ta configuration et, le service arrêté, déplace les données comme sur Debian
(`mv /var/lib/omp-mem0 /var/lib/omp-memory`, `chown -R omp-memory:omp-memory`,
`mv /etc/omp-harness/mem0.env /etc/omp-harness/memory.env`, `mem0-rs.db` →
`memory-rs.db`) avant de reconstruire (`nixos-rebuild switch`) ; le module pose alors
lui-même l'utilisateur `omp-memory` et `MEMORY_DB_PATH`.

### App Mac

| Avant | Maintenant |
|---|---|
| agent launchd `com.omp.console.mem0-rs` (et sa variante `.<12 hex>`), son plist | `com.omp.console.memory-rs` |
| dossier `~/Library/Application Support/com.omp.console/mem0-rs/` (`mem0-rs.db`, `mem0-rs.log`) | `…/memory-rs/` (`memory-rs.db`, `memory-rs.log`) |
| clé `MEM0_HTTP_TOKEN` de `stack/env`, `MEM0_HTTP_URL`, `MEM0_PROJECT_ID` | `MEMORY_HTTP_TOKEN`, `MEMORY_HTTP_URL`, `MEMORY_PROJECT_ID` |
| `OMP_CONSOLE_MEM0_PORT`, `OMP_CONSOLE_MEM0_RS_SHA256` | `OMP_CONSOLE_MEMORY_PORT`, `OMP_CONSOLE_MEMORY_RS_SHA256` |
| `MEM0_CONSOLE_HOOK_ALL_WORKTREES` (hook de `scripts/run-console.sh`) | `MEMORY_CONSOLE_HOOK_ALL_WORKTREES` |
| texte « Service mem0 » de l'app | « Service mémoire » |
| `~/.omp/mem0.json` (écrit par l'appairage) | `~/.omp/memory.json` |

Rien à faire : au démarrage, l'app décharge l'ancien agent, retire son plist, et
garde le dossier `mem0-rs/` s'il existe, avec sa base, sans jamais créer un
`memory-rs/` vide à côté. Pour renommer à la main, au retrait des replis : quitte
l'app, puis renomme le dossier `mem0-rs/` en `memory-rs/` et ses fichiers
`mem0-rs.db…` et `mem0-rs.log` en `memory-rs.db…` et `memory-rs.log`.

## Dépannage

- **Sur le VPS, commence par `harness.sh check`**, puis `harness.sh logs`.
- **`/req` dit « harness non configuré »** : omp n'est pas relié au serveur.
  Colle le code d'appairage dans l'app, ou lance `/pair`.
- **Un merge n'arrive pas sur GitHub** : le plus souvent, la clé de déploiement
  est en lecture seule.
- **`/memory-status` en rouge avec la pile conteneur** : lance
  `cd memory-stack && ./doctor.sh`, il dit quoi corriger.
- **L'agent ignore un souvenir** : le sommaire est exhaustif tant qu'il n'est pas
  tronqué (60 entrées) ; au-delà, l'agent doit chercher avec `memory_search`.
  Vérifie aussi le projet affiché par `/memory-status`.

## Contribuer

Les règles : [CONTRIBUTING.md](CONTRIBUTING.md). L'organisation du dépôt, les
tests, la CI et la release : [DEVELOPPEMENT.md](DEVELOPPEMENT.md). La publication :
[PUBLISHING.md](PUBLISHING.md).
