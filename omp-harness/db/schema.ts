// Le schéma de la base du harness : une migration par version, jouée dans l'ordre
// (`PRAGMA user_version` = nombre de migrations appliquées). Une migration publiée ne
// change plus : un schéma qui évolue ajoute la suivante.

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE runs (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     slug TEXT NOT NULL,
     title TEXT NOT NULL,
     request TEXT NOT NULL,
     state TEXT NOT NULL,
     step TEXT,
     fixes INTEGER NOT NULL DEFAULT 0,
     attempts INTEGER NOT NULL DEFAULT 0,
     branch TEXT NOT NULL,
     worktree TEXT,
     base_sha TEXT,
     project_id TEXT,
     project_order INTEGER NOT NULL DEFAULT 0,
     modules TEXT NOT NULL DEFAULT '[]',
     verdict TEXT,
     merge_sha TEXT,
     pr_url TEXT,
     reason TEXT,
     model TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE (repo, slug)
   );
   CREATE INDEX runs_state ON runs (state);
   CREATE TABLE steps (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs (id),
     kind TEXT NOT NULL,
     attempt INTEGER NOT NULL,
     status TEXT NOT NULL,
     unit TEXT,
     model TEXT,
     summary TEXT,
     started_at INTEGER NOT NULL,
     ended_at INTEGER
   );
   CREATE INDEX steps_run ON steps (run_id);
   CREATE TABLE decisions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs (id),
     step_id INTEGER NOT NULL REFERENCES steps (id),
     seq INTEGER NOT NULL,
     question TEXT NOT NULL,
     options TEXT NOT NULL,
     chosen TEXT NOT NULL,
     rationale TEXT NOT NULL,
     category TEXT NOT NULL,
     status TEXT NOT NULL,
     checkpoint_sha TEXT,
     reversal_option TEXT,
     reversal_reason TEXT,
     created_at INTEGER NOT NULL,
     decided_at INTEGER,
     UNIQUE (run_id, seq)
   );
   CREATE TABLE escalations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs (id),
     step_id INTEGER NOT NULL REFERENCES steps (id),
     category TEXT NOT NULL,
     question TEXT NOT NULL,
     options TEXT NOT NULL,
     context TEXT NOT NULL,
     status TEXT NOT NULL,
     answer TEXT,
     created_at INTEGER NOT NULL,
     answered_at INTEGER
   );
   CREATE INDEX escalations_open ON escalations (status);
   CREATE TABLE artifacts (
     run_id TEXT NOT NULL REFERENCES runs (id),
     name TEXT NOT NULL,
     content TEXT NOT NULL,
     step_id INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (run_id, name)
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     run_id TEXT,
     type TEXT NOT NULL,
     payload TEXT NOT NULL
   );
   CREATE INDEX events_run ON events (run_id, id);
   CREATE TABLE cache (
     key TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     tree TEXT NOT NULL,
     command TEXT NOT NULL,
     outcome TEXT NOT NULL,
     exit_code INTEGER NOT NULL,
     output TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE test_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs (id),
     step_id INTEGER,
     scope TEXT NOT NULL,
     key TEXT NOT NULL,
     tree TEXT NOT NULL,
     outcome TEXT NOT NULL,
     cached INTEGER NOT NULL,
     attempts INTEGER NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX test_runs_run ON test_runs (run_id, id);
   CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  `CREATE TABLE audits (
     id TEXT PRIMARY KEY,
     repo TEXT NOT NULL,
     focus TEXT NOT NULL,
     state TEXT NOT NULL,
     proposals TEXT NOT NULL DEFAULT '[]',
     project_id TEXT,
     reason TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  `ALTER TABLE decisions ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';`,
  // Plusieurs clients, plusieurs projets : priorité et révision des runs, auteur des
  // gestes, journal filtrable par dépôt. La consigne de reprise quitte les artefacts
  // (l'ancien `_resume.md`) pour sa propre colonne.
  `ALTER TABLE runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN created_by TEXT;
   ALTER TABLE runs ADD COLUMN instructions TEXT;
   UPDATE runs SET instructions = (SELECT content FROM artifacts WHERE artifacts.run_id = runs.id AND artifacts.name = '_resume.md');
   DELETE FROM artifacts WHERE name = '_resume.md';
   ALTER TABLE decisions ADD COLUMN decided_by TEXT;
   ALTER TABLE escalations ADD COLUMN answered_by TEXT;
   ALTER TABLE events ADD COLUMN repo TEXT;
   UPDATE events SET repo = (SELECT repo FROM runs WHERE runs.id = events.run_id) WHERE run_id IS NOT NULL;
   UPDATE events SET repo = json_extract(payload, '$.repo') WHERE repo IS NULL AND json_valid(payload);
   CREATE INDEX events_repo ON events (repo, id);
   CREATE INDEX events_at ON events (at);
   CREATE INDEX runs_repo_state ON runs (repo, state);`,
  // Les fournisseurs LLM déclarés par l'API (les apps) et les réglages qui surchargent la
  // configuration (chaînes de modèles). Les CLÉS n'y entrent jamais : providers.env (0600).
  `CREATE TABLE providers (
     name TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     base_url TEXT,
     api TEXT,
     models TEXT NOT NULL DEFAULT '[]',
     capacity INTEGER,
     refill_per_minute INTEGER,
     key_hint TEXT,
     updated_at INTEGER NOT NULL,
     updated_by TEXT
   );
   CREATE TABLE settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT
   );`,
  // L'autonomie : le backoff des relances, les merges relancés, la cause du dernier
  // échec, le HEAD de la dernière revue ; la recommandation de l'agent et la raison de
  // l'humain sur une escalade.
  `ALTER TABLE runs ADD COLUMN not_before INTEGER;
   ALTER TABLE runs ADD COLUMN merge_retries INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE runs ADD COLUMN last_fail_cause TEXT;
   ALTER TABLE runs ADD COLUMN last_review_sha TEXT;
   ALTER TABLE escalations ADD COLUMN recommended TEXT;
   ALTER TABLE escalations ADD COLUMN answer_reason TEXT;`,
  // Le monitoring : le direct des sessions (rejouable), la consommation de chaque message
  // d'agent (coût, jetons, modèle), et les jetons push des apps (Live Activities iOS).
  `CREATE TABLE session_entries (
     owner TEXT NOT NULL,
     seq INTEGER NOT NULL,
     at INTEGER NOT NULL,
     step TEXT,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     tool TEXT,
     status TEXT,
     detail TEXT,
     PRIMARY KEY (owner, seq)
   ) WITHOUT ROWID;
   CREATE INDEX session_entries_at ON session_entries (at);
   CREATE TABLE usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT,
     audit_id TEXT,
     repo TEXT,
     step TEXT,
     provider TEXT,
     model TEXT,
     input INTEGER NOT NULL DEFAULT 0,
     output INTEGER NOT NULL DEFAULT 0,
     cache_read INTEGER NOT NULL DEFAULT 0,
     cache_write INTEGER NOT NULL DEFAULT 0,
     cost REAL NOT NULL DEFAULT 0,
     at INTEGER NOT NULL
   );
   CREATE INDEX usage_run ON usage (run_id);
   CREATE INDEX usage_at ON usage (at);
   CREATE TABLE push_tokens (
     token TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     run_id TEXT,
     client TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // Les questions se lisent hors de la session : la situation donnée par l'agent et
  // l'impact de chaque option, sur les décisions comme sur les escalades. Le
  // `context` d'une escalade était sa raison : il devient la situation, la raison
  // a sa colonne (`NULL` sur une escalade antérieure, dont le contexte EST la raison).
  `ALTER TABLE decisions ADD COLUMN context TEXT;
   ALTER TABLE decisions ADD COLUMN impacts TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE escalations ADD COLUMN rationale TEXT;
   ALTER TABLE escalations ADD COLUMN impacts TEXT NOT NULL DEFAULT '[]';`,
];
