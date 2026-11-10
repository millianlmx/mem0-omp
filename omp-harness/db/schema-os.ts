// La suite des migrations de schema-suite.ts (découpée pour rester sous 400 lignes), jouée après
// elles : `MIGRATIONS` = schema.ts, puis schema-suite.ts, puis celles-ci, dans l'ordre. Une migration
// publiée ne change plus : un schéma qui évolue ajoute la suivante EN FIN de cette liste.

export const MIGRATIONS_OS: readonly string[] = [
  // L'OS agentique : le curseur d'autonomie d'un run (`ask` | `deliver`, NULL : les règles du dépôt) et le
  // motif de son annulation ; le contexte de page d'une Demande (JSON) ; les consignes permanentes de
  // l'humain ; les espaces (clients) ; les propositions écartées ; les sessions omp locales (`removed_at` :
  // retirée de la liste, la ligne reste le temps de sa purge pour garder son run lié) ; les jetons
  // push-to-start des Live Activities ; l'index du journal par type (scoreboard, brief, propositions :
  // `eventsOfType` balayait la table entière).
  `ALTER TABLE runs ADD COLUMN autonomy TEXT;
   ALTER TABLE runs ADD COLUMN cancel_cause TEXT;
   ALTER TABLE intakes ADD COLUMN context TEXT;
   CREATE TABLE standing_rules (
     id TEXT PRIMARY KEY,
     repo TEXT,
     text TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     source_kind TEXT NOT NULL,
     source_run_id TEXT,
     created_by TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX standing_rules_repo ON standing_rules (repo, enabled);
   CREATE TABLE spaces (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     repos TEXT NOT NULL,
     poste INTEGER NOT NULL DEFAULT 0,
     jira_projects TEXT NOT NULL,
     daily_budget_usd REAL,
     autonomy TEXT,
     created_by TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     rev INTEGER NOT NULL DEFAULT 1
   );
   CREATE TABLE proposal_dismissals (
     id TEXT PRIMARY KEY,
     dismissed_by TEXT,
     dismissed_at INTEGER NOT NULL
   );
   CREATE TABLE local_sessions (
     id TEXT PRIMARY KEY,
     client TEXT NOT NULL,
     host TEXT NOT NULL,
     cwd TEXT NOT NULL,
     repo TEXT,
     remote TEXT,
     branch TEXT,
     title TEXT NOT NULL,
     intent TEXT,
     tool TEXT,
     state TEXT NOT NULL,
     model TEXT,
     cost REAL,
     run_id TEXT,
     started_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     ended_at INTEGER,
     removed_at INTEGER
   );
   CREATE INDEX local_sessions_updated ON local_sessions (updated_at);
   CREATE TABLE push_start_tokens (
     token TEXT PRIMARY KEY,
     client TEXT NOT NULL,
     environment TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX events_type ON events (type, id);`,
  // Les clés d'idempotence (`Idempotency-Key`) : la réponse 2xx d'une création, rejouée telle quelle à la
  // même clé du même client pendant 24 h (idempotency.ts). `fingerprint` : la requête qui l'a produite.
  `CREATE TABLE idempotency_keys (
     client TEXT NOT NULL,
     key TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     status INTEGER NOT NULL,
     headers TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (client, key)
   );
   CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);`,
  // Le multi-client : l'espace devient la frontière d'un client. Une consigne permanente d'espace ; l'espace
  // d'une Demande, d'une demande du poste, d'une écriture et d'un plan Atlassian, d'une consommation sans
  // dépôt (poste, Demande, rêve) ; le navigateur du poste rattaché à un espace et le profil du poste par
  // espace ; la politique de modèles et les identités d'un espace (JSON) ; l'espace d'où vient un signalement
  // corpo (celui du job du poste qui l'a remis) ; l'espace d'une observation, d'un meeting et d'une action du
  // poste AU MOMENT où la ligne est écrite (elle n'en change plus : un navigateur réattribué n'emporte pas
  // son histoire), et celui où une automatisation a été créée.
  `ALTER TABLE standing_rules ADD COLUMN space_id TEXT;
   ALTER TABLE intakes ADD COLUMN space_id TEXT;
   ALTER TABLE usage ADD COLUMN space_id TEXT;
   CREATE INDEX usage_space ON usage (space_id, at);
   ALTER TABLE workstation_browsers ADD COLUMN space_id TEXT;
   ALTER TABLE workstation_requests ADD COLUMN space_id TEXT;
   CREATE TABLE workstation_space_profiles (
     space_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     profile TEXT NOT NULL,
     PRIMARY KEY (space_id, version)
   );
   ALTER TABLE atlassian_writes ADD COLUMN space_id TEXT;
   ALTER TABLE atlassian_plans ADD COLUMN space_id TEXT;
   ALTER TABLE spaces ADD COLUMN policy TEXT;
   ALTER TABLE spaces ADD COLUMN identities TEXT;
   ALTER TABLE corporate_signals ADD COLUMN space_id TEXT;
   ALTER TABLE workstation_observations ADD COLUMN space_id TEXT;
   ALTER TABLE workstation_meetings ADD COLUMN space_id TEXT;
   ALTER TABLE workstation_actions ADD COLUMN space_id TEXT;
   ALTER TABLE workstation_automations ADD COLUMN space_id TEXT;`,
];
