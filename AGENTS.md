# AGENTS.md

Conventions de contribution : [CONTRIBUTING.md](CONTRIBUTING.md).

## Dans un runner du harness

Le conteneur d'un runner (étapes /impl, /impl --fix, /review) n'a que 1 Go de
mémoire, sans swap. Au-delà, le noyau le tue (code 137) et l'étape est perdue.

- Lance les tests UNIQUEMENT par l'outil hôte `run_tests` : il tourne dans le
  conteneur heavy, qui a la mémoire et les outils.
- N'installe ni ne lance `node`, `bun`, `swift`, `cargo`, le type-check ou
  `scripts/check.sh` dans ton shell, même pour un seul fichier.
- Pas plus d'UN sous-agent à la fois.
- Les échecs de la suite complète liés au conteneur Linux (pas de macOS ni de
  Swift, outils absents) sont connus : ne les corrige pas, nomme-les.

<!-- memory:brief v7 -->
<!-- mem0:brief v6 --><!-- /mem0:brief -->
## Mémoire du projet

Une mémoire persistante (memory) est branchée sur ce projet. Un rappel automatique
est injecté à chaque tour, mais il est calé sur la formulation de la demande : dès
que la conversation se déplace vers un sujet que ce rappel ne couvre pas, appelle
`memory_search` **avant** de lire le code ou de proposer une solution. C'est moins
cher qu'une exploration de dépôt, et c'est la seule façon de retrouver un bug déjà
corrigé ou une décision déjà tranchée.

Appelle `memory_search` en particulier avant de : débugger quelque chose qui
ressemble à du déjà-vu, trancher une question d'architecture, choisir une
convention de nommage ou de découpage, ou répondre à une question sur "comment on
fait ici".

**Mémorise** (`memory_add`) : stack et choix techniques, décisions d'architecture
*avec leur raison*, conventions du dépôt qui ne sont écrites nulle part, bugs
résolus (symptôme + cause racine + correctif), exigences incontournables d'une
feature, préférences de travail exprimées par l'utilisateur.

**Ne mémorise pas** : l'état courant du code, ce qui est déjà écrit ici ou dans le
README, un raisonnement en cours, un résultat de test, du bavardage, un secret.

Un fait par appel, autoportant, rédigé tel quel — `memory_add` stocke ton texte
sans le reformuler. Avant d'écrire, il cherche un souvenir proche : s'il en trouve
un, il le **complète** au lieu de créer un doublon, et te renvoie la version
fusionnée. Relis-la : si la fusion est mauvaise, réécris l'entrée avec
`memory_update`.

Le dépôt fait toujours autorité contre un souvenir : s'il le contredit, le souvenir
est périmé — corrige-le (`memory_update`) ou supprime-le (`memory_forget`), ne
travaille pas dessus.

**Relie** (`memory_link`) un souvenir à celui qu'il touche : la `cause` d'un bug,
le souvenir qu'un autre `remplace`, `contredit` ou `precise`. Le rappel et la
recherche ramènent alors l'un avec l'autre (lignes `↳`).

- **Checkpoint automatique** — au-delà de 15 explorations (read, grep, glob, lsp)
  sans écriture avec `memory_add`, un message "memory checkpoint" t'est envoyé.
  C'est un appel à écrire : tu as collecté des informations durables, enregistre-les
  maintenant. Le compteur repart à zéro après chaque `memory_add`. En fin de session,
  une relance unique te demande aussi de mémoriser ce qui a été produit — fichiers
  modifiés, ou discussion de besoins/specs/archi sans édition.

Règles complètes et exemples : `.omp/memory-brief.md` — lis-le avant ton premier
`memory_add` dans ce projet.
<!-- /memory:brief -->
