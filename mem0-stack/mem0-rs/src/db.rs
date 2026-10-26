//! Stockage SQLite unique (S-1, modèle de données de BR-1) : souvenirs, vecteurs
//! denses (sqlite-vec), termes BM25 (FTS5) et historique dans un seul fichier.
//!
//! Chaque écriture tient dans UNE transaction `IMMEDIATE` ; l'embedding est
//! calculé par l'appelant avant, hors verrou.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Once;

use rusqlite::types::Type;
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, TransactionBehavior, params};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::bm25::{self, VecteurCreux};
use crate::horodatage::{self, Instant};
use crate::liens;

pub const SCHEMA_VERSION: &str = "4";
/// Version dont une base est migrée à l'ouverture (tables du schéma v4 ajoutées,
/// souvenirs indexés), sans rien perdre ni réécrire de ce qu'elle contient.
pub const VERSION_MIGRABLE: &str = "3";

/// Nombre de messages gardés par scope de session dans `messages` (storage.py).
pub const MESSAGES_PAR_PORTEE: usize = 10;

/// Échec d'ouverture de la base (code 1 au démarrage).
#[derive(Debug)]
pub enum ErreurOuverture {
    /// La base a été créée avec une autre dimension.
    Dims { stockee: String, demandee: usize },
    /// Base illisible ou étrangère : la raison.
    Autre(String),
}

impl ErreurOuverture {
    /// Message d'erreur fatal pour la base `chemin` (`MEM0_DB_PATH`).
    pub fn message(&self, chemin: &str) -> String {
        match self {
            ErreurOuverture::Dims { stockee, demandee } => format!(
                "MEM0_DB_PATH={chemin} a été créée avec EMBEDDING_DIMS={stockee}, la configuration demande {demandee}"
            ),
            ErreurOuverture::Autre(raison) => format!("MEM0_DB_PATH={chemin} : {raison}"),
        }
    }
}

static SQLITE_VEC: Once = Once::new();

/// Enregistre sqlite-vec comme extension automatique, avant toute connexion (D-7).
fn enregistrer_sqlite_vec() {
    SQLITE_VEC.call_once(|| {
        // SAFETY: `sqlite3_vec_init` a la signature d'un point d'entrée d'extension
        // SQLite (`int (*)(sqlite3*, char**, const sqlite3_api_routines*)`) ; la
        // crate sqlite-vec la déclare sans paramètres, d'où la conversion (D-7).
        let raw: rusqlite::auto_extension::RawAutoExtension =
            unsafe { std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ()) };
        // SAFETY: appelé une seule fois, avant l'ouverture de toute connexion.
        unsafe { rusqlite::auto_extension::register_auto_extension(raw) }
            .expect("enregistrement de sqlite-vec");
    });
}

/// Ouvre (ou crée) la base `path` pour des vecteurs de `dims` composantes.
pub fn ouvrir(path: &Path, dims: usize) -> Result<Connection, ErreurOuverture> {
    let autre = |e: &dyn std::fmt::Display| ErreurOuverture::Autre(e.to_string());
    enregistrer_sqlite_vec();
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| autre(&e))?;
    }
    let mut conn = Connection::open(path).map_err(|e| autre(&e))?;
    let etat = verifier_meta(&conn, dims)?;
    pragmas(&conn).map_err(ErreurOuverture::Autre)?;
    match etat {
        EtatBase::Vierge => creer_schema(&mut conn, dims).map_err(|e| autre(&e))?,
        EtatBase::AMigrer => migrer(&mut conn).map_err(|e| autre(&format!("migration v3 → v4 : {e}")))?,
        EtatBase::AJour => {}
    }
    Ok(conn)
}

/// Ce que [`verifier_meta`] a trouvé.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EtatBase {
    /// Aucune table : base à créer.
    Vierge,
    /// Base de version [`SCHEMA_VERSION`].
    AJour,
    /// Base de version [`VERSION_MIGRABLE`] : [`ouvrir`] la migre.
    AMigrer,
}

/// Contrôle d'une base ouverte, commun à [`ouvrir`] et [`ouvrir_simulation`] :
/// une base mem0-rs de version [`SCHEMA_VERSION`] (ou [`VERSION_MIGRABLE`]) et de
/// dimension `dims`, ou une base vierge (aucune table).
pub fn verifier_meta(conn: &Connection, dims: usize) -> Result<EtatBase, ErreurOuverture> {
    let autre = |e: &dyn std::fmt::Display| ErreurOuverture::Autre(e.to_string());
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .and_then(|mut st| st.query_map([], |r| r.get(0))?.collect())
        .map_err(|e| autre(&e))?;
    if !tables.iter().any(|t| t == "meta") {
        return if tables.is_empty() {
            Ok(EtatBase::Vierge)
        } else {
            Err(ErreurOuverture::Autre("ce n'est pas une base mem0-rs (table meta absente)".to_owned()))
        };
    }
    let lire = |cle: &str| -> Result<Option<String>, ErreurOuverture> {
        conn.query_row("SELECT valeur FROM meta WHERE cle = ?1", [cle], |r| r.get(0))
            .optional()
            .map_err(|e| autre(&e))
    };
    let version = lire("schema_version")?;
    let etat = match version.as_deref() {
        Some(SCHEMA_VERSION) => EtatBase::AJour,
        Some(VERSION_MIGRABLE) => EtatBase::AMigrer,
        _ => {
            return Err(ErreurOuverture::Autre(format!(
                "schema_version {} inconnue (attendue {SCHEMA_VERSION})",
                version.as_deref().unwrap_or("absente")
            )));
        }
    };
    let stockee = lire("embedding_dims")?.unwrap_or_default();
    if stockee != dims.to_string() {
        return Err(ErreurOuverture::Dims { stockee, demandee: dims });
    }
    Ok(etat)
}

/// Ouvre la base EXISTANTE `path` pour `--dry-run` (S-8), en lecture seule et
/// `immutable=1` : aucun fichier n'est créé ni modifié (ni `-wal`, ni `-shm`).
/// `Ok(None)` : base vierge, donc sans connaissance.
pub fn ouvrir_simulation(path: &Path, dims: usize) -> Result<Option<Connection>, ErreurOuverture> {
    enregistrer_sqlite_vec();
    let chemin = path
        .to_str()
        .ok_or_else(|| ErreurOuverture::Autre("chemin non UTF-8, inutilisable en URI SQLite".to_owned()))?;
    let uri = format!(
        "file:{}?mode=ro&immutable=1",
        chemin.replace('%', "%25").replace('?', "%3f").replace('#', "%23")
    );
    let conn = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| ErreurOuverture::Autre(e.to_string()))?;
    // Une base v3 se lit telle quelle : la simulation ne lit que memories, history
    // et messages, que la migration ne touche pas.
    Ok((verifier_meta(&conn, dims)? != EtatBase::Vierge).then_some(conn))
}

fn pragmas(conn: &Connection) -> Result<(), String> {
    let mode: String =
        conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(format!("journal_mode WAL refusé ({mode})"));
    }
    conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(|e| e.to_string())
}

fn creer_schema(conn: &mut Connection, dims: usize) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS meta (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS memories (
             rowid INTEGER PRIMARY KEY,
             id TEXT NOT NULL UNIQUE,
             memory TEXT NOT NULL,
             hash TEXT NOT NULL,
             user_id TEXT NOT NULL,
             agent_id TEXT,
             run_id TEXT,
             role TEXT,
             attributed_to TEXT,
             metadata TEXT,
             tags_present INTEGER NOT NULL,
             tags TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             updated_at_us INTEGER NOT NULL,
             sparse TEXT
         );
         CREATE INDEX IF NOT EXISTS memories_portee ON memories (user_id, agent_id);
         CREATE INDEX IF NOT EXISTS memories_recence ON memories (updated_at_us DESC, id);
         CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[{dims}] distance_metric=cosine);
         CREATE VIRTUAL TABLE IF NOT EXISTS memory_terms USING fts5(terms, tokenize='ascii');
         CREATE VIRTUAL TABLE IF NOT EXISTS memory_terms_vocab USING fts5vocab(memory_terms, 'row');
         CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, memory_id TEXT, old_memory TEXT, new_memory TEXT, event TEXT, created_at DATETIME, updated_at DATETIME, is_deleted INTEGER, actor_id TEXT, role TEXT);
         CREATE TABLE IF NOT EXISTS messages (
             rowid INTEGER PRIMARY KEY,
             id TEXT NOT NULL UNIQUE,
             session_scope TEXT NOT NULL,
             role TEXT,
             content TEXT,
             name TEXT,
             created_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS messages_portee ON messages (session_scope, created_at);"
    ))?;
    tx.execute_batch(liens::SCHEMA_V4)?;
    tx.execute(
        "INSERT INTO meta (cle, valeur) VALUES ('schema_version', ?1), ('embedding_dims', ?2), ('rappels_depuis_us', ?3)",
        params![SCHEMA_VERSION, dims.to_string(), horodatage::maintenant().micros.to_string()],
    )?;
    tx.commit()
}

/// Migration v3 → v4, en UNE transaction : les tables du schéma v4, puis
/// l'indexation (entités, voisins sémantiques) de chaque souvenir existant. Rien
/// de ce que la base contient n'est réécrit ; une erreur n'écrit rien.
fn migrer(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute_batch(liens::SCHEMA_V4)?;
    let instant = horodatage::maintenant();
    let ids: Vec<String> =
        tx.prepare("SELECT id FROM memories ORDER BY updated_at_us, id")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    for id in &ids {
        liens::indexer(&tx, id, &instant.iso)?;
    }
    tx.execute("UPDATE meta SET valeur = ?1 WHERE cle = 'schema_version'", [SCHEMA_VERSION])?;
    tx.execute(
        "INSERT OR REPLACE INTO meta (cle, valeur) VALUES ('rappels_depuis_us', ?1)",
        [instant.micros.to_string()],
    )?;
    tx.commit()
}

/// Depuis quand les rappels sont comptés (création de la base ou migration v4),
/// en microsecondes Unix ; 0 si inconnu.
pub fn rappels_depuis_us(conn: &Connection) -> rusqlite::Result<i64> {
    let brut: Option<String> =
        conn.query_row("SELECT valeur FROM meta WHERE cle = 'rappels_depuis_us'", [], |r| r.get(0)).optional()?;
    Ok(brut.and_then(|v| v.parse().ok()).unwrap_or(0))
}

/// Vecteur normalisé L2 en float32, en BLOB little-endian (D-5, D-7).
fn blob_normalise(vecteur: &[f32]) -> Vec<u8> {
    let norme = vecteur.iter().map(|x| x * x).sum::<f32>().sqrt();
    let echelle = if norme > 0.0 { 1.0 / norme } else { 1.0 };
    vecteur.iter().flat_map(|x| (x * echelle).to_le_bytes()).collect()
}

/// Termes BM25 de `texte` (S-6) : le vecteur creux en JSON `[[indice,poids],…]`
/// (colonne `memories.sparse`) et ses indices en jetons FTS5 `t<indice>`
/// (colonne `memory_terms.terms`), chacun une seule fois.
pub(crate) fn termes(texte: &str) -> rusqlite::Result<(String, String)> {
    let creux = bm25::encoder(texte);
    let json = serde_json::to_string(&creux).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    Ok((json, jetons_fts(creux.iter().map(|&(i, _)| i), " ")))
}

/// Les indices en jetons FTS5 `t<indice>`, joints par `separateur`.
fn jetons_fts(indices: impl Iterator<Item = u32>, separateur: &str) -> String {
    indices.map(|i| format!("t{i}")).collect::<Vec<_>>().join(separateur)
}

/// Souvenir à créer : add infer=false et add_procedure (`role` = `user`), ou
/// fait extrait par add infer=true (`role` absent).
pub struct NouveauSouvenir<'a> {
    pub id: &'a str,
    pub memory: &'a str,
    pub hash: &'a str,
    pub user_id: &'a str,
    pub agent_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    /// `None` : clé `role` absente du payload.
    pub role: Option<&'a str>,
    /// `attributed_to` en JSON compact ; `None` : clé absente.
    pub attributed_to: Option<&'a str>,
    /// `Some` : clé `tags` présente avec cette valeur.
    pub tags: Option<&'a str>,
    pub instant: &'a Instant,
}

/// Les étiquettes d'un PUT : champ absent, ou présent (y compris `null`).
pub enum Tags {
    Inchangees,
    Remplacees(Option<String>),
}

struct Revision<'a> {
    memory_id: &'a str,
    old_memory: Option<&'a str>,
    new_memory: Option<&'a str>,
    event: &'a str,
    created_at: &'a str,
    updated_at: Option<&'a str>,
    is_deleted: bool,
    role: Option<&'a str>,
}

fn historiser(tx: &rusqlite::Transaction<'_>, r: &Revision<'_>) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO history (id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)",
        params![
            uuid::Uuid::new_v4().to_string(),
            r.memory_id,
            r.old_memory,
            r.new_memory,
            r.event,
            r.created_at,
            r.updated_at,
            i64::from(r.is_deleted),
            r.role
        ],
    )?;
    Ok(())
}

/// Écrit le souvenir, son vecteur et ses termes (`sparse`, `terms` : [`termes`]) ;
/// `metadata` est NULL : seul l'import la remplit.
fn inserer(
    tx: &rusqlite::Transaction<'_>,
    s: &NouveauSouvenir<'_>,
    vecteur: &[f32],
    (sparse, terms): &(String, String),
) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO memories (id, memory, hash, user_id, agent_id, run_id, role, attributed_to, metadata, tags_present, tags, created_at, updated_at, updated_at_us, sparse)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, ?11, ?12, ?13)",
        params![
            s.id,
            s.memory,
            s.hash,
            s.user_id,
            s.agent_id,
            s.run_id,
            s.role,
            s.attributed_to,
            i64::from(s.tags.is_some()),
            s.tags,
            s.instant.iso,
            s.instant.micros,
            sparse
        ],
    )?;
    let rowid = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO memory_vec (rowid, embedding) VALUES (?1, ?2)",
        params![rowid, blob_normalise(vecteur)],
    )?;
    tx.execute("INSERT INTO memory_terms (rowid, terms) VALUES (?1, ?2)", params![rowid, terms])?;
    Ok(())
}

/// Écrit souvenir, vecteur, termes et révision ADD dans une transaction.
pub fn ajouter(conn: &mut Connection, s: &NouveauSouvenir<'_>, vecteur: &[f32]) -> rusqlite::Result<()> {
    let termes = termes(s.memory)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    ajouter_dans(&tx, s, vecteur, &termes, None)?;
    tx.commit()
}

/// [`ajouter`] dans une transaction ouverte, avec `metadata` (objet JSON compact)
/// s'il est donné : souvenir, vecteur, termes, révision ADD et index (entités,
/// voisins sémantiques).
pub(crate) fn ajouter_dans(
    tx: &rusqlite::Transaction<'_>,
    s: &NouveauSouvenir<'_>,
    vecteur: &[f32],
    termes: &(String, String),
    metadata: Option<&str>,
) -> rusqlite::Result<()> {
    inserer(tx, s, vecteur, termes)?;
    if metadata.is_some() {
        tx.execute("UPDATE memories SET metadata = ?1 WHERE id = ?2", params![metadata, s.id])?;
    }
    historiser(
        tx,
        &Revision {
            memory_id: s.id,
            old_memory: None,
            new_memory: Some(s.memory),
            event: "ADD",
            created_at: &s.instant.iso,
            updated_at: Some(&s.instant.iso),
            is_deleted: false,
            role: s.role,
        },
    )?;
    liens::indexer(tx, s.id, &s.instant.iso)
}

/// Un fait retenu par add infer=true (S-4), prêt à écrire.
pub struct FaitInfere {
    pub id: String,
    pub memory: String,
    pub hash: String,
    /// Valeur JSON quelconque ; `None` : clé absente.
    pub attributed_to: Option<Value>,
    pub instant: Instant,
    pub vecteur: Vec<f32>,
}

/// Le message d'une requête add infer=true, sauvé dans `messages` (S-5).
pub struct MessageSession {
    pub id: String,
    /// Scope de session (`agent_id=…&user_id=moi`).
    pub portee: String,
    pub content: String,
    pub instant: Instant,
}

/// Insère `message` (role `user`, name NULL) puis ne garde que les
/// [`MESSAGES_PAR_PORTEE`] plus récents de son scope.
fn inserer_message(tx: &rusqlite::Transaction<'_>, message: &MessageSession) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO messages (id, session_scope, role, content, name, created_at) VALUES (?1, ?2, 'user', ?3, NULL, ?4)",
        params![message.id, message.portee, message.content, message.instant.iso],
    )?;
    tx.execute(
        "DELETE FROM messages WHERE session_scope = ?1 AND rowid NOT IN (
             SELECT rowid FROM messages WHERE session_scope = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)",
        params![message.portee, MESSAGES_PAR_PORTEE as i64],
    )?;
    Ok(())
}

/// Sauve `message` seul, dans une transaction (add infer=true sans fait écrit).
pub fn sauver_message(conn: &mut Connection, message: &MessageSession) -> rusqlite::Result<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    inserer_message(&tx, message)?;
    tx.commit()
}

/// Écrit les `faits` extraits (souvenir sans `role`, vecteur, termes, révision
/// ADD sans `updated_at` ni `role`) puis sauve `message`, dans UNE transaction :
/// une erreur n'écrit rien. `tags` : comme [`NouveauSouvenir::tags`].
pub fn ajouter_infere(
    conn: &mut Connection,
    user_id: &str,
    agent_id: Option<&str>,
    run_id: Option<&str>,
    tags: Option<&str>,
    faits: &[FaitInfere],
    message: &MessageSession,
) -> rusqlite::Result<()> {
    let mut prepares = Vec::with_capacity(faits.len());
    for f in faits {
        let attributed_to = f
            .attributed_to
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        prepares.push((termes(&f.memory)?, attributed_to));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (f, (termes, attributed_to)) in faits.iter().zip(&prepares) {
        let s = NouveauSouvenir {
            id: &f.id,
            memory: &f.memory,
            hash: &f.hash,
            user_id,
            agent_id,
            run_id,
            role: None,
            attributed_to: attributed_to.as_deref(),
            tags,
            instant: &f.instant,
        };
        inserer(&tx, &s, &f.vecteur, termes)?;
        historiser(
            &tx,
            &Revision {
                memory_id: &f.id,
                old_memory: None,
                new_memory: Some(&f.memory),
                event: "ADD",
                created_at: &f.instant.iso,
                updated_at: None,
                is_deleted: false,
                role: None,
            },
        )?;
        liens::indexer(&tx, &f.id, &f.instant.iso)?;
    }
    inserer_message(&tx, message)?;
    tx.commit()
}

/// Les `n` messages les plus récents du scope `portee` (`created_at` puis
/// rowid décroissants), rendus du plus ancien au plus récent, en
/// `(role, content)` ; un NULL est rendu `""`.
pub fn derniers_messages(conn: &Connection, portee: &str, n: usize) -> rusqlite::Result<Vec<(String, String)>> {
    let mut st = conn.prepare_cached(
        "SELECT role, content FROM (
             SELECT rowid, role, content, created_at FROM messages WHERE session_scope = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT ?2)
         ORDER BY created_at ASC, rowid ASC",
    )?;
    st.query_map(params![portee, i64::try_from(n).unwrap_or(i64::MAX)], |r| {
        let role: Option<String> = r.get(0)?;
        let content: Option<String> = r.get(1)?;
        Ok((role.unwrap_or_default(), content.unwrap_or_default()))
    })?
    .collect()
}

/// Le souvenir `id` existe-t-il ?
pub fn existe(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    conn.query_row("SELECT 1 FROM memories WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
}

/// Réécrit le souvenir `id` (fusion D-1) ; `false` s'il n'existe pas.
pub fn mettre_a_jour(
    conn: &mut Connection,
    id: &str,
    texte: &str,
    hash: &str,
    tags: &Tags,
    vecteur: &[f32],
    instant: &Instant,
) -> rusqlite::Result<bool> {
    let termes = termes(texte)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !mettre_a_jour_dans(&tx, id, texte, hash, tags, vecteur, instant, &termes)? {
        return Ok(false);
    }
    tx.commit()?;
    Ok(true)
}

/// [`mettre_a_jour`] dans une transaction ouverte ; réindexe le souvenir.
#[allow(clippy::too_many_arguments, reason = "les champs d'un PUT, plus la transaction et les termes déjà calculés")]
pub(crate) fn mettre_a_jour_dans(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
    texte: &str,
    hash: &str,
    tags: &Tags,
    vecteur: &[f32],
    instant: &Instant,
    (sparse, terms): &(String, String),
) -> rusqlite::Result<bool> {
    let actuel: Option<(i64, String, String, Option<String>)> = tx
        .query_row(
            "SELECT rowid, memory, created_at, role FROM memories WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((rowid, ancien, created_at, role)) = actuel else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE memories SET memory = ?1, hash = ?2, updated_at = ?3, updated_at_us = ?4, sparse = ?5 WHERE rowid = ?6",
        params![texte, hash, instant.iso, instant.micros, sparse, rowid],
    )?;
    if let Tags::Remplacees(valeur) = tags {
        tx.execute(
            "UPDATE memories SET tags_present = 1, tags = ?1 WHERE rowid = ?2",
            params![valeur, rowid],
        )?;
    }
    tx.execute("DELETE FROM memory_vec WHERE rowid = ?1", [rowid])?;
    tx.execute(
        "INSERT INTO memory_vec (rowid, embedding) VALUES (?1, ?2)",
        params![rowid, blob_normalise(vecteur)],
    )?;
    tx.execute("UPDATE memory_terms SET terms = ?1 WHERE rowid = ?2", params![terms, rowid])?;
    historiser(
        tx,
        &Revision {
            memory_id: id,
            old_memory: Some(&ancien),
            new_memory: Some(texte),
            event: "UPDATE",
            created_at: &created_at,
            updated_at: Some(&instant.iso),
            is_deleted: false,
            role: role.as_deref(),
        },
    )?;
    liens::indexer(tx, id, &instant.iso)?;
    Ok(true)
}

/// Supprime le souvenir `id` (souvenir, vecteur, termes) ; `false` s'il n'existe pas.
pub fn supprimer(conn: &mut Connection, id: &str, instant: &Instant) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !supprimer_dans(&tx, id, instant)? {
        return Ok(false);
    }
    tx.commit()?;
    Ok(true)
}

/// [`supprimer`] dans une transaction ouverte ; retire aussi ce que le souvenir
/// laisse dans le graphe ([`liens::desindexer`]).
pub(crate) fn supprimer_dans(tx: &rusqlite::Transaction<'_>, id: &str, instant: &Instant) -> rusqlite::Result<bool> {
    let actuel: Option<(i64, String, String, Option<String>)> = tx
        .query_row(
            "SELECT rowid, memory, created_at, role FROM memories WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((rowid, texte, created_at, role)) = actuel else {
        return Ok(false);
    };
    tx.execute("DELETE FROM memory_vec WHERE rowid = ?1", [rowid])?;
    tx.execute("DELETE FROM memory_terms WHERE rowid = ?1", [rowid])?;
    tx.execute("DELETE FROM memories WHERE rowid = ?1", [rowid])?;
    historiser(
        tx,
        &Revision {
            memory_id: id,
            old_memory: Some(&texte),
            new_memory: None,
            event: "DELETE",
            created_at: &created_at,
            updated_at: Some(&instant.iso),
            is_deleted: true,
            role: role.as_deref(),
        },
    )?;
    liens::desindexer(tx, id, &instant.iso)?;
    Ok(true)
}

/// Un souvenir tel que stocké.
#[derive(Debug, Clone)]
pub struct Souvenir {
    pub id: String,
    pub memory: String,
    pub hash: String,
    /// `Some(v)` : clé `tags` présente (valeur `v`, éventuellement null).
    pub tags: Option<Option<String>>,
    pub created_at: String,
    pub updated_at: String,
    pub user_id: String,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    /// `None` : clé `role` absente (souvenir extrait par add infer=true).
    pub role: Option<String>,
    /// `None` : clé `attributed_to` absente.
    pub attributed_to: Option<Value>,
    /// Clés du payload source hors cœur (import), sans `tags` ; `None` : aucune.
    pub metadata: Option<Map<String, Value>>,
}

/// Colonnes d'un [`Souvenir`] (alias `m` pour `memories`), lues par [`souvenir`].
const COLONNES: &str = "m.id, m.memory, m.hash, m.tags_present, m.tags, m.created_at, m.updated_at, m.user_id, m.agent_id, m.run_id, m.role, m.attributed_to, m.metadata";
/// Nombre de colonnes de [`COLONNES`] : l'indice de la première colonne suivante.
const NB_COLONNES: usize = 13;

fn souvenir(r: &Row<'_>) -> rusqlite::Result<Souvenir> {
    let present: i64 = r.get(3)?;
    let tags: Option<String> = r.get(4)?;
    let attributed_to: Option<String> = r.get(11)?;
    let metadata: Option<String> = r.get(12)?;
    Ok(Souvenir {
        id: r.get(0)?,
        memory: r.get(1)?,
        hash: r.get(2)?,
        tags: (present != 0).then_some(tags),
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        user_id: r.get(7)?,
        agent_id: r.get(8)?,
        run_id: r.get(9)?,
        role: r.get(10)?,
        attributed_to: attributed_to
            .map(|j| serde_json::from_str(&j))
            .transpose()
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(11, Type::Text, Box::new(e)))?,
        metadata: metadata
            .map(|j| serde_json::from_str(&j))
            .transpose()
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(12, Type::Text, Box::new(e)))?,
    })
}

/// Tous les souvenirs du scope, `updated_at` décroissant puis `id` croissant (S-4).
pub fn tous(conn: &Connection, user_id: &str, agent_id: Option<&str>) -> rusqlite::Result<Vec<Souvenir>> {
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLONNES}
         FROM memories m
         WHERE m.user_id = ?1 AND (?2 IS NULL OR m.agent_id = ?2)
         ORDER BY m.updated_at_us DESC, m.id ASC"
    ))?;
    st.query_map(params![user_id, agent_id], souvenir)?.collect()
}

/// Les souvenirs du scope `user_id`/`agent_id` avec leur cosinus brut avec
/// `requete` (S-5, étape 4) : `1 − vec_distance_cosine` sur des vecteurs
/// normalisés en float32, comme Qdrant. Un cosinus indéfini vaut 0.
pub fn cosinus(
    conn: &Connection,
    user_id: &str,
    agent_id: Option<&str>,
    requete: &[f32],
) -> rusqlite::Result<Vec<(Souvenir, f64)>> {
    cosinus_portee(conn, user_id, agent_id, None, requete)
}

/// [`cosinus`], restreint en plus à `run_id` s'il est donné.
fn cosinus_portee(
    conn: &Connection,
    user_id: &str,
    agent_id: Option<&str>,
    run_id: Option<&str>,
    requete: &[f32],
) -> rusqlite::Result<Vec<(Souvenir, f64)>> {
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLONNES}, 1.0 - vec_distance_cosine(v.embedding, ?4)
         FROM memories m JOIN memory_vec v ON v.rowid = m.rowid
         WHERE m.user_id = ?1 AND (?2 IS NULL OR m.agent_id = ?2) AND (?3 IS NULL OR m.run_id = ?3)"
    ))?;
    st.query_map(params![user_id, agent_id, run_id, blob_normalise(requete)], |r| {
        let cos: Option<f64> = r.get(NB_COLONNES)?;
        Ok((souvenir(r)?, cos.filter(|c| c.is_finite()).unwrap_or(0.0)))
    })?
    .collect()
}

/// Les `n` souvenirs les plus proches de `vecteur` dans le scope
/// `user_id`/`agent_id`/`run_id` (S-2, étape 4) : cosinus décroissant, puis
/// `id` croissant, sans seuil.
pub fn voisins(
    conn: &Connection,
    user_id: &str,
    agent_id: Option<&str>,
    run_id: Option<&str>,
    vecteur: &[f32],
    n: usize,
) -> rusqlite::Result<Vec<(Souvenir, f64)>> {
    let mut proches = cosinus_portee(conn, user_id, agent_id, run_id, vecteur)?;
    proches.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.id.cmp(&b.0.id)));
    proches.truncate(n);
    Ok(proches)
}

/// Statistiques de l'IDF (D-5) sur TOUTE la base : N = nombre de souvenirs qui
/// portent un vecteur creux (`sparse` non NULL, comme le N de Qdrant), et pour
/// chaque indice, le nombre de souvenirs dont le vecteur creux le porte
/// (`fts5vocab`, colonne `doc`).
pub fn statistiques_idf(conn: &Connection, indices: &[u32]) -> rusqlite::Result<(u64, HashMap<u32, u64>)> {
    let total: i64 = conn.query_row("SELECT count(*) FROM memories WHERE sparse IS NOT NULL", [], |r| r.get(0))?;
    let mut st = conn.prepare_cached("SELECT doc FROM memory_terms_vocab WHERE term = ?1")?;
    let mut documents = HashMap::with_capacity(indices.len());
    for &i in indices {
        let n: Option<i64> = st.query_row([format!("t{i}")], |r| r.get(0)).optional()?;
        documents.insert(i, n.unwrap_or(0).unsigned_abs());
    }
    Ok((total.unsigned_abs(), documents))
}

/// Les souvenirs du scope qui portent au moins un des `indices` (FTS5), avec
/// leur vecteur creux (S-5, étape 5) ; un souvenir sans vecteur creux est exclu.
pub fn porteurs(
    conn: &Connection,
    user_id: &str,
    agent_id: Option<&str>,
    indices: &[u32],
) -> rusqlite::Result<Vec<(Souvenir, VecteurCreux)>> {
    if indices.is_empty() {
        return Ok(Vec::new());
    }
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLONNES}, m.sparse
         FROM memory_terms JOIN memories m ON m.rowid = memory_terms.rowid
         WHERE memory_terms MATCH ?3 AND m.user_id = ?1 AND (?2 IS NULL OR m.agent_id = ?2) AND m.sparse IS NOT NULL"
    ))?;
    let requete = jetons_fts(indices.iter().copied(), " OR ");
    st.query_map(params![user_id, agent_id, requete], |r| {
        let sparse: String = r.get(NB_COLONNES)?;
        let creux: VecteurCreux = serde_json::from_str(&sparse)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(NB_COLONNES, Type::Text, Box::new(e)))?;
        Ok((souvenir(r)?, creux))
    })?
    .collect()
}

/// Les vecteurs denses (normalisés, float32) des souvenirs de `user_id` (S-7).
pub fn vecteurs(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<(String, Vec<f32>)>> {
    let mut st = conn.prepare_cached(
        "SELECT m.id, v.embedding FROM memories m JOIN memory_vec v ON v.rowid = m.rowid WHERE m.user_id = ?1",
    )?;
    st.query_map([user_id], |r| {
        let blob: Vec<u8> = r.get(1)?;
        let vecteur = blob.as_chunks::<4>().0.iter().map(|o| f32::from_le_bytes(*o)).collect();
        Ok((r.get(0)?, vecteur))
    })?
    .collect()
}

/// Une ligne d'historique, sérialisée dans l'ordre de clés du Python (D-1).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LigneHistorique {
    pub id: String,
    pub memory_id: Option<String>,
    pub old_memory: Option<String>,
    pub new_memory: Option<String>,
    pub event: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub is_deleted: bool,
    pub actor_id: Option<String>,
    pub role: Option<String>,
}

/// Les révisions de `memory_id`, dans l'ordre de mem0 (storage.py) puis d'insertion.
pub fn historique(conn: &Connection, memory_id: &str) -> rusqlite::Result<Vec<LigneHistorique>> {
    let mut st = conn.prepare_cached(
        "SELECT id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role
         FROM history WHERE memory_id = ?1
         ORDER BY created_at ASC, DATETIME(updated_at) ASC, rowid ASC",
    )?;
    st.query_map([memory_id], |r| {
        let supprime: Option<i64> = r.get(7)?;
        Ok(LigneHistorique {
            id: r.get(0)?,
            memory_id: r.get(1)?,
            old_memory: r.get(2)?,
            new_memory: r.get(3)?,
            event: r.get(4)?,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            is_deleted: supprime.unwrap_or(0) != 0,
            actor_id: r.get(8)?,
            role: r.get(9)?,
        })
    })?
    .collect()
}

/// Ce que la base cible « connaît » déjà (S-6 de mem0-rs-migration) : un id de
/// souvenir présent dans `memories.id` OU dans `history.memory_id` (un souvenir
/// supprimé n'est jamais ressuscité), et les portées qui ont au moins un message.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Connaissances {
    pub ids: HashSet<String>,
    pub portees: HashSet<String>,
}

pub fn connaissances(conn: &Connection) -> rusqlite::Result<Connaissances> {
    let ids = conn
        .prepare("SELECT id FROM memories UNION SELECT memory_id FROM history WHERE memory_id IS NOT NULL")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let portees = conn
        .prepare("SELECT DISTINCT session_scope FROM messages")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Connaissances { ids, portees })
}

/// Un point source valide, écrit tel quel par [`importer`] (S-5).
#[derive(Debug, Clone, PartialEq)]
pub struct SouvenirImporte {
    pub id: String,
    pub memory: String,
    pub hash: String,
    pub user_id: String,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub role: Option<String>,
    /// JSON compact ; `None` : clé absente.
    pub attributed_to: Option<String>,
    /// Objet JSON compact des clés hors cœur ; `None` : aucune.
    pub metadata: Option<String>,
    /// `Some(v)` : clé `tags` présente avec la valeur `v`.
    pub tags: Option<Option<String>>,
    pub created_at: String,
    pub updated_at: String,
    pub updated_at_us: i64,
    /// Le `bm25` source dans l'ordre reçu ; `None` : la source n'en a pas.
    pub creux: Option<VecteurCreux>,
    pub dense: Vec<f32>,
}

/// Une ligne de `history` source, recopiée verbatim (`is_deleted` NULL → 0).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionImportee {
    pub id: String,
    pub memory_id: Option<String>,
    pub old_memory: Option<String>,
    pub new_memory: Option<String>,
    pub event: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub is_deleted: i64,
    pub actor_id: Option<String>,
    pub role: Option<String>,
}

/// Une ligne de `messages` source, recopiée verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageImporte {
    pub id: String,
    pub session_scope: String,
    pub role: Option<String>,
    pub content: Option<String>,
    pub name: Option<String>,
    pub created_at: String,
}

/// Ce qu'un plan d'import écrit, dans l'ordre d'écriture.
#[derive(Debug, Default)]
pub struct Ecritures<'a> {
    pub souvenirs: Vec<&'a SouvenirImporte>,
    pub revisions: Vec<&'a RevisionImportee>,
    pub messages: Vec<&'a MessageImporte>,
}

/// Import (S-7, étape 5) : dans UNE transaction `IMMEDIATE`, lit les
/// [`Connaissances`], calcule le plan avec `calculer`, écrit ses souvenirs
/// (vecteur dense par [`blob_normalise`], termes = indices du creux source),
/// ses révisions et ses messages verbatim, puis `COMMIT`. Une erreur n'écrit rien.
pub fn importer<'a>(
    conn: &mut Connection,
    calculer: impl FnOnce(&Connaissances) -> crate::import::Plan<'a>,
) -> rusqlite::Result<crate::import::Plan<'a>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let plan = calculer(&connaissances(&tx)?);
    let ecritures = &plan.a_ecrire;
    for s in &ecritures.souvenirs {
        inserer_importe(&tx, s)?;
    }
    let instant = horodatage::maintenant();
    for s in &ecritures.souvenirs {
        liens::indexer(&tx, &s.id, &instant.iso)?;
    }
    for r in &ecritures.revisions {
        tx.execute(
            "INSERT INTO history (id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                r.id,
                r.memory_id,
                r.old_memory,
                r.new_memory,
                r.event,
                r.created_at,
                r.updated_at,
                r.is_deleted,
                r.actor_id,
                r.role
            ],
        )?;
    }
    for m in &ecritures.messages {
        tx.execute(
            "INSERT INTO messages (id, session_scope, role, content, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![m.id, m.session_scope, m.role, m.content, m.name, m.created_at],
        )?;
    }
    tx.commit()?;
    Ok(plan)
}

fn inserer_importe(tx: &rusqlite::Transaction<'_>, s: &SouvenirImporte) -> rusqlite::Result<()> {
    let sparse = s
        .creux
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    let terms = s.creux.as_ref().map_or_else(String::new, |creux| {
        let mut vus = HashSet::with_capacity(creux.len());
        jetons_fts(creux.iter().map(|&(i, _)| i).filter(|i| vus.insert(*i)), " ")
    });
    tx.execute(
        "INSERT INTO memories (id, memory, hash, user_id, agent_id, run_id, role, attributed_to, metadata, tags_present, tags, created_at, updated_at, updated_at_us, sparse)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            s.id,
            s.memory,
            s.hash,
            s.user_id,
            s.agent_id,
            s.run_id,
            s.role,
            s.attributed_to,
            s.metadata,
            i64::from(s.tags.is_some()),
            s.tags.as_ref().and_then(Option::as_deref),
            s.created_at,
            s.updated_at,
            s.updated_at_us,
            sparse
        ],
    )?;
    let rowid = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO memory_vec (rowid, embedding) VALUES (?1, ?2)",
        params![rowid, blob_normalise(&s.dense)],
    )?;
    tx.execute("INSERT INTO memory_terms (rowid, terms) VALUES (?1, ?2)", params![rowid, terms])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    /// Fichier de base temporaire, effacé (avec -wal et -shm) à la fin du test.
    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            Temp(std::env::temp_dir().join(format!("mem0-rs-db-{}.db", uuid::Uuid::new_v4())))
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            for suffixe in ["", "-wal", "-shm"] {
                let mut p = self.0.clone().into_os_string();
                p.push(suffixe);
                let _ = std::fs::remove_file(p);
            }
        }
    }

    const DIMS: usize = 3;

    fn instant(seconde: u32) -> Instant {
        Instant { iso: format!("2026-10-12T00:00:{seconde:02}+00:00"), micros: 1_791_763_200_000_000 + i64::from(seconde) * 1_000_000 }
    }

    fn message(portee: &str, content: &str, i: &Instant) -> MessageSession {
        MessageSession {
            id: uuid::Uuid::new_v4().to_string(),
            portee: portee.to_owned(),
            content: content.to_owned(),
            instant: i.clone(),
        }
    }

    fn fait(memory: &str, attributed_to: Option<Value>, vecteur: Vec<f32>, i: Instant) -> FaitInfere {
        FaitInfere {
            id: uuid::Uuid::new_v4().to_string(),
            memory: memory.to_owned(),
            hash: format!("h-{memory}"),
            attributed_to,
            instant: i,
            vecteur,
        }
    }

    fn ajouter_simple(conn: &mut Connection, id: &str, agent_id: Option<&str>, run_id: Option<&str>, vecteur: &[f32]) {
        let i = instant(0);
        let s = NouveauSouvenir {
            id,
            memory: id,
            hash: id,
            user_id: "moi",
            agent_id,
            run_id,
            role: Some("user"),
            attributed_to: None,
            tags: None,
            instant: &i,
        };
        ajouter(conn, &s, vecteur).unwrap();
    }

    #[test]
    fn schema_v1_refusee() {
        let base = Temp::new();
        Connection::open(&base.0)
            .unwrap()
            .execute_batch(
                "CREATE TABLE meta (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);
                 INSERT INTO meta (cle, valeur) VALUES ('schema_version', '1'), ('embedding_dims', '3');
                 CREATE TABLE memories (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, role TEXT NOT NULL);",
            )
            .unwrap();
        let avant = std::fs::read(&base.0).unwrap();
        let Err(ErreurOuverture::Autre(raison)) = ouvrir(&base.0, DIMS) else {
            panic!("une base v1 doit être refusée");
        };
        assert_eq!(raison, "schema_version 1 inconnue (attendue 4)");
        assert_eq!(std::fs::read(&base.0).unwrap(), avant);
    }

    /// AC-5 (S-6) : la cible connaît un id par `memories` OU par `history.memory_id`
    /// (souvenir supprimé), et une portée par `messages`.
    #[test]
    fn ac5_connaissances_memories_historique_et_portees() {
        let base = Temp::new();
        let mut conn = ouvrir(&base.0, DIMS).unwrap();
        ajouter_simple(&mut conn, "vivant", Some("a1"), None, &[1.0, 0.0, 0.0]);
        ajouter_simple(&mut conn, "mort", Some("a1"), None, &[0.0, 1.0, 0.0]);
        assert!(supprimer(&mut conn, "mort", &instant(3)).unwrap());
        sauver_message(&mut conn, &message("agent_id=a1&user_id=moi", "c", &instant(4))).unwrap();
        assert_eq!(
            connaissances(&conn).unwrap(),
            Connaissances {
                ids: ["vivant", "mort"].map(String::from).into(),
                portees: ["agent_id=a1&user_id=moi".to_owned()].into(),
            }
        );
    }

    /// AC-9 (S-8) : la simulation lit une base existante sans créer `-wal` ni `-shm`
    /// et sans changer un octet ; elle contrôle `meta` comme `ouvrir`.
    #[test]
    fn ac9_ouvrir_simulation_sans_ecriture() {
        let base = Temp::new();
        {
            let mut conn = ouvrir(&base.0, DIMS).unwrap();
            ajouter_simple(&mut conn, "s1", Some("a1"), None, &[1.0, 0.0, 0.0]);
        }
        let voisin = |s: &str| {
            let mut p = base.0.clone().into_os_string();
            p.push(s);
            PathBuf::from(p)
        };
        assert!(!voisin("-wal").exists() && !voisin("-shm").exists());
        let avant = std::fs::read(&base.0).unwrap();
        let conn = ouvrir_simulation(&base.0, DIMS).unwrap().expect("base non vierge");
        assert_eq!(connaissances(&conn).unwrap().ids, ["s1".to_owned()].into());
        drop(conn);
        assert!(!voisin("-wal").exists() && !voisin("-shm").exists());
        assert_eq!(std::fs::read(&base.0).unwrap(), avant);
        let Err(ErreurOuverture::Dims { stockee, demandee }) = ouvrir_simulation(&base.0, 4) else {
            panic!("dimension différente : refus attendu");
        };
        assert_eq!((stockee.as_str(), demandee), ("3", 4));
        let vierge = Temp::new();
        std::fs::write(&vierge.0, b"").unwrap();
        assert!(ouvrir_simulation(&vierge.0, DIMS).unwrap().is_none());
        assert_eq!(std::fs::read(&vierge.0).unwrap(), b"");
    }

    /// mem0-rs-migration S-11 / D-2 : une base v2 est refusée sans migration, fichier intact.
    #[test]
    fn schema_v2_refusee_sans_migration() {
        let base = Temp::new();
        Connection::open(&base.0)
            .unwrap()
            .execute_batch(
                "CREATE TABLE meta (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);
                 INSERT INTO meta (cle, valeur) VALUES ('schema_version', '2'), ('embedding_dims', '3');
                 CREATE TABLE memories (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, memory TEXT NOT NULL, hash TEXT NOT NULL,
                     user_id TEXT NOT NULL, agent_id TEXT, run_id TEXT, role TEXT, attributed_to TEXT, tags_present INTEGER NOT NULL,
                     tags TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_at_us INTEGER NOT NULL, sparse TEXT NOT NULL);
                 INSERT INTO memories VALUES (1, 'a', 'a', 'h', 'moi', NULL, NULL, 'user', NULL, 0, NULL, 'c', 'u', 0, '[]');",
            )
            .unwrap();
        let avant = std::fs::read(&base.0).unwrap();
        let Err(ErreurOuverture::Autre(raison)) = ouvrir(&base.0, DIMS) else {
            panic!("une base v2 doit être refusée");
        };
        assert_eq!(raison, "schema_version 2 inconnue (attendue 4)");
        assert_eq!(std::fs::read(&base.0).unwrap(), avant);
    }

    /// mem0-rs-migration S-11 (pré-requis de AC-1..AC-3) : `memories.metadata`
    /// après `attributed_to`, `sparse` nullable.
    #[test]
    fn ac1_ac5_base_neuve_en_v4() {
        let base = Temp::new();
        let conn = ouvrir(&base.0, DIMS).unwrap();
        let version: String =
            conn.query_row("SELECT valeur FROM meta WHERE cle = 'schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, "4");
        let colonnes = |table: &str| -> Vec<(String, bool)> {
            conn.prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(3)? != 0)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let liste = |c: &[(&str, bool)]| -> Vec<(String, bool)> { c.iter().map(|&(c, n)| (c.to_owned(), n)).collect() };
        assert_eq!(
            colonnes("memories"),
            liste(&[
                ("rowid", false),
                ("id", true),
                ("memory", true),
                ("hash", true),
                ("user_id", true),
                ("agent_id", false),
                ("run_id", false),
                ("role", false),
                ("attributed_to", false),
                ("metadata", false),
                ("tags_present", true),
                ("tags", false),
                ("created_at", true),
                ("updated_at", true),
                ("updated_at_us", true),
                ("sparse", false),
            ])
        );
        assert_eq!(
            colonnes("messages"),
            liste(&[
                ("rowid", false),
                ("id", true),
                ("session_scope", true),
                ("role", false),
                ("content", false),
                ("name", false),
                ("created_at", true),
            ])
        );
        let index: String = conn
            .query_row("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'messages_portee'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(index, "CREATE INDEX messages_portee ON messages (session_scope, created_at)");
        drop(conn);
        // Une base v4 se rouvre.
        ouvrir(&base.0, DIMS).unwrap();
    }

    /// memoire-liee : une base v3 est migrée à l'ouverture, sans perte — tables du
    /// schéma v4 créées, souvenirs indexés (entités, voisins sémantiques), rien
    /// d'autre réécrit ; la simulation la lit sans la migrer.
    #[test]
    fn migration_v3_vers_v4_indexe_sans_rien_perdre() {
        let base = Temp::new();
        {
            let mut conn = ouvrir(&base.0, DIMS).unwrap();
            ajouter_simple(&mut conn, "a", Some("p"), None, &[1.0, 0.0, 0.0]);
            ajouter_simple(&mut conn, "b", Some("p"), None, &[0.9, 0.1, 0.0]);
            conn.execute("UPDATE memories SET memory = 'le bug de recall.ts' WHERE id = 'a'", []).unwrap();
            // Retour à une base v3 : tables du schéma v4 retirées.
            for table in ["entites", "souvenir_entites", "liens", "indexes", "rappels", "paires_jugees", "propositions", "reves", "modeles", "consolidations"] {
                conn.execute_batch(&format!("DROP TABLE {table}")).unwrap();
            }
            conn.execute("UPDATE meta SET valeur = '3' WHERE cle = 'schema_version'", []).unwrap();
            conn.execute("DELETE FROM meta WHERE cle = 'rappels_depuis_us'", []).unwrap();
        }
        let simulation = ouvrir_simulation(&base.0, DIMS).unwrap().expect("base v3 lisible en simulation");
        assert_eq!(connaissances(&simulation).unwrap().ids, ["a", "b"].map(String::from).into());
        drop(simulation);
        let conn = ouvrir(&base.0, DIMS).unwrap();
        let version: String =
            conn.query_row("SELECT valeur FROM meta WHERE cle = 'schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(version, "4");
        assert!(rappels_depuis_us(&conn).unwrap() > 0);
        assert_eq!(tous(&conn, "moi", Some("p")).unwrap().len(), 2);
        let entites: Vec<String> = conn
            .prepare("SELECT e.cle FROM souvenir_entites se JOIN entites e ON e.id = se.entite WHERE se.memory_id = 'a'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(entites, ["recall.ts"]);
        let liens = crate::liens::liens_touchant(&conn, &["a"]).unwrap();
        assert_eq!(liens.len(), 1);
        assert_eq!((liens[0].source.as_str(), liens[0].target.as_str(), liens[0].type_.as_str()), ("a", "b", "semantique"));
        assert!(crate::liens::a_reindexer(&conn, None, 10).unwrap().is_empty());
    }

    /// memoire-liee : supprimer un souvenir retire ses liens et ses entités.
    #[test]
    fn suppression_retire_liens_et_entites() {
        let base = Temp::new();
        let mut conn = ouvrir(&base.0, DIMS).unwrap();
        ajouter_simple(&mut conn, "a", Some("p"), None, &[1.0, 0.0, 0.0]);
        ajouter_simple(&mut conn, "b", Some("p"), None, &[1.0, 0.05, 0.0]);
        // Hors portée : jamais voisin.
        ajouter_simple(&mut conn, "c", Some("q"), None, &[1.0, 0.0, 0.0]);
        assert_eq!(crate::liens::liens_touchant(&conn, &["a"]).unwrap().len(), 1);
        assert!(crate::liens::liens_touchant(&conn, &["c"]).unwrap().is_empty());
        assert!(supprimer(&mut conn, "b", &instant(9)).unwrap());
        assert!(crate::liens::liens_touchant(&conn, &["a", "b"]).unwrap().is_empty());
    }

    /// Ligne écrite comme l'import (BR-2) : `sparse` NULL, `metadata` donnée,
    /// `terms` tels quels (`''` pour respecter l'invariant).
    fn inserer_importe(conn: &Connection, id: &str, terms: &str, metadata: Option<&str>) {
        conn.execute(
            "INSERT INTO memories (id, memory, hash, user_id, agent_id, run_id, role, attributed_to, metadata, tags_present, tags, created_at, updated_at, updated_at_us, sparse)
             VALUES (?1, ?1, ?1, 'moi', 'ag', NULL, 'user', NULL, ?2, 1, 'x', 'c', 'u', 0, NULL)",
            params![id, metadata],
        )
        .unwrap();
        let rowid = conn.last_insert_rowid();
        conn.execute("INSERT INTO memory_vec (rowid, embedding) VALUES (?1, ?2)", params![rowid, blob_normalise(&[0.0, 1.0, 0.0])])
            .unwrap();
        conn.execute("INSERT INTO memory_terms (rowid, terms) VALUES (?1, ?2)", params![rowid, terms]).unwrap();
    }

    /// mem0-rs-migration S-11 (pré-requis de AC-1, AC-2, AC-3) : un souvenir sans
    /// vecteur creux est hors du N de l'IDF et des porteurs BM25 ; `metadata` est
    /// relue ; les écritures du serveur écrivent `metadata` NULL et ne la touchent
    /// plus ; un PUT recalcule `sparse`.
    #[test]
    fn ac1_ac2_ac3_sparse_null_hors_idf_et_metadata_relue() {
        let base = Temp::new();
        let mut conn = ouvrir(&base.0, DIMS).unwrap();
        ajouter_simple(&mut conn, "natif", Some("ag"), None, &[1.0, 0.0, 0.0]);
        let indices: Vec<u32> = bm25::encoder("natif").iter().map(|&(i, _)| i).collect();
        inserer_importe(&conn, "importe", "", Some(r#"{"memory_type":"procedural_memory","n":[1,2]}"#));
        // Invariant violé exprès : des termes FTS sans `sparse` ne doivent ni casser
        // la lecture ni rendre le souvenir porteur.
        inserer_importe(&conn, "incoherent", &jetons_fts(indices.iter().copied(), " "), None);

        let (total, _) = statistiques_idf(&conn, &indices).unwrap();
        assert_eq!(total, 1, "N ne compte que les souvenirs à vecteur creux");
        let ids = |p: Vec<(Souvenir, VecteurCreux)>| -> Vec<String> {
            let mut v: Vec<String> = p.into_iter().map(|(s, _)| s.id).collect();
            v.sort();
            v
        };
        assert_eq!(ids(porteurs(&conn, "moi", None, &indices).unwrap()), ["natif"]);

        let lus = tous(&conn, "moi", None).unwrap();
        let lu = |id: &str| lus.iter().find(|s| s.id == id).unwrap().clone();
        assert_eq!(lu("natif").metadata, None);
        assert_eq!(lu("incoherent").metadata, None);
        let attendu = json!({"memory_type": "procedural_memory", "n": [1, 2]});
        assert_eq!(lu("importe").metadata.map(Value::Object), Some(attendu.clone()));
        let natif_null: bool =
            conn.query_row("SELECT metadata IS NULL FROM memories WHERE id = 'natif'", [], |r| r.get(0)).unwrap();
        assert!(natif_null, "ajouter écrit metadata NULL");

        // PUT sur le souvenir importé : metadata intacte, sparse recalculé, compté dans N.
        assert!(mettre_a_jour(&mut conn, "importe", "natif", "h2", &Tags::Inchangees, &[0.0, 1.0, 0.0], &instant(5)).unwrap());
        let apres = tous(&conn, "moi", None).unwrap().into_iter().find(|s| s.id == "importe").unwrap();
        assert_eq!(apres.metadata.map(Value::Object), Some(attendu));
        assert_eq!(statistiques_idf(&conn, &indices).unwrap().0, 2);
        assert_eq!(ids(porteurs(&conn, "moi", None, &indices).unwrap()), ["importe", "natif"]);
    }

    #[test]
    fn ac1_souvenir_infere_lu_et_historise() {
        let base = Temp::new();
        let mut conn = ouvrir(&base.0, DIMS).unwrap();
        ajouter_simple(&mut conn, "classique", Some("ag"), None, &[0.0, 0.0, 1.0]);
        let (i1, i2, im) = (instant(1), instant(2), instant(3));
        let f1 = fait("Fait un", Some(json!("user")), vec![1.0, 0.0, 0.0], i1.clone());
        let f2 = fait("Fait deux", Some(json!({"qui": [1, "x"], "n": 5})), vec![0.0, 1.0, 0.0], i2.clone());
        let f3 = fait("Fait trois", None, vec![1.0, 1.0, 0.0], i2.clone());
        let m = message("agent_id=ag&user_id=moi", "Texte de la requête", &im);
        ajouter_infere(&mut conn, "moi", Some("ag"), Some("course"), Some("t1,t2"), &[f1, f2, f3], &m).unwrap();

        let lus = tous(&conn, "moi", Some("ag")).unwrap();
        let lire = |memory: &str| lus.iter().find(|s| s.memory == memory).unwrap().clone();
        let (s1, s2, s3, classique) = (lire("Fait un"), lire("Fait deux"), lire("Fait trois"), lire("classique"));
        assert_eq!(lus.len(), 4);
        assert_eq!((s1.role.as_deref(), s1.attributed_to.clone()), (None, Some(json!("user"))));
        assert_eq!(s2.attributed_to, Some(json!({"qui": [1, "x"], "n": 5})));
        assert_eq!((s3.role.as_deref(), s3.attributed_to.clone()), (None, None));
        assert_eq!((classique.role.as_deref(), classique.attributed_to.clone()), (Some("user"), None));
        assert_eq!((s1.created_at.as_str(), s1.updated_at.as_str()), (i1.iso.as_str(), i1.iso.as_str()));
        assert_eq!((s1.agent_id.as_deref(), s1.run_id.as_deref()), (Some("ag"), Some("course")));
        assert_eq!(s1.tags, Some(Some("t1,t2".to_owned())));
        assert_eq!(s1.hash, "h-Fait un");
        // JSON compact en base.
        let brut: String =
            conn.query_row("SELECT attributed_to FROM memories WHERE id = ?1", [&s2.id], |r| r.get(0)).unwrap();
        assert_eq!(brut, r#"{"qui":[1,"x"],"n":5}"#);
        // Vecteur et termes écrits : le fait est trouvé par le cosinus et par BM25.
        let proches = voisins(&conn, "moi", Some("ag"), Some("course"), &[1.0, 0.0, 0.0], 1).unwrap();
        assert_eq!(proches[0].0.id, s1.id);
        let indices: Vec<u32> = bm25::encoder("trois").iter().map(|&(i, _)| i).collect();
        let porteurs = porteurs(&conn, "moi", Some("ag"), &indices).unwrap();
        assert_eq!(porteurs.iter().map(|(s, _)| s.id.as_str()).collect::<Vec<_>>(), [s3.id.as_str()]);

        // Révision ADD d'un fait extrait : updated_at et role NULL.
        let h = historique(&conn, &s1.id).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(
            (h[0].event.as_deref(), h[0].old_memory.as_deref(), h[0].new_memory.as_deref()),
            (Some("ADD"), None, Some("Fait un"))
        );
        assert_eq!((h[0].created_at.as_deref(), h[0].updated_at.as_deref()), (Some(i1.iso.as_str()), None));
        assert_eq!((h[0].is_deleted, h[0].actor_id.as_deref(), h[0].role.as_deref()), (false, None, None));
        // Révision ADD d'un add infer=false : inchangée.
        let h = historique(&conn, "classique").unwrap();
        assert_eq!((h[0].updated_at.as_deref(), h[0].role.as_deref()), (h[0].created_at.as_deref(), Some("user")));

        // Le message est sauvé dans la même transaction.
        assert_eq!(
            derniers_messages(&conn, "agent_id=ag&user_id=moi", 10).unwrap(),
            [("user".to_owned(), "Texte de la requête".to_owned())]
        );

        // PUT : role reste NULL, attributed_to conservé, révision UPDATE avec role NULL.
        let i4 = instant(4);
        assert!(mettre_a_jour(&mut conn, &s1.id, "Fait un révisé", "h2", &Tags::Inchangees, &[1.0, 0.0, 0.0], &i4).unwrap());
        let apres = tous(&conn, "moi", Some("ag")).unwrap().into_iter().find(|s| s.id == s1.id).unwrap();
        assert_eq!((apres.memory.as_str(), apres.role.as_deref()), ("Fait un révisé", None));
        assert_eq!(apres.attributed_to, Some(json!("user")));
        let h = historique(&conn, &s1.id).unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!((h[1].event.as_deref(), h[1].role.as_deref()), (Some("UPDATE"), None));
        assert_eq!((h[1].created_at.as_deref(), h[1].updated_at.as_deref()), (Some(i1.iso.as_str()), Some(i4.iso.as_str())));

        // DELETE : révision avec role NULL.
        assert!(supprimer(&mut conn, &s1.id, &instant(5)).unwrap());
        let h = historique(&conn, &s1.id).unwrap();
        assert_eq!((h[2].event.as_deref(), h[2].role.as_deref(), h[2].is_deleted), (Some("DELETE"), None, true));
    }

    #[test]
    fn ac5_ajouter_infere_atomique() {
        let base = Temp::new();
        let mut conn = ouvrir(&base.0, DIMS).unwrap();
        // Le second fait a une mauvaise dimension : sqlite-vec refuse l'insertion.
        let faits = [fait("Bon", None, vec![1.0, 0.0, 0.0], instant(1)), fait("Mauvais", None, vec![1.0, 0.0], instant(1))];
        let m = message("user_id=moi", "requête", &instant(2));
        assert!(ajouter_infere(&mut conn, "moi", None, None, None, &faits, &m).is_err());
        assert!(tous(&conn, "moi", None).unwrap().is_empty());
        assert!(historique(&conn, &faits[0].id).unwrap().is_empty());
        assert!(derniers_messages(&conn, "user_id=moi", 10).unwrap().is_empty());
        let vecteurs: i64 = conn.query_row("SELECT count(*) FROM memory_vec", [], |r| r.get(0)).unwrap();
        assert_eq!(vecteurs, 0);
    }

    #[test]
    fn ac5_messages_sauves_evinces_a_dix() {
        let base = Temp::new();
        let mut conn = ouvrir(&base.0, DIMS).unwrap();
        let long = "é".repeat(400);
        for s in 1..=12 {
            let content = if s == 12 { long.clone() } else { format!("m{s}") };
            sauver_message(&mut conn, &message("P", &content, &instant(s))).unwrap();
        }
        sauver_message(&mut conn, &message("Q", "autre scope", &instant(30))).unwrap();
        let nombre = |portee: &str| -> i64 {
            conn.query_row("SELECT count(*) FROM messages WHERE session_scope = ?1", [portee], |r| r.get(0)).unwrap()
        };
        assert_eq!((nombre("P"), nombre("Q")), (10, 1));
        let contenus = |n: usize| -> Vec<String> {
            derniers_messages(&conn, "P", n).unwrap().into_iter().map(|(role, c)| {
                assert_eq!(role, "user");
                c
            }).collect()
        };
        // Les 10 plus récents, du plus ancien au plus récent ; contenu complet en base.
        let mut attendu: Vec<String> = (3..=11).map(|s| format!("m{s}")).collect();
        attendu.push(long.clone());
        assert_eq!(contenus(10), attendu);
        assert_eq!(contenus(3), ["m10".to_owned(), "m11".to_owned(), long.clone()]);
        assert_eq!(derniers_messages(&conn, "Q", 10).unwrap(), [("user".to_owned(), "autre scope".to_owned())]);
        assert!(derniers_messages(&conn, "R", 10).unwrap().is_empty());

        // À created_at égal, le rowid départage (le plus grand est le plus récent).
        let egal = instant(50);
        for c in ["e1", "e2"] {
            sauver_message(&mut conn, &message("E", c, &egal)).unwrap();
        }
        assert_eq!(
            derniers_messages(&conn, "E", 1).unwrap(),
            [("user".to_owned(), "e2".to_owned())]
        );
        assert_eq!(
            derniers_messages(&conn, "E", 2).unwrap().into_iter().map(|(_, c)| c).collect::<Vec<_>>(),
            ["e1", "e2"]
        );

        // role ou content NULL : rendus "".
        conn.execute(
            "INSERT INTO messages (id, session_scope, role, content, name, created_at) VALUES ('n', 'N', NULL, NULL, NULL, ?1)",
            [&egal.iso],
        )
        .unwrap();
        assert_eq!(derniers_messages(&conn, "N", 10).unwrap(), [(String::new(), String::new())]);
    }

    #[test]
    fn ac3_voisins_top_n_par_portee() {
        let base = Temp::new();
        let mut conn = ouvrir(&base.0, DIMS).unwrap();
        ajouter_simple(&mut conn, "proche", Some("ag"), Some("r1"), &[1.0, 0.0, 0.0]);
        ajouter_simple(&mut conn, "b-moyen", Some("ag"), Some("r1"), &[1.0, 1.0, 0.0]);
        ajouter_simple(&mut conn, "a-moyen", Some("ag"), Some("r1"), &[1.0, 1.0, 0.0]);
        ajouter_simple(&mut conn, "loin", Some("ag"), Some("r1"), &[0.0, 1.0, 0.0]);
        ajouter_simple(&mut conn, "autre-course", Some("ag"), Some("r2"), &[1.0, 0.0, 0.0]);
        ajouter_simple(&mut conn, "autre-agent", Some("zz"), Some("r1"), &[1.0, 0.0, 0.0]);
        let ids = |agent: Option<&str>, run: Option<&str>, n: usize| -> Vec<String> {
            voisins(&conn, "moi", agent, run, &[2.0, 0.0, 0.0], n).unwrap().into_iter().map(|(s, _)| s.id).collect()
        };
        // Cosinus décroissant, à égalité id croissant, tronqué à n.
        assert_eq!(ids(Some("ag"), Some("r1"), 10), ["proche", "a-moyen", "b-moyen", "loin"]);
        assert_eq!(ids(Some("ag"), Some("r1"), 2), ["proche", "a-moyen"]);
        // run_id absent : toutes les courses de l'agent ; agent absent : tous les agents.
        assert_eq!(ids(Some("ag"), None, 2), ["autre-course", "proche"]);
        assert_eq!(ids(None, Some("r1"), 10), ["autre-agent", "proche", "a-moyen", "b-moyen", "loin"]);
        let scores: Vec<f64> =
            voisins(&conn, "moi", Some("ag"), Some("r1"), &[2.0, 0.0, 0.0], 10).unwrap().into_iter().map(|(_, c)| c).collect();
        assert!((scores[0] - 1.0).abs() < 1e-6 && (scores[1] - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-6);
        assert!(scores[3].abs() < 1e-6);
        assert!(voisins(&conn, "autre", None, None, &[1.0, 0.0, 0.0], 10).unwrap().is_empty());
    }
}
