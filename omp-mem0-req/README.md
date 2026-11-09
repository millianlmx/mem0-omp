# omp-mem0-req

Le plugin des pipelines. Il ne conduit rien en local : c'est un client du serveur
`omp-harness`. Les commandes (`/req`, `/project`, `/audit`, `/pipelines`,
`/harness-follow`, `/demande`) et l'installation sont décrites dans le
[README du dépôt](../README.md) ; l'API du serveur dans
[omp-harness/README.md](../omp-harness/README.md).

## Configuration

`HARNESS_URL` et `HARNESS_TOKEN`, sinon `~/.omp/harness.json`
(`{"url", "token", "repos": {"<racine git>": "<nom du dépôt sur le serveur>"}}`),
écrit par l'appairage. `HARNESS_REPO` force le nom du dépôt.

## La session se signale au serveur

Une session omp ouverte dans un terminal envoie des battements au harness
(`POST /v1/local-sessions`). Les apps la montrent à côté des runs du serveur, avec ce
qu'elle fait, et peuvent confier son travail à un run. Le code est dans
`local-session.ts`, branché par `extension.ts`.

Ce qui part dans un battement : l'id de la session, le nom de la machine, le dossier,
le titre (le nom de la session, sinon le premier message de l'utilisateur coupé à 200
caractères), l'état, le modèle, le coût cumulé, l'outil en cours et son intention
(300 caractères au plus), la branche et l'adresse du distant `origin` lues par git. Les
identifiants d'une adresse `https://jeton@hôte/…` sont retirés avant l'envoi. Le contenu
des messages, des fichiers et des résultats d'outils ne part jamais.

| Événement de l'hôte | Battement |
|---|---|
| `session_start`, `session_switch` | `idle` ; au changement de session, l'ancienne est d'abord dite `ended` |
| `agent_start` | `working` |
| `tool_execution_start` | `working`, avec l'outil et son intention : le premier part tout de suite, puis au plus un par 10 s ; celui qui arrive trop tôt est différé et porte le dernier outil |
| `agent_end` | `idle`, sauf si l'hôte a déjà programmé une relance (`willContinue`) |
| `session_shutdown` | `ended`, attendu au plus 1,5 s |

Un changement d'état part toujours sans attendre. Une session qui dure sans rien dire
renvoie un battement d'entretien, après 60 s en `working` et 10 min en `idle` : le
serveur rend `idle` une session `working` muette depuis 2 min, et `ended` une session
muette depuis 30 min.

Le rapporteur se tait dans quatre cas :

- un sous-agent (`ctx.agent.kind === "sub"`) : seule la session principale rapporte ;
- un runner du harness (`MEM0_MODE=runner`) : le serveur le suit déjà ;
- le harness n'est pas configuré : aucun appel réseau, git n'est pas lu ;
- `OMP_HARNESS_LOCAL_SESSIONS=0`.

Il ne lève jamais dans l'hôte. Un serveur injoignable ou en erreur est ignoré, et le
battement suivant est tenté. Un serveur qui répond 401, 403 ou 404 (jeton refusé, ou
version sans la capacité `local-sessions`) fait taire le rapporteur jusqu'à la fin de la
session.
