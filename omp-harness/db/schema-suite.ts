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
  // Une feature découpée attend le merge de son parent (split.ts) : sans lui, elle partait
  // avant que le code dont elle dépend soit sur main.
  `ALTER TABLE runs ADD COLUMN after_run TEXT;
   CREATE INDEX runs_after_run ON runs (after_run);`,
  // La vigie (vigie/) : un incident par empreinte, de son premier signal à la fermeture de
  // son issue — tri, issue publiée, run de correction (un seul), surveillance après le merge.
  `CREATE TABLE vigie_incidents (
     fingerprint TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     location TEXT NOT NULL,
     message TEXT NOT NULL,
     repo TEXT,
     run_id TEXT,
     status TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 1,
     first_at INTEGER NOT NULL,
     last_at INTEGER NOT NULL,
     context TEXT,
     triage TEXT,
     triage_cost REAL NOT NULL DEFAULT 0,
     triaged_at INTEGER,
     draft TEXT,
     issue_number INTEGER,
     issue_url TEXT,
     published_at INTEGER,
     commented_count INTEGER NOT NULL DEFAULT 1,
     commented_at INTEGER,
     fix_run_id TEXT,
     fixed_at INTEGER,
     merged_at INTEGER,
     closed_at INTEGER,
     note TEXT,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX vigie_incidents_status ON vigie_incidents (status, last_at);
   CREATE INDEX vigie_incidents_fix_run ON vigie_incidents (fix_run_id);
   CREATE INDEX vigie_incidents_issue ON vigie_incidents (repo, issue_number);`,
  // Les appareils qui reçoivent les alertes push (APNs) : leur jeton, le client qui l'a
  // enregistré (ses droits décident de ce qu'ils reçoivent) et leur passerelle.
  `CREATE TABLE push_devices (
     token TEXT PRIMARY KEY,
     client TEXT NOT NULL,
     platform TEXT NOT NULL,
     environment TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // Le pont corpo ↔ usine : un signalement d'un collègue (une ligne par fil), sa proposition
  // « ouvrir une issue et lancer un correctif », l'issue créée et le texte caviardé dont le
  // run est construit ; `corporate_signal_runs` garde l'origine de chaque run lancé depuis
  // cette issue (relances comprises). Rien de cela n'est écrit sur la forge ni dans le dépôt.
  `CREATE TABLE corporate_signals (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     channel TEXT NOT NULL,
     thread_ref TEXT NOT NULL,
     url TEXT NOT NULL,
     person_ref TEXT,
     excerpt TEXT NOT NULL,
     state TEXT NOT NULL,
     reason TEXT,
     error TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     repo TEXT,
     kind TEXT,
     title TEXT,
     body TEXT,
     issue_repo TEXT,
     issue_number INTEGER,
     issue_url TEXT,
     run_title TEXT,
     run_request TEXT,
     policy TEXT,
     run_id TEXT,
     confirmed_by TEXT,
     confirmed_at INTEGER,
     UNIQUE (channel, thread_ref)
   );
   CREATE INDEX corporate_signals_state ON corporate_signals (state, created_at);
   CREATE INDEX corporate_signals_issue ON corporate_signals (issue_repo, issue_number);
   CREATE INDEX corporate_signals_person ON corporate_signals (person_ref, confirmed_at);
   CREATE TABLE corporate_signal_runs (
     run_id TEXT PRIMARY KEY,
     signal_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX corporate_signal_runs_signal ON corporate_signal_runs (signal_id);`,
  // L'autonomie par paliers : le type de travail et les labels d'un run (déclarés à sa création),
  // et, pour une validation prise seule, la porte, la règle et les preuves (décisions).
  `ALTER TABLE runs ADD COLUMN kind TEXT;
   ALTER TABLE runs ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE decisions ADD COLUMN autonomy TEXT;`,
  // Les Demandes (intake.ts) : une phrase libre classée par un job, confirmée en un objet.
  `CREATE TABLE intakes (
     id TEXT PRIMARY KEY,
     text TEXT NOT NULL,
     source TEXT NOT NULL,
     repo TEXT NOT NULL DEFAULT '',
     requested_repo TEXT,
     scope TEXT NOT NULL,
     state TEXT NOT NULL,
     kind TEXT,
     plan TEXT,
     question TEXT,
     answer TEXT,
     exchanges TEXT NOT NULL DEFAULT '[]',
     target_kind TEXT,
     target_id TEXT,
     reason TEXT,
     created_by TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX intakes_state ON intakes (state, created_at);`,
  // Les contenus lus des canaux corpo (canaux/lecture.ts, db/channel-contents.ts) : messages
  // Gmail et Slack (un par identifiant de source, `seq` croissant à chaque nouveau), événements
  // de l'Agenda (un par événement, mis à jour sur place), curseurs de lecture, conversations
  // Slack (suivies ou non) et auteurs Slack. Purgés après `workstation.retentionDays`.
  `CREATE TABLE channel_messages (
     seq INTEGER PRIMARY KEY,
     id TEXT NOT NULL UNIQUE,
     channel TEXT NOT NULL,
     source_id TEXT NOT NULL,
     thread_id TEXT,
     conversation TEXT,
     conversation_kind TEXT,
     origin TEXT NOT NULL,
     author TEXT,
     at INTEGER NOT NULL,
     subject TEXT,
     text TEXT NOT NULL DEFAULT '',
     headers TEXT NOT NULL DEFAULT '{}',
     labels TEXT NOT NULL DEFAULT '[]',
     mentions_me INTEGER NOT NULL DEFAULT 0,
     bot INTEGER NOT NULL DEFAULT 0,
     read_at INTEGER NOT NULL
   );
   CREATE INDEX channel_messages_at ON channel_messages (at);
   CREATE INDEX channel_messages_thread ON channel_messages (channel, thread_id);
   CREATE TABLE channel_events (
     id TEXT PRIMARY KEY,
     summary TEXT,
     start_at INTEGER NOT NULL,
     end_at INTEGER NOT NULL,
     all_day INTEGER NOT NULL DEFAULT 0,
     organizer TEXT,
     attendees TEXT NOT NULL DEFAULT '[]',
     meet_url TEXT,
     recurring_event_id TEXT,
     updated_at INTEGER NOT NULL,
     read_at INTEGER NOT NULL
   );
   CREATE INDEX channel_events_start ON channel_events (start_at);
   CREATE TABLE channel_cursors (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE slack_conversations (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL,
     archived INTEGER NOT NULL DEFAULT 0,
     followed INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE slack_users (
     id TEXT PRIMARY KEY,
     name TEXT,
     real_name TEXT,
     email TEXT,
     bot INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );`,
  // Le graphe des personnes du poste (db/people.ts, canaux/personnes.ts) : une personne par
  // ligne, ses champs, ceux que l'humain a corrigés (figés contre l'alimentation automatique)
  // et sa révision ; `workstation_person_keys` rattache chaque adresse (`email:…`) et chaque
  // identifiant Slack (`slack:…`) à UNE personne.
  `CREATE TABLE workstation_people (
     id TEXT PRIMARY KEY,
     name TEXT,
     emails TEXT NOT NULL DEFAULT '[]',
     slack_ids TEXT NOT NULL DEFAULT '[]',
     role TEXT,
     team TEXT,
     projects TEXT NOT NULL DEFAULT '[]',
     tone TEXT,
     delegation TEXT NOT NULL DEFAULT 'jamais',
     topics TEXT NOT NULL DEFAULT '[]',
     corrected TEXT NOT NULL DEFAULT '[]',
     rev INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE workstation_person_keys (
     key TEXT PRIMARY KEY,
     person_id TEXT NOT NULL REFERENCES workstation_people (id) ON DELETE CASCADE
   );
   CREATE INDEX workstation_person_keys_person ON workstation_person_keys (person_id);`,
];
