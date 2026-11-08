// La suite des migrations de schema.ts (découpée pour rester sous 400 lignes), jouée après
// elles : `MIGRATIONS` = les premières puis celles-ci, dans l'ordre. Une migration publiée
// ne change plus : un schéma qui évolue ajoute la suivante EN FIN de cette liste.

export const MIGRATIONS_SUITE: readonly string[] = [
  // Les captures d'écran du poste, gardées par action (workstation-captures.ts) : le JPEG
  // tel que capturé, en base64, effacé après `workstation.captureRetentionHours`.
  `CREATE TABLE workstation_captures (
     seq INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     mime_type TEXT NOT NULL,
     image TEXT NOT NULL
   );
   CREATE INDEX workstation_captures_at ON workstation_captures (at);`,
  // Les demandes au poste et les automatisations (consignes enregistrées) ; le lien action → demande.
  // Les navigateurs du poste (un profil Chrome = une extension appairée = un `browserId`) : la
  // cible d'une action ou d'une demande, et le navigateur d'où viennent observations et meetings.
  `CREATE TABLE workstation_requests (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     by TEXT,
     instruction TEXT NOT NULL,
     automation_id TEXT,
     browser_id TEXT,
     state TEXT NOT NULL,
     reason TEXT,
     report TEXT,
     started_at INTEGER,
     ended_at INTEGER
   );
   CREATE INDEX workstation_requests_state ON workstation_requests (state, created_at);
   CREATE TABLE workstation_automations (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     by TEXT,
     title TEXT NOT NULL,
     frequency TEXT NOT NULL DEFAULT '',
     steps TEXT NOT NULL DEFAULT '[]',
     profile_version INTEGER,
     browser_id TEXT,
     schedule TEXT
   );
   ALTER TABLE workstation_actions ADD COLUMN request_id TEXT;
   ALTER TABLE workstation_actions ADD COLUMN browser_id TEXT;
   CREATE INDEX workstation_actions_request ON workstation_actions (request_id, seq);
   ALTER TABLE workstation_observations ADD COLUMN browser_id TEXT;
   ALTER TABLE workstation_meetings ADD COLUMN browser_id TEXT;
   CREATE TABLE workstation_browsers (
     id TEXT PRIMARY KEY,
     label TEXT,
     version TEXT,
     first_seen_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL
   );`,
  // Les planifications récurrentes (schedules.ts) : `repo` répète celui de la cible pour le
  // filtrage par client ; `last_fired` garde le dernier lancement, qui doit finir avant le suivant.
  `CREATE TABLE schedules (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     cron TEXT NOT NULL,
     target TEXT NOT NULL,
     repo TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     next_run_at INTEGER,
     last_run_at INTEGER,
     last_outcome TEXT,
     last_fired TEXT,
     created_by TEXT,
     rev INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX schedules_due ON schedules (enabled, next_run_at);`,
  // L'observabilité (observability.ts) : les erreurs remontées par les clients (apps,
  // extension, omp) et les points de santé de `GET /v1/metrics`, qui survivent au redémarrage.
  `CREATE TABLE client_errors (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     client TEXT NOT NULL,
     source TEXT NOT NULL,
     version TEXT NOT NULL,
     kind TEXT NOT NULL,
     message TEXT NOT NULL,
     context TEXT
   );
   CREATE INDEX client_errors_at ON client_errors (at);
   CREATE TABLE metric_samples (
     at INTEGER PRIMARY KEY,
     sample TEXT NOT NULL
   );`,
];
