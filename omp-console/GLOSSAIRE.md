# Glossaire des textes d’OMP Console

Ce glossaire régit les textes des fichiers `*Text.swift` de `omp-console/Sources/ConsoleCore`, `omp-console/Sources/OMPConsole` et `omp-console/ios/OMPConsoleIOS`. La règle : on francise, sauf les termes conservés. Une même notion porte le même terme sur Mac et sur iOS. La garde `test/typographie-et-glossaire-francais.test.ts` lit les deux tableaux ci-dessous : ils sont la seule source des termes conservés et des anglicismes bannis.

## Termes conservés

Ces termes s’écrivent tels quels, avec cette casse.

| Terme | Nature | Emploi |
|---|---|---|
| `pipeline` | terme métier OMP | « Aucune pipeline pour l’instant. » |
| `feature` | terme métier OMP | « Nouvelle feature » |
| `PR` | terme métier OMP | « Ouvrir la PR » |
| `/req` | terme métier OMP | « Modèle /req+/specs » |
| `/specs` | terme métier OMP | « Modèle /req+/specs » |
| `specs` | terme métier OMP | « Valider les specs » |
| `/impl` | terme métier OMP | « Modèle /impl+/review » |
| `/review` | terme métier OMP | « Modèle /impl+/review » |
| `Given` | syntaxe des critères OMP | « Given un contrat long » |
| `When` | syntaxe des critères OMP | « When la feuille s’ouvre » |
| `Then` | syntaxe des critères OMP | « Then le nom se lit en entier dans la feuille. » |
| `app` | usage du français d’Apple | « L’app n’est pas connectée au Mac. » |
| `Web` | usage du français d’Apple | « Recherche Web » |
| `OMP` | nom propre ou norme | « Lancer OMP » |
| `OMP Console` | nom propre ou norme | « Bienvenue dans OMP Console » |
| `mem0` | nom propre ou norme | « Mets à jour mem0-http sur le Mac (redéploie le service), puis réessaie. » |
| `omp-mem0-req` | nom propre ou norme | « vérifiez que le module omp-mem0-req est installé » |
| `oMLX` | nom propre ou norme | « Démarrez oMLX, puis rafraîchissez. » |
| `OMLX_API_TOKEN` | nom propre ou norme | « vérifiez OMLX_API_TOKEN. » |
| `Podman` | nom propre ou norme | « Installation de Podman… » |
| `Git` | nom propre ou norme | « Ce dossier n’est pas un dépôt Git. » |
| `GitHub` | nom propre ou norme | « Relire l’état des PR sur GitHub (⌘R) » |
| `Apple` | nom propre ou norme | « Les outils de développement d’Apple sont introuvables » |
| `Mac` | nom propre ou norme | « Oublier ce Mac » |
| `macOS` | nom propre ou norme | « avec les mêmes bornes que sur macOS » |
| `iPhone` | nom propre ou norme | « Rangées de l’Accueil écrasées sur iPhone » |
| `iPad` | nom propre ou norme | « sur iPhone comme sur iPad » |
| `iOS` | nom propre ou norme | « La feuille Contrat de l’app iOS » |
| `VoiceOver` | nom propre ou norme | « Il est annoncé comme un en-tête par VoiceOver » |
| `Swift` | nom propre ou norme | « Les tests Swift lisent… » |
| `Node` | nom propre ou norme | « La garde Node plante une faute dans une copie jetable du dépôt. » |
| `Markdown` | nom propre ou norme | « Chaque section arrive du Mac sous forme de texte Markdown » |
| `Claude Opus` | nom propre ou norme | « Claude Opus 5.5 » |
| `CSV` | nom propre ou norme | « Exporter les souvenirs du projet au format CSV. » |
| `UTF-8` | nom propre ou norme | « pas du texte UTF-8 » |
| `SHA-256` | nom propre ou norme | « empreinte SHA-256 différente » |
| `arm64` | nom propre ou norme | « arm64 requis » |

## Anglicismes bannis

Chaque forme refusée est interdite dans les textes ; le terme retenu la remplace partout.

| Anglicisme | Formes refusées | Terme retenu | Exemple |
|---|---|---|---|
| pull request | `pull request`, `pull requests` | PR | « Recevez la PR » |
| review | `review`, `reviews` | revue | « Accepter la revue » |
| impl | `impl` | implémentation | « Lancement de l’implémentation » |
| run | `run`, `runs` | exécution | « Cette exécution n’accepte pas de message » |
| worktree | `worktree`, `worktrees` | dossier de feature | « Aucun dossier de feature dans ce projet. » |
| token | `token`, `tokens` | jeton | « Jeton révoqué » |
| CI | `CI` | intégration continue | « PR et intégration continue » |
| plugin | `plugin`, `plugins` | module | « vérifiez que le module omp-mem0-req est installé » |
| commit | `commit`, `commits` | version validée | « Comparé à la dernière version validée » |
| diff | `diff`, `diffs` | différences | « en-tête de différences » |
| shell | `shell`, `shells` | interpréteur | « L’interpréteur est actif. » |
| API | `API`, `APIs` | protocole | « Version de protocole incompatible » |
| process | `process` | processus | « aucun processus lancé » |
| PTY | `PTY` | pseudo-terminal | « Pseudo-terminal indisponible » |
| pid | `pid` | numéro de processus | « numéro de processus : 4242 » |
| embeddings | `embedding`, `embeddings` | vecteurs sémantiques | « la mémoire a besoin de ses vecteurs sémantiques » |
| fixture | `fixture`, `fixtures` | jeu d’essai | « le jeu d’essai de la recette » |
| script | `script`, `scripts` | programme | « un programme de relevé » |

## Typographie

Cinq règles, appliquées à chaque texte visible :

| Règle | Correct | Refusé |
|---|---|---|
| R-1 — apostrophe typographique ’ (U+2019), jamais l’apostrophe droite | « Lecture de l’appairage » | `Lecture de l'appairage` |
| R-2 — espace insécable avant `;`, `:`, `!` et `?` : une espace ordinaire est remplacée, une espace absente est insérée | « Pourquoi ? » | `Pourquoi ?` (espace ordinaire), `Pourquoi?` (aucune espace) |
| R-3 — guillemets français `«` `»`, jamais de guillemets droits | « « mot » » | `"mot"` |
| R-4 — points de suspension en un seul caractère … (U+2026), jamais trois points | « Attendez… » | `Attendez...` |
| R-5 — espace insécable juste après `«` et juste avant `»` | « « mot » et la suite… » | `« mot »` (espaces ordinaires), `«mot»` (collé) |

Convention d’écriture : l’espace insécable est U+00A0, écrite dans les sources comme le caractère lui-même, jamais comme l’échappement `\u{00A0}`. La garde accepte aussi l’espace fine insécable U+202F. L’apostrophe ’, les guillemets `«` `»` et les points de suspension … s’écrivent eux aussi bruts.

## Règles de la garde

- Un mot est entier quand il n’est ni précédé ni suivi d’une lettre ou d’un chiffre (`\p{L}`, `\p{N}`) : `-`, `.`, `_`, `/` et les espaces sont des frontières.
- Une forme écrite entièrement en majuscules (au moins deux lettres A–Z, éventuellement suivies d’un `s` minuscule : `CI`, `API`, `APIs`, `PTY`) se compare en respectant la casse ; toute autre forme se compare sans tenir compte de la casse.
- Les termes conservés sont neutralisés, en mot entier et en respectant la casse, avant la recherche des formes refusées : `/review` passe, `review` seul est refusé.
- Les chaînes techniques (commandes, URL, heures, noms de fichiers, identifiants) n’échappent à la garde que par la liste `EXCEPTIONS` de la garde, chaque entrée nommée par son fichier et son littéral exact, ou par son fichier et sa constante.
