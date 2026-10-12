//! Sous-commande `mem0-rs import` (S-1 à S-10 de mem0-rs-migration) : lit une
//! collection Qdrant (scroll REST, vecteurs compris) et le history.db de mem0,
//! puis écrit la base mem0-rs en UNE transaction, sans aucun appel à l'embedder.
//!
//! Ordre (S-7) : arguments, environnement, contrôle du verrou sans création,
//! lecture complète de la source, validation, puis écriture (ou simulation) et
//! rapport. Rien n'est créé ni modifié côté cible avant la fin de la validation ;
//! aucun gestionnaire de signal n'est installé : SIGINT/SIGTERM tuent le processus.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::bm25::VecteurCreux;
use crate::config::{self, ArgumentsImport};
use crate::db::{self, Connaissances, Ecritures, MessageImporte, RevisionImportee, SouvenirImporte};
use crate::horodatage::micros_depuis_iso;
use crate::verrou;

/// Taille d'une page de scroll Qdrant (S-2).
const TAILLE_PAGE: u32 = 256;

/// Colonnes lues dans `history` et `messages` (DOC-5), dans l'ordre des requêtes.
const COLONNES_HISTORIQUE: [&str; 10] =
    ["id", "memory_id", "old_memory", "new_memory", "event", "created_at", "updated_at", "is_deleted", "actor_id", "role"];
const COLONNES_MESSAGES: [&str; 6] = ["id", "session_scope", "role", "content", "name", "created_at"];

/// Clés du payload qui ne vont pas dans `metadata` (S-5, DOC-5).
const HORS_METADATA: [&str; 12] = [
    "data",
    "hash",
    "created_at",
    "updated_at",
    "id",
    "text_lemmatized",
    "user_id",
    "agent_id",
    "run_id",
    "role",
    "attributed_to",
    "tags",
];

/// `mem0-rs import …` : codes 0 (succès sans rejet), 1 (erreur, rien écrit),
/// 2 (usage), 3 (mené à terme avec au moins un rejet) — D-5.
pub async fn executer(args: impl IntoIterator<Item = OsString>) -> ExitCode {
    let Ok(arguments) = config::lire_arguments_import(args) else {
        eprintln!("{}", config::USAGE);
        return ExitCode::from(2);
    };
    let cfg = match config::lire_env(|nom| std::env::var(nom).ok()) {
        Ok(c) => c,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(1);
        }
    };
    let cle = std::env::var("QDRANT_API_KEY").unwrap_or_default();
    let rapport = match mener(&arguments, &cfg.db_path, cfg.embedding_dims, &cle).await {
        Ok(r) => r,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(1);
        }
    };
    let sortie = if arguments.json { rapport.json() } else { rapport.texte() };
    let mut stdout = std::io::stdout().lock();
    if let Err(e) = stdout.write_all(sortie.as_bytes()).and_then(|()| stdout.flush()) {
        eprintln!("rapport impossible à écrire : {e}");
        return ExitCode::from(1);
    }
    if arguments.dry_run {
        eprintln!("simulation : rien n'a été écrit dans {}", cfg.db_path.display());
    }
    ExitCode::from(if rapport.totaux.rejetes > 0 { 3 } else { 0 })
}

/// Étapes 2 à 5 de S-7 ; `Err(message)` = code 1.
async fn mener(a: &ArgumentsImport, base: &Path, dims: usize, cle: &str) -> Result<Rapport, String> {
    let chemin = base.display().to_string();
    let lock = verrou::chemin(base).display().to_string();
    let servie = || {
        format!("la base {chemin} est servie par un mem0-rs en cours d'exécution (verrou {lock}) : arrête-le avant d'importer")
    };
    let verrou_impossible = |e: &dyn std::fmt::Display| format!("MEM0_DB_PATH={chemin} : verrou {lock} impossible : {e}");
    if verrou::tenu_par_autrui(base).map_err(|e| verrou_impossible(&e))? {
        return Err(servie());
    }
    let points = lire_qdrant(&a.qdrant_url, &a.collection, cle).await?;
    let (lignes, messages) = lire_history(&a.history_db)?;
    let source = valider(points, lignes, messages, dims);
    if a.dry_run {
        let connaissances = connaissances_simulation(base, dims)?;
        return Ok(planifier(&source, &connaissances).rapport);
    }
    let _verrou = verrou::prendre(base).map_err(|e| match e {
        verrou::ErreurVerrou::Tenu => servie(),
        verrou::ErreurVerrou::Io(e) => verrou_impossible(&e),
    })?;
    let mut conn = db::ouvrir(base, dims).map_err(|e| e.message(&chemin))?;
    let plan = db::importer(&mut conn, |c| planifier(&source, c))
        .map_err(|e| format!("écriture de la base impossible : {e}"))?;
    Ok(plan.rapport)
}

/// Connaissances de la cible en `--dry-run` (S-8), sans rien créer.
fn connaissances_simulation(base: &Path, dims: usize) -> Result<Connaissances, String> {
    let chemin = base.display();
    if !base.try_exists().map_err(|e| format!("MEM0_DB_PATH={chemin} : {e}"))? {
        return Ok(Connaissances::default());
    }
    let mut wal = base.as_os_str().to_owned();
    wal.push("-wal");
    if std::fs::metadata(&wal).is_ok_and(|m| m.len() > 0) {
        return Err(format!(
            "MEM0_DB_PATH={chemin} : journal WAL non intégré ({chemin}-wal) — démarre puis arrête mem0-rs pour l'intégrer"
        ));
    }
    match db::ouvrir_simulation(base, dims).map_err(|e| e.message(&chemin.to_string()))? {
        None => Ok(Connaissances::default()),
        Some(conn) => db::connaissances(&conn).map_err(|e| format!("MEM0_DB_PATH={chemin} : {e}")),
    }
}

// ---------------------------------------------------------------------------
// Lecture de la source (S-2, S-3)
// ---------------------------------------------------------------------------

/// Un point Qdrant tel que lu, ses vecteurs déjà décodés.
#[derive(Debug)]
struct PointSource {
    id: Value,
    /// Payload ; vide s'il est absent ou n'est pas un objet.
    payload: Map<String, Value>,
    /// `None` : aucun vecteur dense utilisable.
    dense: Option<Vec<f32>>,
    /// `None` : pas de clé `bm25` ; `Some(None)` : clé présente mais mal formée.
    creux: Option<Option<VecteurCreux>>,
}

/// Une ligne de `history` ou de `messages`, colonnes brutes dans l'ordre de
/// [`COLONNES_HISTORIQUE`] / [`COLONNES_MESSAGES`].
#[derive(Debug)]
struct LigneSource<const N: usize> {
    rowid: i64,
    colonnes: [Sql; N],
}

/// Scroll complet de la collection (S-2) ; seule route appelée.
async fn lire_qdrant(url: &str, collection: &str, cle: &str) -> Result<Vec<PointSource>, String> {
    let injoignable = |e: &dyn std::error::Error| format!("Qdrant injoignable ({url}) : {}", chaine_erreur(e));
    let invalide = |detail: &str| format!("réponse Qdrant invalide ({detail})");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| injoignable(&e))?;
    let route = format!("{url}/collections/{collection}/points/scroll");
    let mut points = Vec::new();
    let mut offset: Option<Value> = None;
    loop {
        let mut corps = json!({"limit": TAILLE_PAGE, "with_payload": true, "with_vector": true});
        if let Some(o) = &offset {
            corps["offset"] = o.clone();
        }
        let mut requete = client.post(&route).json(&corps);
        if !cle.is_empty() {
            requete = requete.header("api-key", cle);
        }
        let reponse = requete.send().await.map_err(|e| injoignable(&e))?;
        match reponse.status().as_u16() {
            200 => {}
            code @ (401 | 403) => return Err(format!("Qdrant refuse la clé API (HTTP {code})")),
            404 => return Err(format!("collection {collection} introuvable sur {url}")),
            code => return Err(invalide(&format!("HTTP {code}"))),
        }
        let octets = reponse.bytes().await.map_err(|e| injoignable(&e))?;
        let mut page: Value =
            serde_json::from_slice(&octets).map_err(|e| invalide(&format!("corps non JSON : {e}")))?;
        let Some(Value::Array(lus)) = page.pointer_mut("/result/points").map(Value::take) else {
            return Err(invalide("result.points n'est pas un tableau"));
        };
        points.extend(lus.into_iter().map(point_source));
        match page.pointer("/result/next_page_offset").filter(|v| !v.is_null()) {
            None => return Ok(points),
            Some(suivant) if offset.as_ref() == Some(suivant) => {
                return Err(invalide(&format!("pagination bloquée sur {suivant}")));
            }
            Some(suivant) => offset = Some(suivant.clone()),
        }
    }
}

/// L'erreur et ses causes, jointes par ` : `.
fn chaine_erreur(e: &dyn std::error::Error) -> String {
    let mut texte = e.to_string();
    let mut cause = e.source();
    while let Some(c) = cause {
        texte.push_str(" : ");
        texte.push_str(&c.to_string());
        cause = c.source();
    }
    texte
}

/// Décode un `Record` : tableau = dense seul ; objet = dense sous `""`, creux
/// sous `"bm25"` (DOC-1).
fn point_source(record: Value) -> PointSource {
    let mut r = match record {
        Value::Object(r) => r,
        _ => Map::new(),
    };
    let id = r.remove("id").unwrap_or(Value::Null);
    let payload = match r.remove("payload") {
        Some(Value::Object(p)) => p,
        _ => Map::new(),
    };
    let (dense, creux) = match r.remove("vector") {
        Some(Value::Array(v)) => (vecteur_dense(&v), None),
        Some(Value::Object(v)) => (
            v.get("").and_then(Value::as_array).and_then(|d| vecteur_dense(d)),
            v.get("bm25").map(vecteur_creux),
        ),
        _ => (None, None),
    };
    PointSource { id, payload, dense, creux }
}

fn vecteur_dense(v: &[Value]) -> Option<Vec<f32>> {
    v.iter().map(|x| x.as_f64().map(|f| f as f32)).collect()
}

/// `{"indices":[0..=u32::MAX], "values":[nombres]}` de même longueur, ordre reçu.
fn vecteur_creux(v: &Value) -> Option<VecteurCreux> {
    let indices = v.get("indices")?.as_array()?;
    let valeurs = v.get("values")?.as_array()?;
    if indices.len() != valeurs.len() {
        return None;
    }
    indices
        .iter()
        .zip(valeurs)
        .map(|(i, w)| Some((u32::try_from(i.as_u64()?).ok()?, w.as_f64()? as f32)))
        .collect()
}

/// Lit `history` puis `messages` (S-3), en lecture seule.
type LignesHistory = (Vec<LigneSource<10>>, Vec<LigneSource<6>>);

fn lire_history(chemin: &Path) -> Result<LignesHistory, String> {
    let affiche = chemin.display();
    if matches!(chemin.try_exists(), Ok(false)) {
        return Err(format!("history.db introuvable : {affiche}"));
    }
    let illisible = |raison: &dyn std::fmt::Display| format!("history.db illisible ({affiche}) : {raison}");
    let conn = Connection::open_with_flags(chemin, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| illisible(&e))?;
    let colonnes_de = |table: &str| -> Result<Vec<String>, String> {
        conn.prepare("SELECT name FROM pragma_table_info(?1)")
            .and_then(|mut st| st.query_map([table], |r| r.get(0))?.collect())
            .map_err(|e| illisible(&e))
    };
    let controler = |table: &str, presentes: &[String], attendues: &[&str]| -> Result<(), String> {
        match attendues.iter().find(|c| !presentes.iter().any(|p| p.eq_ignore_ascii_case(c))) {
            Some(c) => Err(illisible(&format!("colonne {c} absente de la table {table}"))),
            None => Ok(()),
        }
    };
    let presentes = colonnes_de("history")?;
    if presentes.is_empty() {
        return Err(illisible(&"table history absente"));
    }
    controler("history", &presentes, &COLONNES_HISTORIQUE)?;
    let historique = lire_lignes(&conn, "history", &COLONNES_HISTORIQUE).map_err(|e| illisible(&e))?;
    let presentes = colonnes_de("messages")?;
    if presentes.is_empty() {
        return Ok((historique, Vec::new()));
    }
    controler("messages", &presentes, &COLONNES_MESSAGES)?;
    let messages = lire_lignes(&conn, "messages", &COLONNES_MESSAGES).map_err(|e| illisible(&e))?;
    Ok((historique, messages))
}

fn lire_lignes<const N: usize>(
    conn: &Connection,
    table: &str,
    colonnes: &[&str; N],
) -> rusqlite::Result<Vec<LigneSource<N>>> {
    let sql = format!("SELECT rowid, {} FROM {table} ORDER BY rowid", colonnes.join(", "));
    let mut st = conn.prepare(&sql)?;
    st.query_map([], |r| {
        let mut valeurs = [const { Sql::Null }; N];
        for (i, v) in valeurs.iter_mut().enumerate() {
            *v = r.get(i + 1)?;
        }
        Ok(LigneSource { rowid: r.get(0)?, colonnes: valeurs })
    })?
    .collect()
}

// ---------------------------------------------------------------------------
// Validation et correspondance (S-4, S-5)
// ---------------------------------------------------------------------------

/// Raison et détail d'un rejet (S-4).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Motif {
    raison: &'static str,
    detail: String,
}

impl Motif {
    fn new(raison: &'static str, detail: impl Into<String>) -> Motif {
        Motif { raison, detail: detail.into() }
    }
}

fn champ(nom: &str) -> Motif {
    Motif::new("champ_invalide", nom)
}

#[derive(Debug)]
struct PointValide {
    /// L'id en texte ; `None` : type d'id non pris en charge.
    id: Option<String>,
    id_rapport: String,
    agent: Option<String>,
    resultat: Result<SouvenirImporte, Motif>,
}

/// À quoi se rattache une ligne d'historique.
#[derive(Debug)]
enum Rattachement {
    /// Au point source d'indice donné.
    Point(usize),
    /// À un souvenir supprimé (absent des points, avec un `DELETE` : D-1).
    Supprime(String),
    /// À rien : le détail du rejet `historique_orphelin`.
    Orphelin(String),
    /// `memory_id` d'un type invalide (déjà rejeté en `champ_invalide`).
    Invalide,
}

#[derive(Debug)]
struct LigneValide {
    id_rapport: String,
    rattachement: Rattachement,
    resultat: Result<RevisionImportee, Motif>,
}

#[derive(Debug)]
struct MessageValide {
    id_rapport: String,
    portee: Option<String>,
    agent: Option<String>,
    resultat: Result<MessageImporte, Motif>,
}

/// La source lue et validée, avant tout contact avec la cible.
#[derive(Debug)]
pub struct Source {
    points: Vec<PointValide>,
    lignes: Vec<LigneValide>,
    messages: Vec<MessageValide>,
}

fn valider(points: Vec<PointSource>, lignes: Vec<LigneSource<10>>, messages: Vec<LigneSource<6>>, dims: usize) -> Source {
    let points: Vec<PointValide> = points.into_iter().map(|p| valider_point(p, dims)).collect();
    let index: HashMap<&str, usize> =
        points.iter().enumerate().filter_map(|(i, p)| Some((p.id.as_deref()?, i))).collect();
    let supprimes: HashSet<&str> = lignes
        .iter()
        .filter(|l| matches!(&l.colonnes[4], Sql::Text(e) if e == "DELETE"))
        .filter_map(|l| match &l.colonnes[1] {
            Sql::Text(m) => Some(m.as_str()),
            _ => None,
        })
        .collect();
    let rattachements: Vec<Rattachement> = lignes
        .iter()
        .map(|l| match &l.colonnes[1] {
            Sql::Text(m) => match index.get(m.as_str()) {
                Some(&i) => Rattachement::Point(i),
                None if supprimes.contains(m.as_str()) => Rattachement::Supprime(m.clone()),
                None => Rattachement::Orphelin(format!("memory_id {m}")),
            },
            Sql::Null => Rattachement::Orphelin("memory_id NULL".to_owned()),
            _ => Rattachement::Invalide,
        })
        .collect();
    let lignes = lignes
        .into_iter()
        .zip(rattachements)
        .map(|(l, rattachement)| LigneValide {
            id_rapport: id_de_ligne(&l),
            rattachement,
            resultat: valider_revision(l.colonnes),
        })
        .collect();
    let messages = messages
        .into_iter()
        .map(|m| {
            let portee = match &m.colonnes[1] {
                Sql::Text(p) => Some(p.clone()),
                _ => None,
            };
            MessageValide {
                id_rapport: id_de_ligne(&m),
                agent: portee.as_deref().and_then(agent_de_portee),
                portee,
                resultat: valider_message(m.colonnes),
            }
        })
        .collect();
    Source { points, lignes, messages }
}

/// L'`id` d'une ligne, ou `rowid:<n>` s'il n'est pas un texte (S-4).
fn id_de_ligne<const N: usize>(l: &LigneSource<N>) -> String {
    match &l.colonnes[0] {
        Sql::Text(id) => id.clone(),
        _ => format!("rowid:{}", l.rowid),
    }
}

fn valider_point(p: PointSource, dims: usize) -> PointValide {
    let id = match &p.id {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) if n.is_u64() => Some(n.to_string()),
        _ => None,
    };
    let id_rapport = id.clone().unwrap_or_else(|| p.id.to_string());
    let agent = match p.payload.get("agent_id") {
        Some(Value::String(a)) => Some(a.clone()),
        _ => None,
    };
    let resultat = souvenir(p, id.clone(), dims);
    PointValide { id, id_rapport, agent, resultat }
}

/// Contrôles de S-4 dans l'ordre de priorité, puis correspondance de S-5.
fn souvenir(p: PointSource, id: Option<String>, dims: usize) -> Result<SouvenirImporte, Motif> {
    let dense = p.dense.ok_or_else(|| Motif::new("vecteur_absent", "aucun vecteur dense"))?;
    if dense.len() != dims {
        return Err(Motif::new("dimension", format!("{} dimensions, {dims} attendues", dense.len())));
    }
    let payload = &p.payload;
    let memory = match payload.get("data") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err(Motif::new("texte_absent", "payload sans texte")),
    };
    let id = id.ok_or_else(|| champ("id"))?;
    let chaine = |cle: &str| match payload.get(cle) {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(champ(cle)),
    };
    let facultative = |cle: &str| match payload.get(cle) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(champ(cle)),
    };
    let hash = chaine("hash")?;
    let user_id = chaine("user_id")?;
    let agent_id = facultative("agent_id")?;
    let run_id = facultative("run_id")?;
    let role = facultative("role")?;
    let attributed_to = match payload.get("attributed_to") {
        None => None,
        Some(Value::Null) => return Err(champ("attributed_to")),
        Some(v) => Some(v.to_string()),
    };
    let tags = match payload.get("tags") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(t)) => Some(Some(t.clone())),
        Some(_) => return Err(champ("tags")),
    };
    let created_at = chaine("created_at")?;
    if micros_depuis_iso(&created_at).is_none() {
        return Err(champ("created_at"));
    }
    let updated_at = chaine("updated_at")?;
    let updated_at_us = micros_depuis_iso(&updated_at).ok_or_else(|| champ("updated_at"))?;
    if let Some(cle) = ["actor_id", "expiration_date"].into_iter().find(|c| payload.contains_key(*c)) {
        return Err(champ(cle));
    }
    let creux = match p.creux {
        None => None,
        Some(Some(c)) => Some(c),
        Some(None) => return Err(champ("bm25")),
    };
    let metadata: Map<String, Value> = payload
        .iter()
        .filter(|(cle, _)| !HORS_METADATA.contains(&cle.as_str()))
        .map(|(cle, v)| (cle.clone(), v.clone()))
        .collect();
    let metadata = (!metadata.is_empty()).then(|| Value::Object(metadata).to_string());
    Ok(SouvenirImporte {
        id,
        memory,
        hash,
        user_id,
        agent_id,
        run_id,
        role,
        attributed_to,
        metadata,
        tags,
        created_at,
        updated_at,
        updated_at_us,
        creux,
        dense,
    })
}

/// `Some` pour un texte, `None` pour NULL (seules valeurs admises après contrôle).
fn texte(v: Sql) -> Option<String> {
    match v {
        Sql::Text(s) => Some(s),
        _ => None,
    }
}

/// Une colonne est-elle conforme ? `obligatoire` : TEXT seulement ; sinon TEXT ou NULL.
fn texte_conforme(v: &Sql, obligatoire: bool) -> bool {
    matches!(v, Sql::Text(_)) || (!obligatoire && matches!(v, Sql::Null))
}

fn valider_revision(colonnes: [Sql; 10]) -> Result<RevisionImportee, Motif> {
    for (i, v) in colonnes.iter().enumerate() {
        let conforme = match i {
            7 => matches!(v, Sql::Null | Sql::Integer(_)),
            0 | 5 => texte_conforme(v, true),
            _ => texte_conforme(v, false),
        };
        if !conforme {
            return Err(champ(COLONNES_HISTORIQUE[i]));
        }
    }
    let [id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role] = colonnes;
    Ok(RevisionImportee {
        id: texte(id).unwrap_or_default(),
        memory_id: texte(memory_id),
        old_memory: texte(old_memory),
        new_memory: texte(new_memory),
        event: texte(event),
        created_at: texte(created_at).unwrap_or_default(),
        updated_at: texte(updated_at),
        is_deleted: match is_deleted {
            Sql::Integer(n) => n,
            _ => 0,
        },
        actor_id: texte(actor_id),
        role: texte(role),
    })
}

fn valider_message(colonnes: [Sql; 6]) -> Result<MessageImporte, Motif> {
    for (i, v) in colonnes.iter().enumerate() {
        if !texte_conforme(v, matches!(i, 0 | 1 | 5)) {
            return Err(champ(COLONNES_MESSAGES[i]));
        }
    }
    let [id, session_scope, role, content, name, created_at] = colonnes;
    Ok(MessageImporte {
        id: texte(id).unwrap_or_default(),
        session_scope: texte(session_scope).unwrap_or_default(),
        role: texte(role),
        content: texte(content),
        name: texte(name),
        created_at: texte(created_at).unwrap_or_default(),
    })
}

/// La valeur de `agent_id=` d'un `session_scope` (`extraction::portee_session`),
/// déséchappée ; `None` si la clé est absente.
fn agent_de_portee(portee: &str) -> Option<String> {
    let brut = portee.split('&').find_map(|p| p.strip_prefix("agent_id="))?;
    let mut agent = String::with_capacity(brut.len());
    let mut reste = brut;
    while let Some(i) = reste.find('%') {
        agent.push_str(&reste[..i]);
        let suite = &reste[i..];
        let (c, n) = match suite.get(..3) {
            Some("%3D") => ('=', 3),
            Some("%26") => ('&', 3),
            Some("%25") => ('%', 3),
            _ => ('%', 1),
        };
        agent.push(c);
        reste = &suite[n..];
    }
    agent.push_str(reste);
    Some(agent)
}

// ---------------------------------------------------------------------------
// Plan et rapport (S-6, S-9)
// ---------------------------------------------------------------------------

/// Ce que l'import écrit et le rapport qui en rend compte ; fonction pure de
/// (source, connaissances), commune à l'import réel et à `--dry-run`.
#[derive(Debug)]
pub struct Plan<'a> {
    pub a_ecrire: Ecritures<'a>,
    pub rapport: Rapport,
}

const SANS_AGENT: Option<String> = None;

fn planifier<'a>(source: &'a Source, c: &Connaissances) -> Plan<'a> {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Etat {
        Connu,
        Importe,
        Rejete,
    }
    let mut a_ecrire = Ecritures::default();
    let mut comptes = Comptes::default();
    let mut etats = Vec::with_capacity(source.points.len());
    for p in &source.points {
        let etat = if p.id.as_ref().is_some_and(|id| c.ids.contains(id)) {
            comptes.agent(&p.agent).deja_presents += 1;
            Etat::Connu
        } else {
            match &p.resultat {
                Ok(s) => {
                    comptes.agent(&p.agent).importes += 1;
                    a_ecrire.souvenirs.push(s);
                    Etat::Importe
                }
                Err(m) => {
                    comptes.rejeter(&p.agent, "souvenir", &p.id_rapport, m);
                    Etat::Rejete
                }
            }
        };
        etats.push(etat);
    }
    for l in &source.lignes {
        let agent = match &l.rattachement {
            Rattachement::Point(i) if etats[*i] == Etat::Importe => &source.points[*i].agent,
            Rattachement::Point(_) => continue,
            Rattachement::Supprime(id) if c.ids.contains(id) => continue,
            Rattachement::Supprime(_) | Rattachement::Invalide => &SANS_AGENT,
            Rattachement::Orphelin(detail) => {
                let orphelin = Motif::new("historique_orphelin", detail.as_str());
                let motif = l.resultat.as_ref().err().unwrap_or(&orphelin);
                comptes.rejeter(&SANS_AGENT, "historique", &l.id_rapport, motif);
                continue;
            }
        };
        match &l.resultat {
            Ok(r) => {
                comptes.agent(agent).revisions += 1;
                a_ecrire.revisions.push(r);
            }
            Err(m) => comptes.rejeter(agent, "historique", &l.id_rapport, m),
        }
    }
    for m in &source.messages {
        if m.portee.as_ref().is_some_and(|p| c.portees.contains(p)) {
            continue;
        }
        match &m.resultat {
            Ok(x) => {
                comptes.agent(&m.agent).messages += 1;
                a_ecrire.messages.push(x);
            }
            Err(motif) => comptes.rejeter(&m.agent, "message", &m.id_rapport, motif),
        }
    }
    Plan { a_ecrire, rapport: comptes.rapport() }
}

#[derive(Default)]
struct Comptes {
    agents: HashMap<Option<String>, CompteAgent>,
}

impl Comptes {
    fn agent(&mut self, agent: &Option<String>) -> &mut CompteAgent {
        self.agents.entry(agent.clone()).or_insert_with(|| CompteAgent {
            agent_id: agent.clone(),
            importes: 0,
            deja_presents: 0,
            rejetes: Vec::new(),
            revisions: 0,
            messages: 0,
        })
    }

    fn rejeter(&mut self, agent: &Option<String>, element: &'static str, id: &str, motif: &Motif) {
        self.agent(agent).rejetes.push(Rejet {
            element,
            id: id.to_owned(),
            raison: motif.raison,
            detail: motif.detail.clone(),
        });
    }

    /// Agents triés par `agent_id` (octets UTF-8), `null` en dernier.
    fn rapport(self) -> Rapport {
        let mut agents: Vec<CompteAgent> = self.agents.into_values().collect();
        agents.sort_by(|a, b| (a.agent_id.is_none(), &a.agent_id).cmp(&(b.agent_id.is_none(), &b.agent_id)));
        let mut totaux = Totaux::default();
        for a in &agents {
            totaux.importes += a.importes;
            totaux.deja_presents += a.deja_presents;
            totaux.rejetes += a.rejetes.len() as u64;
            totaux.revisions += a.revisions;
            totaux.messages += a.messages;
        }
        Rapport { agents, totaux }
    }
}

/// Rapport de fin (S-9) ; sa forme JSON est l'interface figée lue par l'app Swift.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Rapport {
    agents: Vec<CompteAgent>,
    totaux: Totaux,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct CompteAgent {
    agent_id: Option<String>,
    importes: u64,
    deja_presents: u64,
    rejetes: Vec<Rejet>,
    revisions: u64,
    messages: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct Rejet {
    element: &'static str,
    id: String,
    raison: &'static str,
    detail: String,
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
struct Totaux {
    importes: u64,
    deja_presents: u64,
    rejetes: u64,
    revisions: u64,
    messages: u64,
}

impl Rapport {
    /// Un objet JSON sur une ligne, suivi de `\n`.
    fn json(&self) -> String {
        let mut s = serde_json::to_string(self).expect("rapport : sérialisation JSON infaillible");
        s.push('\n');
        s
    }

    fn texte(&self) -> String {
        let mut s = String::new();
        for a in &self.agents {
            let _ = writeln!(
                s,
                "{} : {} importés, {} déjà présents, {} rejetés, {} révisions, {} messages",
                a.agent_id.as_deref().unwrap_or("(sans agent_id)"),
                a.importes,
                a.deja_presents,
                a.rejetes.len(),
                a.revisions,
                a.messages
            );
            for r in &a.rejetes {
                let _ = writeln!(s, "  rejet {} {} : {} ({})", r.element, r.id, r.raison, r.detail);
            }
        }
        let t = &self.totaux;
        let _ = writeln!(
            s,
            "total : {} importés, {} déjà présents, {} rejetés, {} révisions, {} messages",
            t.importes, t.deja_presents, t.rejetes, t.revisions, t.messages
        );
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIMS: usize = 3;

    fn payload(data: &str, agent: Option<&str>) -> Value {
        let mut p = json!({
            "data": data, "hash": "h", "user_id": "moi", "role": "user", "tags": "t",
            "text_lemmatized": data,
            "created_at": "2026-10-12T10:00:00.000001+00:00",
            "updated_at": "2026-10-12T10:00:00.000002+00:00"
        });
        if let Some(a) = agent {
            p["agent_id"] = json!(a);
        }
        p
    }

    fn nomme() -> Value {
        json!({"": [1.0, 0.0, 0.0], "bm25": {"indices": [7, 3, 7], "values": [0.5, 1.5, 0.5]}})
    }

    fn point(id: Value, payload: Value, vector: Value) -> PointSource {
        point_source(json!({"id": id, "payload": payload, "vector": vector}))
    }

    fn t(s: &str) -> Sql {
        Sql::Text(s.to_owned())
    }

    fn ligne(rowid: i64, id: &str, memory_id: &str, event: &str) -> LigneSource<10> {
        LigneSource {
            rowid,
            colonnes: [
                t(id),
                t(memory_id),
                Sql::Null,
                t("texte"),
                t(event),
                t("2026-10-12T10:00:00+00:00"),
                Sql::Null,
                Sql::Null,
                Sql::Null,
                t("user"),
            ],
        }
    }

    fn message(rowid: i64, id: &str, portee: &str) -> LigneSource<6> {
        LigneSource {
            rowid,
            colonnes: [t(id), t(portee), t("user"), t("contenu"), Sql::Null, t("2026-10-12T10:00:00+00:00")],
        }
    }

    fn motif(p: PointSource) -> (&'static str, String) {
        match valider_point(p, DIMS).resultat {
            Err(m) => (m.raison, m.detail),
            Ok(s) => panic!("accepté : {s:?}"),
        }
    }

    /// AC-7 (S-4) : chaque raison et chaque champ, dans l'ordre de priorité.
    #[test]
    fn ac7_rejets_de_souvenir_par_priorite() {
        let modifie = |f: &dyn Fn(&mut Value)| {
            let mut p = payload("texte", Some("a1"));
            f(&mut p);
            point(json!("p"), p, nomme())
        };
        let sans_texte = json!({"user_id": "moi"});
        let cas: Vec<(PointSource, &str, &str)> = vec![
            (point(json!("p"), sans_texte.clone(), Value::Null), "vecteur_absent", "aucun vecteur dense"),
            (point(json!("p"), sans_texte.clone(), json!({"bm25": {"indices": [], "values": []}})), "vecteur_absent", "aucun vecteur dense"),
            (point_source(json!({"id": "p", "payload": sans_texte})), "vecteur_absent", "aucun vecteur dense"),
            (point(json!("p"), sans_texte.clone(), json!([1.0, 0.0])), "dimension", "2 dimensions, 3 attendues"),
            (point(json!(1.5), sans_texte.clone(), json!({"": [0.0, 0.0, 1.0]})), "texte_absent", "payload sans texte"),
            (modifie(&|p| p["data"] = json!("")), "texte_absent", "payload sans texte"),
            (modifie(&|p| p["data"] = json!(5)), "texte_absent", "payload sans texte"),
            (point(json!(1.5), json!({"data": "x"}), nomme()), "champ_invalide", "id"),
            (point(json!(-1), payload("x", None), nomme()), "champ_invalide", "id"),
            (modifie(&|p| { p.as_object_mut().unwrap().remove("hash"); p["user_id"] = json!(1); }), "champ_invalide", "hash"),
            (modifie(&|p| p["hash"] = json!(3)), "champ_invalide", "hash"),
            (modifie(&|p| { p.as_object_mut().unwrap().remove("user_id"); }), "champ_invalide", "user_id"),
            (modifie(&|p| { p["agent_id"] = Value::Null; p["run_id"] = json!(1); }), "champ_invalide", "agent_id"),
            (modifie(&|p| p["run_id"] = json!(1)), "champ_invalide", "run_id"),
            (modifie(&|p| p["role"] = Value::Null), "champ_invalide", "role"),
            (modifie(&|p| p["attributed_to"] = Value::Null), "champ_invalide", "attributed_to"),
            (modifie(&|p| p["tags"] = json!(["a"])), "champ_invalide", "tags"),
            (modifie(&|p| p["created_at"] = json!("2026-10-12 10:00:00")), "champ_invalide", "created_at"),
            (modifie(&|p| { p.as_object_mut().unwrap().remove("updated_at"); }), "champ_invalide", "updated_at"),
            (modifie(&|p| p["updated_at"] = json!(17)), "champ_invalide", "updated_at"),
            (modifie(&|p| p["actor_id"] = json!("x")), "champ_invalide", "actor_id"),
            (modifie(&|p| p["expiration_date"] = Value::Null), "champ_invalide", "expiration_date"),
        ];
        for (i, (p, raison, detail)) in cas.into_iter().enumerate() {
            assert_eq!(motif(p), (raison, detail.to_owned()), "cas {i}");
        }
        for bm25 in [
            json!({"indices": [1, 2], "values": [0.5]}),
            json!({"indices": [-1], "values": [0.5]}),
            json!({"indices": [4_294_967_296_u64], "values": [0.5]}),
            json!({"indices": [1.5], "values": [0.5]}),
            json!({"indices": [1], "values": ["0.5"]}),
            Value::Null,
        ] {
            let p = point(json!("p"), payload("x", None), json!({"": [1.0, 0.0, 0.0], "bm25": bm25}));
            assert_eq!(motif(p), ("champ_invalide", "bm25".to_owned()));
        }
        // Acceptés : texte blanc (comme Python), tags null, id entier.
        let mut p = payload("   ", None);
        p["tags"] = Value::Null;
        assert!(valider_point(point(json!(42), p, json!([0.0, 1.0, 0.0])), DIMS).resultat.is_ok());
    }

    /// AC-3 (S-5) : forme nommée et liste nue donnent le même souvenir, au creux près.
    #[test]
    fn ac3_correspondance_des_deux_formes() {
        let mut p = payload("texte", Some("a1"));
        p["memory_type"] = json!("procedural_memory");
        p["attributed_to"] = json!("user");
        p["n"] = serde_json::from_str("1.50").unwrap();
        p["tags"] = Value::Null;
        let nommee = valider_point(point(json!(42), p.clone(), nomme()), DIMS).resultat.unwrap();
        assert_eq!(
            nommee,
            SouvenirImporte {
                id: "42".into(),
                memory: "texte".into(),
                hash: "h".into(),
                user_id: "moi".into(),
                agent_id: Some("a1".into()),
                run_id: None,
                role: Some("user".into()),
                attributed_to: Some("\"user\"".into()),
                metadata: Some(r#"{"memory_type":"procedural_memory","n":1.50}"#.into()),
                tags: Some(None),
                created_at: "2026-10-12T10:00:00.000001+00:00".into(),
                updated_at: "2026-10-12T10:00:00.000002+00:00".into(),
                updated_at_us: micros_depuis_iso("2026-10-12T10:00:00.000002Z").unwrap(),
                creux: Some(vec![(7, 0.5), (3, 1.5), (7, 0.5)]),
                dense: vec![1.0, 0.0, 0.0],
            }
        );
        let nue = valider_point(point(json!(42), p, json!([1.0, 0.0, 0.0])), DIMS).resultat.unwrap();
        assert_eq!(nue, SouvenirImporte { creux: None, ..nommee });
        let sans_cle = valider_point(point(json!("u"), payload("x", None), nomme()), DIMS).resultat.unwrap();
        assert_eq!(sans_cle.metadata, None);
        assert_eq!(sans_cle.tags, Some(Some("t".into())));
    }

    fn source(points: Vec<PointSource>, lignes: Vec<LigneSource<10>>, messages: Vec<LigneSource<6>>) -> Source {
        valider(points, lignes, messages, DIMS)
    }

    fn rapport_json(source: &Source, c: &Connaissances) -> Value {
        serde_json::from_str(&planifier(source, c).rapport.json()).unwrap()
    }

    /// AC-7 (S-4, D-1) : orphelins listés, lignes d'un souvenir supprimé
    /// importées, lignes d'un point rejeté sautées sans être listées, ligne
    /// invalide d'un souvenir importé rejetée seule.
    #[test]
    fn ac7_historique_d1_orphelins_et_point_rejete() {
        let mut nulle = ligne(6, "x", "x", "ADD");
        nulle.colonnes[0] = Sql::Null;
        nulle.colonnes[1] = Sql::Null;
        let mut sans_memoire = ligne(7, "h7", "x", "ADD");
        sans_memoire.colonnes[1] = Sql::Null;
        let mut reel = ligne(8, "h8", "a", "UPDATE");
        reel.colonnes[7] = Sql::Real(0.0);
        let mut entier = ligne(9, "h9", "o", "ADD");
        entier.colonnes[3] = Sql::Integer(3);
        let s = source(
            vec![point(json!("a"), payload("x", Some("a1")), nomme()), point(json!("r"), payload("x", Some("a1")), Value::Null)],
            vec![
                ligne(1, "h1", "a", "ADD"),
                ligne(2, "h2", "r", "ADD"),
                ligne(3, "h3", "s", "ADD"),
                ligne(4, "h4", "s", "DELETE"),
                ligne(5, "h5", "o", "ADD"),
                nulle,
                sans_memoire,
                reel,
                entier,
            ],
            vec![],
        );
        let plan = planifier(&s, &Connaissances::default());
        let ids: Vec<&str> = plan.a_ecrire.revisions.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["h1", "h3", "h4"]);
        assert_eq!(plan.a_ecrire.souvenirs.len(), 1);
        assert_eq!(
            rapport_json(&s, &Connaissances::default()),
            json!({"agents": [
                {"agent_id": "a1", "importes": 1, "deja_presents": 0, "rejetes": [
                    {"element": "souvenir", "id": "r", "raison": "vecteur_absent", "detail": "aucun vecteur dense"},
                    {"element": "historique", "id": "h8", "raison": "champ_invalide", "detail": "is_deleted"}
                ], "revisions": 1, "messages": 0},
                {"agent_id": null, "importes": 0, "deja_presents": 0, "rejetes": [
                    {"element": "historique", "id": "h5", "raison": "historique_orphelin", "detail": "memory_id o"},
                    {"element": "historique", "id": "rowid:6", "raison": "champ_invalide", "detail": "id"},
                    {"element": "historique", "id": "h7", "raison": "historique_orphelin", "detail": "memory_id NULL"},
                    {"element": "historique", "id": "h9", "raison": "champ_invalide", "detail": "new_memory"}
                ], "revisions": 2, "messages": 0}
            ], "totaux": {"importes": 1, "deja_presents": 0, "rejetes": 6, "revisions": 3, "messages": 0}})
        );
    }

    /// AC-5 (S-6) : la cible gagne — id connu par `memories` ou par
    /// `history.memory_id`, portée connue sautée sans être comptée.
    #[test]
    fn ac5_plan_la_cible_gagne() {
        let s = source(
            vec![
                point(json!("a"), payload("x", Some("a1")), nomme()),
                point(json!("b"), payload("x", Some("a1")), Value::Null),
                point(json!("c"), payload("x", Some("a2")), nomme()),
            ],
            vec![ligne(1, "h1", "a", "ADD"), ligne(2, "h2", "s", "DELETE"), ligne(3, "h3", "c", "ADD")],
            vec![
                message(1, "m1", "agent_id=a1&user_id=moi"),
                message(2, "m2", "agent_id=a2&user_id=moi"),
                message(3, "m3", "user_id=moi"),
            ],
        );
        let c = Connaissances {
            ids: ["a", "b", "s"].map(String::from).into(),
            portees: ["agent_id=a1&user_id=moi".to_owned()].into(),
        };
        let plan = planifier(&s, &c);
        assert_eq!(plan.a_ecrire.souvenirs.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["c"]);
        assert_eq!(plan.a_ecrire.revisions.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["h3"]);
        assert_eq!(plan.a_ecrire.messages.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["m2", "m3"]);
        assert_eq!(
            rapport_json(&s, &c),
            json!({"agents": [
                {"agent_id": "a1", "importes": 0, "deja_presents": 2, "rejetes": [], "revisions": 0, "messages": 0},
                {"agent_id": "a2", "importes": 1, "deja_presents": 0, "rejetes": [], "revisions": 1, "messages": 1},
                {"agent_id": null, "importes": 0, "deja_presents": 0, "rejetes": [], "revisions": 0, "messages": 1}
            ], "totaux": {"importes": 1, "deja_presents": 2, "rejetes": 0, "revisions": 1, "messages": 2}})
        );
    }

    /// AC-10 (S-9) : ordre des agents (octets, `null` en dernier), texte et JSON exacts.
    #[test]
    fn ac10_rapport_texte_et_json_exacts() {
        let mut sans_texte = payload("", Some("é"));
        sans_texte["data"] = Value::Null;
        let mut invalide = message(2, "m2", "agent_id=b&user_id=moi");
        invalide.colonnes[3] = Sql::Integer(1);
        let s = source(
            vec![
                point(json!("1"), payload("x", Some("b")), nomme()),
                point(json!("2"), payload("x", None), nomme()),
                point(json!("3"), payload("x", Some("B")), nomme()),
                point(json!("4"), sans_texte, nomme()),
            ],
            vec![ligne(1, "h1", "1", "ADD")],
            vec![message(1, "m1", "agent_id=b&user_id=moi"), invalide],
        );
        let rapport = planifier(&s, &Connaissances::default()).rapport;
        assert_eq!(
            rapport.texte(),
            "B : 1 importés, 0 déjà présents, 0 rejetés, 0 révisions, 0 messages\n\
             b : 1 importés, 0 déjà présents, 1 rejetés, 1 révisions, 1 messages\n\
             \x20 rejet message m2 : champ_invalide (content)\n\
             é : 0 importés, 0 déjà présents, 1 rejetés, 0 révisions, 0 messages\n\
             \x20 rejet souvenir 4 : texte_absent (payload sans texte)\n\
             (sans agent_id) : 1 importés, 0 déjà présents, 0 rejetés, 0 révisions, 0 messages\n\
             total : 3 importés, 0 déjà présents, 2 rejetés, 1 révisions, 1 messages\n"
        );
        assert_eq!(
            rapport.json(),
            concat!(
                r#"{"agents":[{"agent_id":"B","importes":1,"deja_presents":0,"rejetes":[],"revisions":0,"messages":0},"#,
                r#"{"agent_id":"b","importes":1,"deja_presents":0,"rejetes":[{"element":"message","id":"m2","raison":"champ_invalide","detail":"content"}],"revisions":1,"messages":1},"#,
                r#"{"agent_id":"é","importes":0,"deja_presents":0,"rejetes":[{"element":"souvenir","id":"4","raison":"texte_absent","detail":"payload sans texte"}],"revisions":0,"messages":0},"#,
                r#"{"agent_id":null,"importes":1,"deja_presents":0,"rejetes":[],"revisions":0,"messages":0}],"#,
                r#""totaux":{"importes":3,"deja_presents":0,"rejetes":2,"revisions":1,"messages":1}}"#,
                "\n"
            )
        );
    }

    /// AC-10 (S-9) : source vide.
    #[test]
    fn ac10_rapport_source_vide() {
        let rapport = planifier(&source(vec![], vec![], vec![]), &Connaissances::default()).rapport;
        assert_eq!(rapport.texte(), "total : 0 importés, 0 déjà présents, 0 rejetés, 0 révisions, 0 messages\n");
        assert_eq!(
            rapport.json(),
            "{\"agents\":[],\"totaux\":{\"importes\":0,\"deja_presents\":0,\"rejetes\":0,\"revisions\":0,\"messages\":0}}\n"
        );
    }

    #[test]
    fn agent_de_portee_desechappe() {
        assert_eq!(agent_de_portee("agent_id=a%3Db%26c%25d%253D&user_id=moi").as_deref(), Some("a=b&c%d%3D"));
        assert_eq!(agent_de_portee("run_id=r&user_id=moi"), None);
        assert_eq!(agent_de_portee("user_id=moi"), None);
        let portee = crate::extraction::portee_session("moi", Some("x=%&y"), Some("r"));
        assert_eq!(agent_de_portee(&portee).as_deref(), Some("x=%&y"));
    }
}
