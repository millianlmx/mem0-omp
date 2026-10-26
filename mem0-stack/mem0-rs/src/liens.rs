//! Graphe de liens de la mémoire (memoire-liee, schéma v4) : entités partagées,
//! voisins sémantiques stockés et liens typés entre souvenirs.
//!
//! - `entites` / `souvenir_entites` : les entités lexicales de chaque souvenir
//!   ([`crate::entites`]), clé normalisée unique dans la base ;
//! - `liens` : arêtes `(source, cible, type)`. `semantique` est calculé à
//!   l'écriture (les [`VOISINS_MAX`] voisins de cosinus ≥ [`SEUIL_SEMANTIQUE`]
//!   dans la même portée, paire rangée `source < cible`) ; les types de
//!   [`TYPES_AGENT`] sont posés par un agent (`POST /memory/link`) ou par le rêve ;
//!   `preuve` relie une observation aux faits qui la fondent ;
//! - `indexes` : le hash du texte indexé, pour réindexer ce qui a changé sans le
//!   chemin d'écriture (import, base migrée) ;
//! - `rappels` : combien de fois une recherche a rendu le souvenir, et quand.
//!
//! Toutes les écritures prennent une connexion déjà en transaction : elles
//! tiennent dans la transaction du souvenir lui-même.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;

use crate::entites;

/// Tables ajoutées par le schéma v4, créées à la création d'une base et par la
/// migration d'une base v3 (`CREATE … IF NOT EXISTS` : rejouable).
pub const SCHEMA_V4: &str = "
    CREATE TABLE IF NOT EXISTS entites (
        id INTEGER PRIMARY KEY,
        cle TEXT NOT NULL UNIQUE,
        forme TEXT NOT NULL,
        genre TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS souvenir_entites (
        memory_id TEXT NOT NULL,
        entite INTEGER NOT NULL,
        PRIMARY KEY (memory_id, entite)
    );
    CREATE INDEX IF NOT EXISTS souvenir_entites_entite ON souvenir_entites (entite);
    CREATE TABLE IF NOT EXISTS liens (
        source TEXT NOT NULL,
        cible TEXT NOT NULL,
        type TEXT NOT NULL,
        poids REAL NOT NULL,
        origine TEXT NOT NULL,
        raison TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source, cible, type)
    );
    CREATE INDEX IF NOT EXISTS liens_cible ON liens (cible);
    CREATE TABLE IF NOT EXISTS indexes (memory_id TEXT PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rappels (memory_id TEXT PRIMARY KEY, n INTEGER NOT NULL, dernier_us INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS paires_jugees (
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        hash_a TEXT NOT NULL,
        hash_b TEXT NOT NULL,
        verdict TEXT NOT NULL,
        PRIMARY KEY (a, b)
    );
    CREATE TABLE IF NOT EXISTS propositions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        genre TEXT NOT NULL,
        souvenirs TEXT NOT NULL,
        supprimer TEXT,
        raison TEXT,
        statut TEXT NOT NULL,
        reve TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS propositions_statut ON propositions (agent_id, statut);
    CREATE TABLE IF NOT EXISTS reves (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        genre TEXT NOT NULL,
        debut TEXT NOT NULL,
        debut_us INTEGER NOT NULL,
        fin TEXT NOT NULL,
        rapport TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reves_portee ON reves (agent_id, genre, debut_us);
    CREATE TABLE IF NOT EXISTS modeles (
        agent_id TEXT NOT NULL,
        nom TEXT NOT NULL,
        question TEXT NOT NULL,
        contenu TEXT NOT NULL,
        sources TEXT NOT NULL,
        precedent TEXT,
        maj_at TEXT NOT NULL,
        maj_us INTEGER NOT NULL,
        PRIMARY KEY (agent_id, nom)
    );
    CREATE TABLE IF NOT EXISTS consolidations (agent_id TEXT PRIMARY KEY, horizon_us INTEGER NOT NULL);
";

/// Cosinus à partir duquel deux souvenirs d'une même portée sont voisins (celui de
/// `GET /memory/graph`, [`crate::graphe::GRAPH_THRESHOLD`]).
pub const SEUIL_SEMANTIQUE: f64 = crate::graphe::GRAPH_THRESHOLD;
/// Voisins sémantiques gardés par souvenir à son écriture.
pub const VOISINS_MAX: usize = crate::graphe::GRAPH_TOP_K;

pub const SEMANTIQUE: &str = "semantique";
pub const PREUVE: &str = "preuve";
/// Les types qu'un agent pose : la cause d'un bug ou d'une décision, un souvenir
/// qui en remplace un autre, une contradiction, une précision, un renvoi.
pub const TYPES_AGENT: [&str; 5] = ["cause", "remplace", "contredit", "precise", "voir"];

/// Un lien stocké.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Lien {
    pub source: String,
    pub target: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub weight: f64,
    pub origin: String,
    pub reason: Option<String>,
    pub created_at: String,
}

/// Portée d'un souvenir : `agent_id` NULL compte comme la chaîne vide dans les
/// tables du schéma v4.
pub fn cle_portee(agent_id: Option<&str>) -> &str {
    agent_id.unwrap_or("")
}

/// Le souvenir indexé : rowid, texte, hash, user_id, agent_id.
type Ligne = (i64, String, String, String, Option<String>);

fn lire_souvenir(conn: &Connection, id: &str) -> rusqlite::Result<Option<Ligne>> {
    conn.query_row(
        "SELECT rowid, memory, hash, user_id, agent_id FROM memories WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )
    .optional()
}

/// (rowid, id, vecteur) des souvenirs d'une portée.
type Vecteurs = Vec<(i64, String, Vec<f32>)>;

/// Les vecteurs (normalisés L2, float32) des souvenirs de la portée
/// `user_id`/`agent_id` : (rowid, id, vecteur), dans l'ordre des rowid.
///
/// Un SEUL parcours de `memory_vec`, filtré en mémoire par les rowid de la portée :
/// lire `memory_vec` par rowid (une jointure, ou une sous-requête `WHERE rowid = ?`)
/// la parcourt à chaque lecture, et l'indexation devenait cubique — mesuré : 0.3 s
/// pour migrer 200 souvenirs, 459 s pour 1 000.
fn vecteurs_portee(conn: &Connection, user_id: &str, agent_id: Option<&str>) -> rusqlite::Result<Vecteurs> {
    let ids: HashMap<i64, String> = conn
        .prepare_cached("SELECT rowid, id FROM memories WHERE user_id = ?1 AND agent_id IS ?2")?
        .query_map(params![user_id, agent_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut vecteurs = Vec::with_capacity(ids.len());
    let mut st = conn.prepare_cached("SELECT rowid, embedding FROM memory_vec")?;
    let mut lignes = st.query([])?;
    while let Some(r) = lignes.next()? {
        let rowid: i64 = r.get(0)?;
        let Some(id) = ids.get(&rowid) else { continue };
        let blob: Vec<u8> = r.get(1)?;
        let vecteur = blob.as_chunks::<4>().0.iter().map(|o| f32::from_le_bytes(*o)).collect();
        vecteurs.push((rowid, id.clone(), vecteur));
    }
    vecteurs.sort_by_key(|(rowid, _, _)| *rowid);
    Ok(vecteurs)
}

/// Produit scalaire de deux vecteurs normalisés (le cosinus de Qdrant et de
/// `vec_distance_cosine`), accumulé en float64 ; 0 si les dimensions diffèrent.
fn cosinus(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let c: f64 = a.iter().zip(b).map(|(x, y)| f64::from(*x) * f64::from(*y)).sum();
    if c.is_finite() { c } else { 0.0 }
}

/// Recalcule les entités et les voisins sémantiques du souvenir `id`, puis note
/// son hash dans `indexes`. Les liens typés et les preuves ne bougent pas.
/// Rien si le souvenir n'existe pas.
pub fn indexer(conn: &Connection, id: &str, instant_iso: &str) -> rusqlite::Result<()> {
    indexer_lot(conn, &[id], instant_iso)
}

/// Voisins candidats que la recherche KNN de sqlite-vec rend pour UNE écriture,
/// toutes portées confondues (le filtre de portée vient après) : large, pour qu'une
/// autre portée ne masque pas les voisins de celle du souvenir.
const VOISINS_KNN: usize = 512;

/// Lot à partir duquel [`indexer_lot`] lit une fois tous les vecteurs de la
/// portée plutôt que de lancer une recherche KNN par souvenir.
const LOT_PARCOURS: usize = 16;

/// Les voisins de cosinus ≥ [`SEUIL_SEMANTIQUE`] du souvenir `rowid` dans sa portée,
/// par la recherche KNN de `vec0` (mesuré : 10 ms pour 3 000 souvenirs, contre
/// 0,4 ms PAR LIGNE pour une lecture par rowid).
fn voisins_knn(
    conn: &Connection,
    rowid: i64,
    user_id: &str,
    agent_id: Option<&str>,
) -> rusqlite::Result<Vec<(String, f64)>> {
    let moi: Option<Vec<u8>> =
        conn.query_row("SELECT embedding FROM memory_vec WHERE rowid = ?1", [rowid], |r| r.get(0)).optional()?;
    let Some(moi) = moi else {
        return Ok(Vec::new());
    };
    let candidats: Vec<(i64, f64)> = conn
        .prepare_cached("SELECT rowid, distance FROM memory_vec WHERE embedding MATCH ?1 AND k = ?2")?
        .query_map(params![moi, VOISINS_KNN as i64], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut dans_portee =
        conn.prepare_cached("SELECT id FROM memories WHERE rowid = ?1 AND user_id = ?2 AND agent_id IS ?3")?;
    let mut voisins = Vec::new();
    for (autre, distance) in candidats {
        let cos = 1.0 - distance;
        if autre == rowid || !cos.is_finite() || cos < SEUIL_SEMANTIQUE {
            continue;
        }
        if let Some(id) = dans_portee.query_row(params![autre, user_id, agent_id], |r| r.get(0)).optional()? {
            voisins.push((id, cos));
        }
    }
    Ok(voisins)
}

/// [`indexer`] pour plusieurs souvenirs (migration, import, rêve). À partir de
/// [`LOT_PARCOURS`] souvenirs, les vecteurs d'une portée sont lus une fois pour tout
/// le lot ; en deçà, chaque souvenir passe par la recherche KNN. Un id inconnu est
/// ignoré.
pub fn indexer_lot(conn: &Connection, ids: &[&str], instant_iso: &str) -> rusqlite::Result<()> {
    let parcours = ids.len() >= LOT_PARCOURS;
    let mut portees: HashMap<(String, Option<String>), Vecteurs> = HashMap::new();
    for &id in ids {
        let Some((rowid, texte, hash, user_id, agent_id)) = lire_souvenir(conn, id)? else {
            continue;
        };
        conn.execute("DELETE FROM souvenir_entites WHERE memory_id = ?1", [id])?;
        for e in entites::extraire(&texte) {
            conn.execute(
                "INSERT INTO entites (cle, forme, genre) VALUES (?1, ?2, ?3) ON CONFLICT (cle) DO NOTHING",
                params![e.cle, e.forme, e.genre.nom()],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO souvenir_entites (memory_id, entite) SELECT ?1, id FROM entites WHERE cle = ?2",
                params![id, e.cle],
            )?;
        }
        conn.execute("DELETE FROM liens WHERE type = ?1 AND (source = ?2 OR cible = ?2)", params![SEMANTIQUE, id])?;
        let mut voisins: Vec<(String, f64)> = if parcours {
            let cle = (user_id, agent_id);
            if !portees.contains_key(&cle) {
                let vecteurs = vecteurs_portee(conn, &cle.0, cle.1.as_deref())?;
                portees.insert(cle.clone(), vecteurs);
            }
            let portee = &portees[&cle];
            match portee.iter().find(|(r, _, _)| *r == rowid) {
                Some((_, _, moi)) => portee
                    .iter()
                    .filter(|(r, _, _)| *r != rowid)
                    .map(|(_, autre, v)| (autre.clone(), cosinus(moi, v)))
                    .filter(|(_, c)| *c >= SEUIL_SEMANTIQUE)
                    .collect(),
                None => Vec::new(),
            }
        } else {
            voisins_knn(conn, rowid, &user_id, agent_id.as_deref())?
        };
        voisins.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        voisins.truncate(VOISINS_MAX);
        for (autre, cos) in voisins {
            let autre = autre.as_str();
            let (a, b) = if id < autre { (id, autre) } else { (autre, id) };
            conn.execute(
                "INSERT OR REPLACE INTO liens (source, cible, type, poids, origine, raison, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'calcul', NULL, ?5)",
                params![a, b, SEMANTIQUE, cos, instant_iso],
            )?;
        }
        conn.execute("INSERT OR REPLACE INTO indexes (memory_id, hash) VALUES (?1, ?2)", params![id, hash])?;
    }
    Ok(())
}

/// Ce qu'un souvenir supprimé laisse derrière lui : ses entités, ses liens dans
/// les deux sens, son index, ses rappels et ses paires jugées ; les propositions
/// qui le citent deviennent `caduque` ; une observation qui le citait comme preuve
/// voit son compte de preuves (`metadata.preuves`) recalculé.
pub fn desindexer(conn: &Connection, id: &str, instant_iso: &str) -> rusqlite::Result<()> {
    let observations: Vec<String> = conn
        .prepare_cached("SELECT source FROM liens WHERE type = ?1 AND cible = ?2")?
        .query_map(params![PREUVE, id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    conn.execute("DELETE FROM souvenir_entites WHERE memory_id = ?1", [id])?;
    conn.execute("DELETE FROM liens WHERE source = ?1 OR cible = ?1", [id])?;
    conn.execute("DELETE FROM indexes WHERE memory_id = ?1", [id])?;
    conn.execute("DELETE FROM rappels WHERE memory_id = ?1", [id])?;
    conn.execute("DELETE FROM paires_jugees WHERE a = ?1 OR b = ?1", [id])?;
    conn.execute(
        "UPDATE propositions SET statut = 'caduque', decided_at = ?2
         WHERE statut = 'ouverte' AND EXISTS (SELECT 1 FROM json_each(propositions.souvenirs) WHERE value = ?1)",
        params![id, instant_iso],
    )?;
    for observation in observations {
        compter_preuves(conn, &observation)?;
    }
    Ok(())
}

/// Écrit dans `metadata.preuves` de l'observation `id` son nombre de liens `preuve`.
pub fn compter_preuves(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    let n: i64 =
        conn.query_row("SELECT count(*) FROM liens WHERE type = ?1 AND source = ?2", params![PREUVE, id], |r| r.get(0))?;
    conn.execute(
        "UPDATE memories SET metadata = json_set(COALESCE(metadata, '{}'), '$.preuves', ?2) WHERE id = ?1",
        params![id, n],
    )?;
    Ok(usize::try_from(n).unwrap_or(0))
}

/// Les souvenirs dont l'index manque ou ne correspond plus à leur texte (import,
/// base migrée, écriture interrompue), au plus `n`, de la portée donnée
/// (`None` : toutes).
pub fn a_reindexer(conn: &Connection, portee: Option<&str>, n: usize) -> rusqlite::Result<Vec<String>> {
    conn.prepare_cached(
        "SELECT m.id FROM memories m LEFT JOIN indexes i ON i.memory_id = m.id
         WHERE (i.memory_id IS NULL OR i.hash != m.hash) AND (?1 IS NULL OR COALESCE(m.agent_id, '') = ?1)
         ORDER BY m.updated_at_us, m.id LIMIT ?2",
    )?
    .query_map(params![portee, i64::try_from(n).unwrap_or(i64::MAX)], |r| r.get(0))?
    .collect()
}

/// Pose (ou remplace) un lien.
pub fn lier(conn: &Connection, lien: &Lien) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO liens (source, cible, type, poids, origine, raison, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![lien.source, lien.target, lien.type_, lien.weight, lien.origin, lien.reason, lien.created_at],
    )?;
    Ok(())
}

/// Retire un lien ; `false` s'il n'existait pas.
pub fn delier(conn: &Connection, source: &str, cible: &str, type_: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM liens WHERE source = ?1 AND cible = ?2 AND type = ?3", params![source, cible, type_])? > 0)
}

fn lien(r: &rusqlite::Row<'_>) -> rusqlite::Result<Lien> {
    Ok(Lien {
        source: r.get(0)?,
        target: r.get(1)?,
        type_: r.get(2)?,
        weight: r.get(3)?,
        origin: r.get(4)?,
        reason: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const COLONNES_LIEN: &str = "l.source, l.cible, l.type, l.poids, l.origine, l.raison, l.created_at";

/// Les liens qui touchent un des `ids` (dans un sens ou dans l'autre), dans
/// l'ordre (type, source, cible).
pub fn liens_touchant(conn: &Connection, ids: &[&str]) -> rusqlite::Result<Vec<Lien>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let marques = vec!["?"; ids.len()].join(", ");
    let sql = format!(
        "SELECT {COLONNES_LIEN} FROM liens l WHERE l.source IN ({marques}) OR l.cible IN ({marques})
         ORDER BY l.type, l.source, l.cible"
    );
    conn.prepare(&sql)?.query_map(params_from_iter(ids.iter().chain(ids.iter())), lien)?.collect()
}

/// Les liens dont les deux bouts sont dans la portée `user_id`/`agent_id`
/// (`agent_id` `None` : toute la base de `user_id`), avec ou sans les liens
/// `semantique`.
pub fn liens_portee(
    conn: &Connection,
    user_id: &str,
    agent_id: Option<&str>,
    semantiques: bool,
) -> rusqlite::Result<Vec<Lien>> {
    conn.prepare_cached(&format!(
        "SELECT {COLONNES_LIEN} FROM liens l
         JOIN memories s ON s.id = l.source JOIN memories c ON c.id = l.cible
         WHERE s.user_id = ?1 AND (?2 IS NULL OR s.agent_id = ?2) AND c.user_id = ?1 AND (?2 IS NULL OR c.agent_id = ?2)
           AND (?3 OR l.type != 'semantique')
         ORDER BY l.type, l.source, l.cible"
    ))?
    .query_map(params![user_id, agent_id, semantiques], lien)?
    .collect()
}

/// Une entité et le nombre de souvenirs de la portée qui la portent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EntiteComptee {
    pub key: String,
    pub form: String,
    pub kind: String,
    pub memories: usize,
}

/// Les entités de la portée, de la plus portée à la moins portée, puis par clé.
pub fn entites_portee(conn: &Connection, user_id: &str, agent_id: Option<&str>) -> rusqlite::Result<Vec<EntiteComptee>> {
    conn.prepare_cached(
        "SELECT e.cle, e.forme, e.genre, count(*) AS n FROM entites e
         JOIN souvenir_entites se ON se.entite = e.id JOIN memories m ON m.id = se.memory_id
         WHERE m.user_id = ?1 AND (?2 IS NULL OR m.agent_id = ?2)
         GROUP BY e.id ORDER BY n DESC, e.cle",
    )?
    .query_map(params![user_id, agent_id], |r| {
        Ok(EntiteComptee {
            key: r.get(0)?,
            form: r.get(1)?,
            kind: r.get(2)?,
            memories: usize::try_from(r.get::<_, i64>(3)?).unwrap_or(0),
        })
    })?
    .collect()
}

/// Les clés d'entités de chacun des `ids`.
pub fn entites_de(conn: &Connection, ids: &[&str]) -> rusqlite::Result<HashMap<String, Vec<String>>> {
    let mut par_id: HashMap<String, Vec<String>> = HashMap::new();
    let mut st = conn.prepare_cached(
        "SELECT e.cle FROM souvenir_entites se JOIN entites e ON e.id = se.entite WHERE se.memory_id = ?1 ORDER BY e.cle",
    )?;
    for id in ids {
        let cles: Vec<String> = st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        par_id.insert((*id).to_owned(), cles);
    }
    Ok(par_id)
}

/// Pour chaque clé d'entité donnée, les souvenirs de la portée qui la portent.
pub fn porteurs_entites(
    conn: &Connection,
    user_id: &str,
    agent_id: Option<&str>,
    cles: &HashSet<String>,
) -> rusqlite::Result<HashMap<String, Vec<String>>> {
    let mut st = conn.prepare_cached(
        "SELECT se.memory_id FROM entites e JOIN souvenir_entites se ON se.entite = e.id
         JOIN memories m ON m.id = se.memory_id
         WHERE e.cle = ?1 AND m.user_id = ?2 AND (?3 IS NULL OR m.agent_id = ?3)
         ORDER BY se.memory_id",
    )?;
    let mut porteurs = HashMap::with_capacity(cles.len());
    for cle in cles {
        let ids: Vec<String> = st.query_map(params![cle, user_id, agent_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        porteurs.insert(cle.clone(), ids);
    }
    Ok(porteurs)
}

/// Un lien vu depuis un souvenir : l'autre bout, le type, le sens (`out` : le
/// souvenir est la source), le poids, l'origine et la raison.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LienVu {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub direction: &'static str,
    pub weight: f64,
    pub origin: String,
    pub reason: Option<String>,
}

/// Les liens typés (tout sauf `semantique`) de chacun des `ids`, vus depuis lui.
pub fn liens_vus(conn: &Connection, ids: &[&str]) -> rusqlite::Result<HashMap<String, Vec<LienVu>>> {
    let mut vus: HashMap<String, Vec<LienVu>> = ids.iter().map(|id| ((*id).to_owned(), Vec::new())).collect();
    for l in liens_touchant(conn, ids)?.into_iter().filter(|l| l.type_ != SEMANTIQUE) {
        for (moi, autre, direction) in [(&l.source, &l.target, "out"), (&l.target, &l.source, "in")] {
            if let Some(liste) = vus.get_mut(moi.as_str()) {
                liste.push(LienVu {
                    id: autre.clone(),
                    type_: l.type_.clone(),
                    direction,
                    weight: l.weight,
                    origin: l.origin.clone(),
                    reason: l.reason.clone(),
                });
            }
        }
    }
    Ok(vus)
}

/// Une recherche a rendu ces souvenirs : un rappel de plus pour chacun.
pub fn noter_rappels(conn: &Connection, ids: &[&str], instant_us: i64) -> rusqlite::Result<()> {
    let mut st = conn.prepare_cached(
        "INSERT INTO rappels (memory_id, n, dernier_us) VALUES (?1, 1, ?2)
         ON CONFLICT (memory_id) DO UPDATE SET n = n + 1, dernier_us = excluded.dernier_us",
    )?;
    for id in ids {
        st.execute(params![id, instant_us])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types_agent_sans_les_types_calcules() {
        assert!(!TYPES_AGENT.contains(&SEMANTIQUE));
        assert!(!TYPES_AGENT.contains(&PREUVE));
        assert_eq!(cle_portee(None), "");
        assert_eq!(cle_portee(Some("p")), "p");
    }
}
