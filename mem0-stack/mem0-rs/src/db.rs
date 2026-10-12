//! Stockage SQLite unique (S-1, modèle de données de BR-1) : souvenirs, vecteurs
//! denses (sqlite-vec), termes BM25 (FTS5) et historique dans un seul fichier.
//!
//! Chaque écriture tient dans UNE transaction `IMMEDIATE` ; l'embedding est
//! calculé par l'appelant avant, hors verrou.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Once;

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use serde::Serialize;

use crate::bm25::{self, VecteurCreux};
use crate::horodatage::Instant;

pub const SCHEMA_VERSION: &str = "1";

/// Échec d'ouverture de la base (code 1 au démarrage).
#[derive(Debug)]
pub enum ErreurOuverture {
    /// La base a été créée avec une autre dimension.
    Dims { stockee: String, demandee: usize },
    /// Base illisible ou étrangère : la raison.
    Autre(String),
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
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .and_then(|mut st| st.query_map([], |r| r.get(0))?.collect())
        .map_err(|e| autre(&e))?;
    if tables.iter().any(|t| t == "meta") {
        let lire = |cle: &str| -> Result<Option<String>, ErreurOuverture> {
            conn.query_row("SELECT valeur FROM meta WHERE cle = ?1", [cle], |r| r.get(0))
                .optional()
                .map_err(|e| autre(&e))
        };
        let version = lire("schema_version")?;
        if version.as_deref() != Some(SCHEMA_VERSION) {
            return Err(ErreurOuverture::Autre(format!(
                "schema_version {} inconnue (attendue {SCHEMA_VERSION})",
                version.as_deref().unwrap_or("absente")
            )));
        }
        let stockee = lire("embedding_dims")?.unwrap_or_default();
        if stockee != dims.to_string() {
            return Err(ErreurOuverture::Dims { stockee, demandee: dims });
        }
        pragmas(&conn).map_err(ErreurOuverture::Autre)?;
    } else if !tables.is_empty() {
        return Err(ErreurOuverture::Autre(
            "ce n'est pas une base mem0-rs (table meta absente)".to_owned(),
        ));
    } else {
        pragmas(&conn).map_err(ErreurOuverture::Autre)?;
        creer_schema(&mut conn, dims).map_err(|e| autre(&e))?;
    }
    Ok(conn)
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
             role TEXT NOT NULL,
             tags_present INTEGER NOT NULL,
             tags TEXT,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             updated_at_us INTEGER NOT NULL,
             sparse TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS memories_portee ON memories (user_id, agent_id);
         CREATE INDEX IF NOT EXISTS memories_recence ON memories (updated_at_us DESC, id);
         CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[{dims}] distance_metric=cosine);
         CREATE VIRTUAL TABLE IF NOT EXISTS memory_terms USING fts5(terms, tokenize='ascii');
         CREATE VIRTUAL TABLE IF NOT EXISTS memory_terms_vocab USING fts5vocab(memory_terms, 'row');
         CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, memory_id TEXT, old_memory TEXT, new_memory TEXT, event TEXT, created_at DATETIME, updated_at DATETIME, is_deleted INTEGER, actor_id TEXT, role TEXT);"
    ))?;
    tx.execute(
        "INSERT INTO meta (cle, valeur) VALUES ('schema_version', ?1), ('embedding_dims', ?2)",
        params![SCHEMA_VERSION, dims.to_string()],
    )?;
    tx.commit()
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
fn termes(texte: &str) -> rusqlite::Result<(String, String)> {
    let creux = bm25::encoder(texte);
    let json = serde_json::to_string(&creux).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    Ok((json, jetons_fts(creux.iter().map(|&(i, _)| i), " ")))
}

/// Les indices en jetons FTS5 `t<indice>`, joints par `separateur`.
fn jetons_fts(indices: impl Iterator<Item = u32>, separateur: &str) -> String {
    indices.map(|i| format!("t{i}")).collect::<Vec<_>>().join(separateur)
}

/// Souvenir à créer (add infer=false, add_procedure).
pub struct NouveauSouvenir<'a> {
    pub id: &'a str,
    pub memory: &'a str,
    pub hash: &'a str,
    pub user_id: &'a str,
    pub agent_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub role: &'a str,
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
    updated_at: &'a str,
    is_deleted: bool,
    role: &'a str,
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

/// Écrit souvenir, vecteur, termes et révision ADD dans une transaction.
pub fn ajouter(conn: &mut Connection, s: &NouveauSouvenir<'_>, vecteur: &[f32]) -> rusqlite::Result<()> {
    let (sparse, terms) = termes(s.memory)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO memories (id, memory, hash, user_id, agent_id, run_id, role, tags_present, tags, created_at, updated_at, updated_at_us, sparse)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?12)",
        params![
            s.id,
            s.memory,
            s.hash,
            s.user_id,
            s.agent_id,
            s.run_id,
            s.role,
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
    historiser(
        &tx,
        &Revision {
            memory_id: s.id,
            old_memory: None,
            new_memory: Some(s.memory),
            event: "ADD",
            created_at: &s.instant.iso,
            updated_at: &s.instant.iso,
            is_deleted: false,
            role: s.role,
        },
    )?;
    tx.commit()
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
    let (sparse, terms) = termes(texte)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let actuel: Option<(i64, String, String, String)> = tx
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
        &tx,
        &Revision {
            memory_id: id,
            old_memory: Some(&ancien),
            new_memory: Some(texte),
            event: "UPDATE",
            created_at: &created_at,
            updated_at: &instant.iso,
            is_deleted: false,
            role: &role,
        },
    )?;
    tx.commit()?;
    Ok(true)
}

/// Supprime le souvenir `id` (souvenir, vecteur, termes) ; `false` s'il n'existe pas.
pub fn supprimer(conn: &mut Connection, id: &str, instant: &Instant) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let actuel: Option<(i64, String, String, String)> = tx
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
        &tx,
        &Revision {
            memory_id: id,
            old_memory: Some(&texte),
            new_memory: None,
            event: "DELETE",
            created_at: &created_at,
            updated_at: &instant.iso,
            is_deleted: true,
            role: &role,
        },
    )?;
    tx.commit()?;
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
    pub role: String,
}

/// Colonnes d'un [`Souvenir`] (alias `m` pour `memories`), lues par [`souvenir`].
const COLONNES: &str =
    "m.id, m.memory, m.hash, m.tags_present, m.tags, m.created_at, m.updated_at, m.user_id, m.agent_id, m.run_id, m.role";
/// Nombre de colonnes de [`COLONNES`] : l'indice de la première colonne suivante.
const NB_COLONNES: usize = 11;

fn souvenir(r: &Row<'_>) -> rusqlite::Result<Souvenir> {
    let present: i64 = r.get(3)?;
    let tags: Option<String> = r.get(4)?;
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
    let mut st = conn.prepare_cached(&format!(
        "SELECT {COLONNES}, 1.0 - vec_distance_cosine(v.embedding, ?3)
         FROM memories m JOIN memory_vec v ON v.rowid = m.rowid
         WHERE m.user_id = ?1 AND (?2 IS NULL OR m.agent_id = ?2)"
    ))?;
    st.query_map(params![user_id, agent_id, blob_normalise(requete)], |r| {
        let cos: Option<f64> = r.get(NB_COLONNES)?;
        Ok((souvenir(r)?, cos.filter(|c| c.is_finite()).unwrap_or(0.0)))
    })?
    .collect()
}

/// Statistiques de l'IDF (D-5) sur TOUTE la base : N = nombre de souvenirs, et
/// pour chaque indice, le nombre de souvenirs dont le vecteur creux le porte
/// (`fts5vocab`, colonne `doc`).
pub fn statistiques_idf(conn: &Connection, indices: &[u32]) -> rusqlite::Result<(u64, HashMap<u32, u64>)> {
    let total: i64 = conn.query_row("SELECT count(*) FROM memories", [], |r| r.get(0))?;
    let mut st = conn.prepare_cached("SELECT doc FROM memory_terms_vocab WHERE term = ?1")?;
    let mut documents = HashMap::with_capacity(indices.len());
    for &i in indices {
        let n: Option<i64> = st.query_row([format!("t{i}")], |r| r.get(0)).optional()?;
        documents.insert(i, n.unwrap_or(0).unsigned_abs());
    }
    Ok((total.unsigned_abs(), documents))
}

/// Les souvenirs du scope qui portent au moins un des `indices` (FTS5), avec
/// leur vecteur creux (S-5, étape 5).
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
         WHERE memory_terms MATCH ?3 AND m.user_id = ?1 AND (?2 IS NULL OR m.agent_id = ?2)"
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
