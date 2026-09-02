# AGENTS.md

<!-- mem0:brief v2 -->
## Mémoire du projet

Une mémoire persistante (mem0) est branchée sur ce projet : rappel automatique au
début de chaque session, écriture automatique toutes les quelques questions. Le tri
automatique rate ce qui est décidé en une phrase sans être répété — quand ça arrive,
appelle `mem0_add` toi-même, sur le moment.

**Mémorise** : stack et choix techniques, décisions d'architecture *avec leur
raison*, conventions du dépôt qui ne sont écrites nulle part, bugs résolus (symptôme
+ cause racine + correctif), exigences incontournables d'une feature, préférences de
travail exprimées par l'utilisateur.

**Ne mémorise pas** : l'état courant du code, ce qui est déjà écrit ici ou dans le
README, un raisonnement en cours, un résultat de test, du bavardage, un secret.

Un fait par appel, autoportant. Le dépôt fait toujours autorité contre un souvenir :
s'il le contredit, le souvenir est périmé — corrige-le (`mem0_add`) ou supprime-le
(`mem0_forget`), ne travaille pas dessus.

Quand la conversation part sur un sujet que le rappel de début de session ne
couvrait pas : `mem0_search` avant de te lancer.

Règles complètes et exemples : `.omp/mem0-brief.md` — lis-le avant ton premier
`mem0_add` dans ce projet.
<!-- /mem0:brief -->
