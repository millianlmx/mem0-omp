# Sécurité

## Signaler une vulnérabilité

Ne l'ouvre pas en issue publique. Passe par un **avis de sécurité privé** de
GitHub : onglet **Security** du dépôt → **Advisories** → **Report a
vulnerability**. Le signalement n'est visible que des mainteneurs ; décris la
version touchée (tag `<composant>-v<version>`), les étapes pour reproduire et
l'impact.

Le correctif est publié par une release ordinaire, et l'avis rendu public avec
elle.

## Périmètre

| Composant | Où |
|---|---|
| Serveur de pipelines (harness) : API HTTP, jetons, conteneurs de runners | `omp-harness/` |
| Serveur mémoire : API HTTP, jeton `X-Mem0-Token`, base SQLite | `mem0-stack/mem0-rs/`, `mem0-stack/` |
| Apps OMP Console macOS et iOS, et le jumelage avec le harness | `omp-console/` |
| Plugins OMP du catalogue | `omp-mem0-memory/`, `omp-mem0-req/` |

Hors périmètre : les dépendances tierces elles-mêmes (signale-les en amont), et
une instance déployée hors des procédures documentées du dépôt.
