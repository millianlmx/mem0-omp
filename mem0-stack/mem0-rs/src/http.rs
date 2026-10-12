//! Surface HTTP (S-2 à S-5, S-7) : les 9 routes du Python, le jeton après la
//! validation, et les corps d'erreur exacts de FastAPI/starlette (D-6).

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
use serde_json::json;

use crate::config::{blanc_python, strip_python};
use crate::db::{self, Souvenir};
use crate::embedder::Embedder;
use crate::graphe::{self, Arete, GRAPH_THRESHOLD, GRAPH_TOP_K};
use crate::horodatage;
use crate::recherche::{self, Details, Refus};
use crate::validation::{self, Rejet};

/// Utilisateur fixe (memory_config.py:51).
pub const USER: &str = "moi";

/// État partagé par les routes.
pub struct Etat {
    pub db: Arc<Mutex<Connection>>,
    pub embedder: Embedder,
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
    .layer(DefaultBodyLimit::disable())
    .with_state(etat)
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
        || entetes.get("x-mem0-token").is_some_and(|v| v.as_bytes() == etat.http_token.as_bytes())
    {
        return None;
    }
    Some(json(StatusCode::UNAUTHORIZED, &json!({ "detail": "bad or missing X-Mem0-Token" })))
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
    if req.infer {
        return json(
            StatusCode::NOT_IMPLEMENTED,
            &json!({ "detail": "infer=true n'est pas encore supporté par mem0-rs" }),
        );
    }
    let (Ok(agent_id), Ok(run_id)) = (portee(req.agent_id), portee(req.run_id)) else {
        return interne();
    };
    let tags = req.tags.filter(|t| !t.is_empty());
    ajouter(&etat, req.text, agent_id, run_id, tags).await
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
    ajouter(&etat, req.steps, agent_id, None, None).await
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
                    role: "user",
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
/// pour la recherche seulement (`exclude={"score"}` pour all), et
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
    role: &'a str,
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
            metadata: s.tags.as_ref().map(|t| Metadata { tags: t.as_deref() }),
            score: None,
            created_at: &s.created_at,
            updated_at: &s.updated_at,
            user_id: &s.user_id,
            agent_id: s.agent_id.as_deref(),
            run_id: s.run_id.as_deref(),
            role: &s.role,
            score_details: None,
        }
    }
}

#[derive(Serialize)]
struct Metadata<'a> {
    tags: Option<&'a str>,
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
    let Ok(vecteur) = etat.embedder.plonger(&req.text).await.map_err(|e| eprintln!("mem0-rs : {e}")) else {
        return interne();
    };
    let tags = match req.tags {
        None => db::Tags::Inchangees,
        Some(v) => db::Tags::Remplacees(v),
    };
    let ecrit = avec_base(&etat, move |conn| {
        let instant = horodatage::maintenant();
        let hash = md5_hex(&req.text);
        db::mettre_a_jour(conn, &memory_id, &req.text, &hash, &tags, &vecteur, &instant)
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
    fn md5_minuscule() {
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex("a\0b"), format!("{:x}", Md5::digest(b"a\0b")));
    }
}
