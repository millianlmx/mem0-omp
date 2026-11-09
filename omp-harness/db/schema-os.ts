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
];
