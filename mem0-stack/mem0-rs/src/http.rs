//! Surface HTTP (S-2 à S-5, S-7) : les 9 routes du Python, le jeton après la
//! validation, et les corps d'erreur exacts de FastAPI/starlette (D-6).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use md5::{Digest, Md5};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::config::{blanc_python, strip_python};
use crate::db::{self, FaitInfere, MessageSession, Souvenir};
use crate::embedder::Embedder;
use crate::extraction::{self, Lecture};
use crate::graphe::{self, Arete, GRAPH_THRESHOLD, GRAPH_TOP_K};
use crate::horodatage;
use crate::openai::ClientChat;
use crate::recherche::{self, Details, Refus};
use crate::redaction::masquer;
use crate::validation::{self, Rejet};

/// Utilisateur fixe (repris de l'ancien mem0-http Python).
pub const USER: &str = "moi";

/// Taille maximale d'un corps de requête : 1 Mio. Écart assumé au Python (sans
/// borne) : un souvenir tient en quelques Ko, et un corps sans borne est lu en
/// entier en mémoire avant toute validation, jeton compris. Au-delà : 413.
pub const CORPS_MAX: usize = 1024 * 1024;

/// État partagé par les routes.
pub struct Etat {
    pub db: Arc<Mutex<Connection>>,
    pub embedder: Embedder,
    /// chat/completions de l'extraction (add infer=true).
    pub chat: ClientChat,
    /// Secret : jamais imprimé. Vide = aucun contrôle.
    pub http_token: String,
    pub installation_token: String,
}

type Partage = State<Arc<Etat>>;

/// Le routeur complet.
///
/// Les chemins statiques sous `/memory/` acceptent aussi PUT et DELETE, comme
/// `/memory/{memory_id}` du Python (starlette essaie les routes dans l'ordre : un
/// PUT sur `/memory/all` y aboutit avec `memory_id = "all"`).
pub fn routeur(etat: Arc<Etat>) -> Router {
    let mut r = Router::new().route("/health", get(health));
    for (chemin, route) in [
        ("/memory/add", post(add)),
        ("/memory/add_procedure", post(add_procedure)),
        ("/memory/search", post(search)),
        ("/memory/all", get(all)),
        ("/memory/graph", get(graph)),
    ] {
        let id = chemin.trim_start_matches("/memory/");
        r = r.route(
            chemin,
            route
                .put(move |e: Partage, h: HeaderMap, c: Bytes| update(e, id.to_owned(), h, c))
                .delete(move |e: Partage, h: HeaderMap| delete(e, id.to_owned(), h)),
        );
    }
    r.route(
        "/memory/{memory_id}",
        put(|e: Partage, Path(id): Path<String>, h: HeaderMap, c: Bytes| update(e, id, h, c))
            .delete(|e: Partage, Path(id): Path<String>, h: HeaderMap| delete(e, id, h)),
    )
    .route("/memory/{memory_id}/history", get(history))
    .fallback(|| async { json(StatusCode::NOT_FOUND, &json!({ "detail": "Not Found" })) })
    .method_not_allowed_fallback(|| async {
        json(StatusCode::METHOD_NOT_ALLOWED, &json!({ "detail": "Method Not Allowed" }))
    })
    .layer(axum::middleware::map_response(corps_trop_gros_en_json))
    .layer(DefaultBodyLimit::max(CORPS_MAX))
    .with_state(etat)
}

/// Le 413 de `DefaultBodyLimit` est en texte brut : il est rendu au format
/// d'erreur des autres routes, `{"detail": …}`.
async fn corps_trop_gros_en_json(reponse: Response) -> Response {
    if reponse.status() != StatusCode::PAYLOAD_TOO_LARGE {
        return reponse;
    }
    json(StatusCode::PAYLOAD_TOO_LARGE, &json!({ "detail": format!("corps de requête au-delà de {CORPS_MAX} octets") }))
}

/// Réponse JSON (`application/json`), ou 500 si la sérialisation échoue.
fn json(statut: StatusCode, corps: &impl Serialize) -> Response {
    match serde_json::to_vec(corps) {
        Ok(octets) => {
            (statut, [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], octets).into_response()
        }
        Err(_) => interne(),
    }
}

/// 500 de starlette `ServerErrorMiddleware`.
fn interne() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"))],
        Body::from("Internal Server Error"),
    )
        .into_response()
}

fn rejet(r: Rejet) -> Response {
    match r {
        Rejet::Invalide(entrees) => json(StatusCode::UNPROCESSABLE_ENTITY, &Rejet::corps_422(&entrees)),
        Rejet::CorpsIllisible => json(StatusCode::BAD_REQUEST, &json!({ "detail": "There was an error parsing the body" })),
        Rejet::Interne => interne(),
    }
}

/// `None` si le jeton est bon (ou non exigé), sinon la réponse 401.
fn controle_jeton(etat: &Etat, entetes: &HeaderMap) -> Option<Response> {
    if etat.http_token.is_empty()
        || entetes.get("x-mem0-token").is_some_and(|v| egal_temps_constant(v.as_bytes(), etat.http_token.as_bytes()))
    {
        return None;
    }
    Some(json(StatusCode::UNAUTHORIZED, &json!({ "detail": "bad or missing X-Mem0-Token" })))
}

/// Égalité d'octets dont la durée ne dépend pas de la position du premier écart :
/// `==` s'arrête au premier octet différent, ce qui laisse deviner le jeton octet
/// par octet en mesurant les réponses. Seule la longueur se lit au chronomètre.
fn egal_temps_constant(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let ecart = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(ecart) == 0
}

fn content_type(entetes: &HeaderMap) -> Option<&[u8]> {
    entetes.get(header::CONTENT_TYPE).map(HeaderValue::as_bytes)
}

/// Identifiant de portée (S-2) : `null`/`""` → absent ; trim Python ; vide après
/// trim ou blanc interne → `Err` (500).
fn portee(valeur: Option<String>) -> Result<Option<String>, ()> {
    match valeur.as_deref() {
        None | Some("") => Ok(None),
        Some(brut) => {
            let t = strip_python(brut);
            if t.is_empty() || t.chars().any(blanc_python) { Err(()) } else { Ok(Some(t.to_owned())) }
        }
    }
}

/// Exécute `f` sur la connexion, hors du runtime async.
async fn avec_base<T, F>(etat: &Etat, f: F) -> Result<T, ()>
where
    T: Send + 'static,
    F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
{
    let db = Arc::clone(&etat.db);
    tokio::task::spawn_blocking(move || {
        let mut conn = db.lock().map_err(|_| ())?;
        f(&mut conn).map_err(|e| eprintln!("mem0-rs : erreur SQLite : {e}"))
    })
    .await
    .map_err(|_| ())?
}

fn md5_hex(texte: &str) -> String {
    Md5::digest(texte.as_bytes()).iter().map(|o| format!("{o:02x}")).collect()
}

async fn health(State(etat): Partage) -> Response {
    let mut corps = json!({
        "ok": true,
        "mem0": concat!("mem0-rs ", env!("CARGO_PKG_VERSION")),
        "user": USER,
    });
    if !etat.installation_token.is_empty() {
        corps["installation"] = json!(etat.installation_token);
    }
    json(StatusCode::OK, &corps)
}

async fn add(State(etat): Partage, entetes: HeaderMap, corps: Bytes) -> Response {
    let req = match validation::add(content_type(&entetes), &corps) {
        Ok(r) => r,
        Err(r) => return rejet(r),
    };
    if let Some(refus) = controle_jeton(&etat, &entetes) {
        return refus;
    }
    let (Ok(agent_id), Ok(run_id)) = (portee(req.agent_id), portee(req.run_id)) else {
        return interne();
    };
    let tags = req.tags.filter(|t| !t.is_empty());
    // Masquage des secrets avant tout usage du texte : embedding, invite
    // d'extraction, message de session et souvenir ne voient que la version masquée.
    let texte = masquer(&req.text);
    if req.infer {
        ajouter_infere(&etat, texte, agent_id, run_id, tags).await
    } else {
        ajouter(&etat, texte, agent_id, run_id, tags).await
    }
}

async fn add_procedure(State(etat): Partage, entetes: HeaderMap, corps: Bytes) -> Response {
    let req = match validation::add_procedure(content_type(&entetes), &corps) {
        Ok(r) => r,
        Err(r) => return rejet(r),
    };
    if let Some(refus) = controle_jeton(&etat, &entetes) {
        return refus;
    }
    let Ok(agent_id) = portee(Some(req.agent_id)) else {
        return interne();
    };
    ajouter(&etat, masquer(&req.steps), agent_id, None, None).await
}

/// add infer=false (S-3) : embedding, puis une transaction.
async fn ajouter(
    etat: &Etat,
    texte: String,
    agent_id: Option<String>,
    run_id: Option<String>,
    tags: Option<String>,
) -> Response {
    let Ok(vecteur) = etat.embedder.plonger(&texte).await.map_err(|e| eprintln!("mem0-rs : {e}")) else {
        return interne();
    };
    let id = uuid::Uuid::new_v4().to_string();
    let ecrit = {
        let (id, texte) = (id.clone(), texte.clone());
        avec_base(etat, move |conn| {
            let instant = horodatage::maintenant();
            let hash = md5_hex(&texte);
            db::ajouter(
                conn,
                &db::NouveauSouvenir {
                    id: &id,
                    memory: &texte,
                    hash: &hash,
                    user_id: USER,
                    agent_id: agent_id.as_deref(),
                    run_id: run_id.as_deref(),
                    role: Some("user"),
                    attributed_to: None,
                    tags: tags.as_deref(),
                    instant: &instant,
                },
                &vecteur,
            )
        })
        .await
    };
    match ecrit {
        Ok(()) => json(
            StatusCode::OK,
            &json!({ "results": [{ "id": id, "memory": texte, "event": "ADD", "actor_id": null, "role": "user" }] }),
        ),
        Err(()) => interne(),
    }
}

/// add infer=true (S-2 à S-4) : chemin additif de mem0 2.2.1. Aucune écriture
/// avant la dernière étape, atomique ; le verrou de la base n'est jamais tenu
/// pendant un appel sortant.
async fn ajouter_infere(
    etat: &Etat,
    texte: String,
    agent_id: Option<String>,
    run_id: Option<String>,
    tags: Option<String>,
) -> Response {
    let scope = extraction::portee_session(USER, agent_id.as_deref(), run_id.as_deref());
    let derniers = {
        let scope = scope.clone();
        avec_base(etat, move |conn| db::derniers_messages(conn, &scope, db::MESSAGES_PAR_PORTEE)).await
    };
    let Ok(derniers) = derniers else {
        return interne();
    };
    let Ok(requete) = etat.embedder.plonger(&format!("user: {texte}\n")).await.map_err(|e| eprintln!("mem0-rs : {e}"))
    else {
        return interne();
    };
    let voisins = {
        let (agent_id, run_id) = (agent_id.clone(), run_id.clone());
        avec_base(etat, move |conn| {
            db::voisins(conn, USER, agent_id.as_deref(), run_id.as_deref(), &requete, extraction::VOISINS)
        })
        .await
    };
    let Ok(voisins) = voisins else {
        return interne();
    };
    let existants: Vec<String> = voisins.iter().map(|(s, _)| s.memory.clone()).collect();
    let hashes: HashSet<String> = voisins.into_iter().map(|(s, _)| s.hash).collect();
    let date = &horodatage::maintenant().iso[..10];
    let invite = extraction::invite_utilisateur(&derniers, &existants, &texte, date);
    let contenu = match etat.chat.completer(extraction::ADDITIVE_EXTRACTION_PROMPT, &invite).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("mem0-rs : extraction : {e}");
            return interne();
        }
    };
    let elements = match extraction::lire_faits(&contenu) {
        Lecture::Elements(e) => e,
        Lecture::Vide => Vec::new(),
        Lecture::Illisible(raison) => {
            eprintln!("mem0-rs : extraction : {raison}");
            Vec::new()
        }
        Lecture::Invalide => {
            eprintln!("mem0-rs : extraction : `memory` n'est pas une liste d'objets");
            return interne();
        }
    };
    let plongees = plonger_faits(&etat.embedder, &elements).await;
    let Ok(faits) = retenir(&elements, &plongees, hashes) else {
        eprintln!("mem0-rs : extraction : un `text` extrait est un tableau ou un objet");
        return interne();
    };
    let resultats: Vec<Value> =
        faits.iter().map(|f| json!({ "id": f.id, "memory": f.memory, "event": "ADD" })).collect();
    let message = MessageSession {
        id: uuid::Uuid::new_v4().to_string(),
        portee: scope,
        content: texte,
        instant: horodatage::maintenant(),
    };
    let ecrit = avec_base(etat, move |conn| {
        if faits.is_empty() {
            db::sauver_message(conn, &message)
        } else {
            db::ajouter_infere(conn, USER, agent_id.as_deref(), run_id.as_deref(), tags.as_deref(), &faits, &message)
        }
    })
    .await;
    match ecrit {
        Ok(()) => json(StatusCode::OK, &json!({ "results": resultats })),
        Err(()) => interne(),
    }
}

/// `text` d'un élément extrait (absent → `null`).
fn texte_extrait(element: &Map<String, Value>) -> &Value {
    element.get("text").unwrap_or(&Value::Null)
}

/// Vecteurs des `text` truthy extraits (S-4, étape 1) : par lots si tous sont des
/// chaînes, sinon (ou si un lot échoue) une requête par chaîne ; un échec rend le
/// texte « non embarqué ».
async fn plonger_faits(embedder: &Embedder, elements: &[Map<String, Value>]) -> HashMap<String, Vec<f32>> {
    let textes: Vec<&Value> = elements.iter().map(texte_extrait).filter(|t| extraction::truthy(t)).collect();
    let chaines: Vec<String> = textes.iter().filter_map(|t| t.as_str()).map(str::to_owned).collect();
    let mut plongees = HashMap::with_capacity(chaines.len());
    if chaines.is_empty() {
        return plongees;
    }
    if chaines.len() == textes.len() {
        match embedder.plonger_lot(&chaines).await {
            Ok(vecteurs) => {
                plongees.extend(chaines.into_iter().zip(vecteurs));
                return plongees;
            }
            Err(e) => eprintln!("mem0-rs : extraction : lot d'embeddings en échec, repli texte par texte : {e}"),
        }
    }
    for t in chaines {
        match embedder.plonger(&t).await {
            Ok(v) => {
                plongees.insert(t, v);
            }
            Err(e) => eprintln!("mem0-rs : extraction : fait non embarqué : {e}"),
        }
    }
    plongees
}

/// Faits retenus (S-4, étape 2), dans l'ordre : `text` chaîne embarquée dont le
/// md5 n'est ni dans `hashes` (top 10 existant) ni déjà retenu. `Err` : un `text`
/// truthy est un tableau ou un objet (500).
fn retenir(
    elements: &[Map<String, Value>],
    plongees: &HashMap<String, Vec<f32>>,
    mut hashes: HashSet<String>,
) -> Result<Vec<FaitInfere>, ()> {
    let mut faits = Vec::new();
    for e in elements {
        let t = texte_extrait(e);
        if !extraction::truthy(t) {
            continue;
        }
        let memory = match t {
            Value::Array(_) | Value::Object(_) => return Err(()),
            Value::String(s) => s,
            _ => continue,
        };
        let Some(vecteur) = plongees.get(memory) else {
            continue;
        };
        let hash = md5_hex(memory);
        if !hashes.insert(hash.clone()) {
            continue;
        }
        faits.push(FaitInfere {
            id: uuid::Uuid::new_v4().to_string(),
            memory: memory.clone(),
            hash,
            attributed_to: e.get("attributed_to").filter(|a| extraction::truthy(a)).cloned(),
            instant: horodatage::maintenant(),
            vecteur: vecteur.clone(),
        });
    }
    Ok(faits)
}

async fn search(State(etat): Partage, entetes: HeaderMap, corps: Bytes) -> Response {
    let mut req = match validation::search(content_type(&entetes), &corps) {
        Ok(r) => r,
        Err(r) => return rejet(r),
    };
    if let Some(refus) = controle_jeton(&etat, &entetes) {
        return refus;
    }
    let Ok(agent_id) = portee(req.agent_id.take()) else {
        return interne();
    };
    let explain = req.explain;
    let requete = match recherche::preparer(req, USER, agent_id) {
        Ok(r) => r,
        Err(Refus::Interne) => return interne(),
        Err(Refus::FiltresAvances) => {
            return json(
                StatusCode::NOT_IMPLEMENTED,
                &json!({ "detail": "filters avancés (opérateurs, AND/OR/NOT, listes, \"*\") non supportés par mem0-rs" }),
            );
        }
    };
    let Ok(vecteur) = etat.embedder.plonger(&requete.query).await.map_err(|e| eprintln!("mem0-rs : {e}")) else {
        return interne();
    };
    let Ok(resultats) = avec_base(&etat, move |conn| recherche::executer(conn, &requete, &vecteur)).await else {
        return interne();
    };
    let results: Vec<Ligne<'_>> = resultats
        .iter()
        .map(|r| Ligne {
            score: Some(r.details.final_score),
            score_details: explain.then_some(&r.details),
            ..Ligne::de(&r.souvenir)
        })
        .collect();
    json(StatusCode::OK, &ReponseRecherche { results })
}

#[derive(Serialize)]
struct ReponseGraphe {
    total: usize,
    threshold: f64,
    top_k: usize,
    edges: Vec<Arete>,
}

async fn graph(State(etat): Partage, entetes: HeaderMap) -> Response {
    if let Some(refus) = controle_jeton(&etat, &entetes) {
        return refus;
    }
    let Ok(points) = avec_base(&etat, |conn| db::vecteurs(conn, USER)).await else {
        return interne();
    };
    let total = points.len();
    // Calcul hors du verrou de la base et hors du runtime async.
    let Ok(edges) = tokio::task::spawn_blocking(move || graphe::aretes(points)).await else {
        return interne();
    };
    json(StatusCode::OK, &ReponseGraphe { total, threshold: GRAPH_THRESHOLD, top_k: GRAPH_TOP_K, edges })
}

/// Ligne de résultat (D-1, `MemoryItem.model_dump`) : `score` après `metadata`
/// pour la recherche seulement (`exclude={"score"}` pour all), `role` absent
/// et `attributed_to` présent pour un souvenir extrait (add infer=true), et
/// `score_details` en dernier avec `explain`.
#[derive(Serialize)]
struct Ligne<'a> {
    id: &'a str,
    memory: &'a str,
    hash: &'a str,
    metadata: Option<Metadata<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    score: Option<f64>,
    created_at: &'a str,
    updated_at: &'a str,
    user_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attributed_to: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    score_details: Option<&'a Details>,
}

impl<'a> Ligne<'a> {
    /// La ligne de GET /memory/all : sans score.
    fn de(s: &'a Souvenir) -> Self {
        Ligne {
            id: &s.id,
            memory: &s.memory,
            hash: &s.hash,
            metadata: Metadata::de(s),
            score: None,
            created_at: &s.created_at,
            updated_at: &s.updated_at,
            user_id: &s.user_id,
            agent_id: s.agent_id.as_deref(),
            run_id: s.run_id.as_deref(),
            role: s.role.as_deref(),
            attributed_to: s.attributed_to.as_ref(),
            score_details: None,
        }
    }
}

/// `metadata` d'une ligne (S-11, `MemoryItem.metadata`) : `tags` s'il est
/// présent, puis les clés de payload hors cœur ; `None` (null) si aucune.
struct Metadata<'a> {
    tags: Option<Option<&'a str>>,
    autres: Option<&'a serde_json::Map<String, serde_json::Value>>,
}

impl<'a> Metadata<'a> {
    fn de(s: &'a Souvenir) -> Option<Self> {
        let tags = s.tags.as_ref().map(Option::as_deref);
        let autres = s.metadata.as_ref();
        (tags.is_some() || autres.is_some()).then_some(Metadata { tags, autres })
    }
}

impl Serialize for Metadata<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        if let Some(tags) = self.tags {
            map.serialize_entry("tags", &tags)?;
        }
        for (cle, valeur) in self.autres.into_iter().flatten() {
            map.serialize_entry(cle, valeur)?;
        }
        map.end()
    }
}

#[derive(Serialize)]
struct ReponseAll<'a> {
    total: usize,
    results: Vec<Ligne<'a>>,
}

#[derive(Serialize)]
struct ReponseRecherche<'a> {
    results: Vec<Ligne<'a>>,
}

async fn all(State(etat): Partage, Query(parametres): Query<Vec<(String, String)>>, entetes: HeaderMap) -> Response {
    // Paramètre répété : le dernier l'emporte, comme starlette.
    let agent_id = parametres.into_iter().rev().find(|(k, _)| k == "agent_id").map(|(_, v)| v);
    if let Some(refus) = controle_jeton(&etat, &entetes) {
        return refus;
    }
    let Ok(agent_id) = portee(agent_id) else {
        return interne();
    };
    let Ok(souvenirs) = avec_base(&etat, move |conn| db::tous(conn, USER, agent_id.as_deref())).await else {
        return interne();
    };
    let results: Vec<Ligne<'_>> = souvenirs.iter().map(Ligne::de).collect();
    json(StatusCode::OK, &ReponseAll { total: results.len(), results })
}

async fn update(State(etat): Partage, memory_id: String, entetes: HeaderMap, corps: Bytes) -> Response {
    let req = match validation::update(content_type(&entetes), &corps) {
        Ok(r) => r,
        Err(r) => return rejet(r),
    };
    if let Some(refus) = controle_jeton(&etat, &entetes) {
        return refus;
    }
    let id = memory_id.clone();
    match avec_base(&etat, move |conn| db::existe(conn, &id)).await {
        Ok(true) => {}
        _ => return interne(),
    }
    let texte = masquer(&req.text);
    let Ok(vecteur) = etat.embedder.plonger(&texte).await.map_err(|e| eprintln!("mem0-rs : {e}")) else {
        return interne();
    };
    let tags = match req.tags {
        None => db::Tags::Inchangees,
        Some(v) => db::Tags::Remplacees(v),
    };
    let ecrit = avec_base(&etat, move |conn| {
        let instant = horodatage::maintenant();
        let hash = md5_hex(&texte);
        db::mettre_a_jour(conn, &memory_id, &texte, &hash, &tags, &vecteur, &instant)
    })
    .await;
    match ecrit {
        Ok(true) => json(StatusCode::OK, &json!({ "message": "Memory updated successfully!" })),
        _ => interne(),
    }
}

async fn delete(State(etat): Partage, memory_id: String, entetes: HeaderMap) -> Response {
    if let Some(refus) = controle_jeton(&etat, &entetes) {
        return refus;
    }
    let ecrit = avec_base(&etat, move |conn| db::supprimer(conn, &memory_id, &horodatage::maintenant())).await;
    match ecrit {
        Ok(true) => json(StatusCode::OK, &json!({ "message": "Memory deleted successfully!" })),
        _ => interne(),
    }
}

async fn history(State(etat): Partage, Path(memory_id): Path<String>, entetes: HeaderMap) -> Response {
    if let Some(refus) = controle_jeton(&etat, &entetes) {
        return refus;
    }
    match avec_base(&etat, move |conn| db::historique(conn, &memory_id)).await {
        Ok(lignes) => json(StatusCode::OK, &lignes),
        Err(()) => interne(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portee_comme_python() {
        assert_eq!(portee(None), Ok(None));
        assert_eq!(portee(Some(String::new())), Ok(None));
        assert_eq!(portee(Some("  a  ".into())), Ok(Some("a".into())));
        assert_eq!(portee(Some("\u{1c}a\u{a0}".into())), Ok(Some("a".into())));
        assert_eq!(portee(Some("   ".into())), Err(()));
        assert_eq!(portee(Some("a b".into())), Err(()));
        assert_eq!(portee(Some("a\u{1f}b".into())), Err(()));
    }

    #[test]
    fn jeton_compare_en_temps_constant() {
        assert!(egal_temps_constant(b"", b""));
        assert!(egal_temps_constant(b"s3cret", b"s3cret"));
        assert!(!egal_temps_constant(b"s3cret", b"s3creT"));
        assert!(!egal_temps_constant(b"Xs3cret", b"s3cret"));
        assert!(!egal_temps_constant(b"s3cre", b"s3cret"));
        assert!(!egal_temps_constant(b"", b"s"));
    }

    #[test]
    fn md5_minuscule() {
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex("a\0b"), format!("{:x}", Md5::digest(b"a\0b")));
    }

    fn cles(v: &serde_json::Value) -> Vec<&str> {
        v.as_object().unwrap().keys().map(String::as_str).collect()
    }

    #[test]
    fn ac1_ligne_souvenir_infere_sans_role_avec_attributed_to() {
        let classique = Souvenir {
            id: "i".into(),
            memory: "m".into(),
            hash: "h".into(),
            tags: None,
            created_at: "c".into(),
            updated_at: "u".into(),
            user_id: USER.into(),
            agent_id: Some("ag".into()),
            run_id: None,
            role: Some("user".into()),
            attributed_to: None,
            metadata: None,
        };
        // add infer=false : forme inchangée.
        let v = serde_json::to_value(Ligne::de(&classique)).unwrap();
        assert_eq!(cles(&v), ["id", "memory", "hash", "metadata", "created_at", "updated_at", "user_id", "agent_id", "role"]);
        assert_eq!(v["role"], "user");

        // add infer=true : pas de role, attributed_to (JSON quelconque) après run_id.
        let extrait = Souvenir {
            run_id: Some("r".into()),
            role: None,
            attributed_to: Some(json!({"qui": [1, "x"]})),
            ..classique.clone()
        };
        let v = serde_json::to_value(Ligne::de(&extrait)).unwrap();
        assert_eq!(
            cles(&v),
            ["id", "memory", "hash", "metadata", "created_at", "updated_at", "user_id", "agent_id", "run_id", "attributed_to"]
        );
        assert_eq!(v["attributed_to"], json!({"qui": [1, "x"]}));
        let v = serde_json::to_value(Ligne { score: Some(0.5), ..Ligne::de(&extrait) }).unwrap();
        assert_eq!(
            cles(&v),
            ["id", "memory", "hash", "metadata", "score", "created_at", "updated_at", "user_id", "agent_id", "run_id", "attributed_to"]
        );
        // Souvenir extrait sans attributed_to : ni role ni attributed_to.
        let nu = Souvenir { agent_id: None, run_id: None, role: None, attributed_to: None, ..classique };
        let v = serde_json::to_value(Ligne::de(&nu)).unwrap();
        assert_eq!(cles(&v), ["id", "memory", "hash", "metadata", "created_at", "updated_at", "user_id"]);
    }

    /// mem0-rs-migration S-11 (pré-requis de AC-1 et AC-2) : `metadata` des lignes
    /// all et search fusionne `tags` et les clés de payload importées.
    #[test]
    fn ac1_ac2_metadata_fusionne_tags_et_cles_importees() {
        let base = Souvenir {
            id: "i".into(),
            memory: "m".into(),
            hash: "h".into(),
            tags: None,
            created_at: "c".into(),
            updated_at: "u".into(),
            user_id: USER.into(),
            agent_id: None,
            run_id: None,
            role: Some("user".into()),
            attributed_to: None,
            metadata: None,
        };
        let importees = || json!({"memory_type": "procedural_memory", "n": {"a": [1]}}).as_object().cloned();
        let cas = [
            (base.clone(), json!(null)),
            (Souvenir { tags: Some(Some("a,b".into())), ..base.clone() }, json!({"tags": "a,b"})),
            (Souvenir { tags: Some(None), ..base.clone() }, json!({"tags": null})),
            (Souvenir { metadata: importees(), ..base.clone() }, json!({"memory_type": "procedural_memory", "n": {"a": [1]}})),
            (
                Souvenir { tags: Some(Some("t".into())), metadata: importees(), ..base.clone() },
                json!({"tags": "t", "memory_type": "procedural_memory", "n": {"a": [1]}}),
            ),
        ];
        for (s, attendu) in &cas {
            let all = serde_json::to_value(Ligne::de(s)).unwrap();
            let recherche = serde_json::to_value(Ligne { score: Some(0.5), ..Ligne::de(s) }).unwrap();
            for v in [&all, &recherche] {
                assert_eq!(&v["metadata"], attendu);
                if let Some(o) = attendu.as_object() {
                    let ordre: Vec<&str> = o.keys().map(String::as_str).collect();
                    assert_eq!(cles(&v["metadata"]), ordre, "tags d'abord, puis l'ordre du payload");
                }
            }
        }
    }
}
