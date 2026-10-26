//! Routes propres à mem0-rs (memoire-liee, reve-memoire) : liens entre
//! souvenirs, entités, mental models, rêve local et consolidation.
//!
//! Hors du contrat de l'ancien mem0-http : les erreurs y sont plus simples —
//! 422 `{"detail": "<raison>"}` pour un corps invalide, 404 pour un id inconnu,
//! 409 pour une proposition déjà décidée. Le jeton `X-Mem0-Token` est exigé
//! comme partout, après la lecture du corps.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::consolidation::{self, Consolidation};
use crate::horodatage;
use crate::http::{Partage, USER, avec_base, controle_jeton, interne, json, portee};
use crate::liens::{self, Lien, TYPES_AGENT};
use crate::redaction::masquer;
use crate::reve::{self, Decision};

/// Corps JSON → `T`, ou 422 `{"detail": …}`.
fn corps<T: DeserializeOwned>(octets: &Bytes) -> Result<T, Box<Response>> {
    serde_json::from_slice(octets).map_err(|e| {
        Box::new(json(StatusCode::UNPROCESSABLE_ENTITY, &json!({ "detail": format!("corps invalide : {e}") })))
    })
}

fn refus(statut: StatusCode, detail: impl Into<String>) -> Response {
    json(statut, &json!({ "detail": detail.into() }))
}

/// `agent_id` d'une requête GET (le dernier l'emporte), contrôlé comme une portée.
fn agent_de(parametres: &[(String, String)]) -> Result<Option<String>, ()> {
    portee(parametres.iter().rev().find(|(k, _)| k == "agent_id").map(|(_, v)| v.clone()))
}

fn parametre<'a>(parametres: &'a [(String, String)], nom: &str) -> Option<&'a str> {
    parametres.iter().rev().find(|(k, _)| k == nom).map(|(_, v)| v.as_str())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpsLien {
    source: String,
    target: String,
    #[serde(rename = "type")]
    type_: String,
    #[serde(default)]
    reason: Option<String>,
}

/// `POST /memory/link` : un agent relie deux souvenirs (`cause`, `remplace`,
/// `contredit`, `precise`, `voir`). Rend le lien posé.
pub async fn lier(State(etat): Partage, entetes: HeaderMap, octets: Bytes) -> Response {
    let c: CorpsLien = match corps(&octets) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    if !TYPES_AGENT.contains(&c.type_.as_str()) {
        return refus(StatusCode::UNPROCESSABLE_ENTITY, format!("type : {} attendu", TYPES_AGENT.join(", ")));
    }
    if c.source == c.target {
        return refus(StatusCode::UNPROCESSABLE_ENTITY, "source et target doivent différer");
    }
    let lien = Lien {
        source: c.source,
        target: c.target,
        type_: c.type_,
        weight: 1.0,
        origin: "agent".to_owned(),
        reason: c.reason.map(|r| masquer(r.trim())).filter(|r| !r.is_empty()),
        created_at: horodatage::maintenant().iso,
    };
    let ecrit = avec_base(&etat, move |conn| {
        for id in [&lien.source, &lien.target] {
            if !crate::db::existe(conn, id)? {
                return Ok(Err(id.clone()));
            }
        }
        liens::lier(conn, &lien)?;
        Ok(Ok(lien))
    })
    .await;
    match ecrit {
        Ok(Ok(lien)) => json(StatusCode::OK, &json!({ "link": lien })),
        Ok(Err(id)) => refus(StatusCode::NOT_FOUND, format!("souvenir inconnu : {id}")),
        Err(()) => interne(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpsDelier {
    source: String,
    target: String,
    #[serde(rename = "type")]
    type_: String,
}

/// `POST /memory/unlink` : retire un lien ; `{"removed": bool}`.
pub async fn delier(State(etat): Partage, entetes: HeaderMap, octets: Bytes) -> Response {
    let c: CorpsDelier = match corps(&octets) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    match avec_base(&etat, move |conn| liens::delier(conn, &c.source, &c.target, &c.type_)).await {
        Ok(retire) => json(StatusCode::OK, &json!({ "removed": retire })),
        Err(()) => interne(),
    }
}

/// `GET /memory/links?agent_id=…[&semantic=true]` : les liens de la portée
/// (typés, et `semantique` avec `semantic=true`).
pub async fn liens_portee(State(etat): Partage, Query(p): Query<Vec<(String, String)>>, entetes: HeaderMap) -> Response {
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    let Ok(agent_id) = agent_de(&p) else { return interne() };
    let semantiques = parametre(&p, "semantic") == Some("true");
    match avec_base(&etat, move |conn| liens::liens_portee(conn, USER, agent_id.as_deref(), semantiques)).await {
        Ok(l) => json(StatusCode::OK, &json!({ "total": l.len(), "links": l })),
        Err(()) => interne(),
    }
}

/// `GET /memory/{id}/links` : les liens typés d'un souvenir, avec le texte de
/// l'autre bout, et ses entités.
pub async fn liens_souvenir(State(etat): Partage, Path(id): Path<String>, entetes: HeaderMap) -> Response {
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    let lu = avec_base(&etat, move |conn| {
        if !crate::db::existe(conn, &id)? {
            return Ok(None);
        }
        let vus = liens::liens_vus(conn, &[&id])?.remove(&id).unwrap_or_default();
        let mut texte = conn.prepare_cached("SELECT memory FROM memories WHERE id = ?1")?;
        let mut lignes = Vec::with_capacity(vus.len());
        for l in vus {
            let memoire: Option<String> = rusqlite::OptionalExtension::optional(texte.query_row([&l.id], |r| r.get(0)))?;
            let mut v = serde_json::to_value(&l).unwrap_or(Value::Null);
            v["memory"] = json!(memoire);
            lignes.push(v);
        }
        let entites = liens::entites_de(conn, &[&id])?.remove(&id).unwrap_or_default();
        Ok(Some(json!({ "id": id, "entities": entites, "links": lignes })))
    })
    .await;
    match lu {
        Ok(Some(v)) => json(StatusCode::OK, &v),
        Ok(None) => refus(StatusCode::NOT_FOUND, "souvenir inconnu"),
        Err(()) => interne(),
    }
}

/// `GET /memory/entities?agent_id=…` : les entités de la portée, les plus portées d'abord.
pub async fn entites(State(etat): Partage, Query(p): Query<Vec<(String, String)>>, entetes: HeaderMap) -> Response {
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    let Ok(agent_id) = agent_de(&p) else { return interne() };
    match avec_base(&etat, move |conn| liens::entites_portee(conn, USER, agent_id.as_deref())).await {
        Ok(e) => json(StatusCode::OK, &json!({ "total": e.len(), "entities": e })),
        Err(()) => interne(),
    }
}

/// `GET /memory/models?agent_id=…` : les mental models de la portée.
pub async fn modeles(State(etat): Partage, Query(p): Query<Vec<(String, String)>>, entetes: HeaderMap) -> Response {
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    let Ok(agent_id) = agent_de(&p) else { return interne() };
    match avec_base(&etat, move |conn| consolidation::modeles(conn, USER, agent_id.as_deref())).await {
        Ok(m) => json(StatusCode::OK, &json!({ "models": m })),
        Err(()) => interne(),
    }
}

/// `GET /memory/dream?agent_id=…` : les derniers rêves de la portée et ses
/// propositions ouvertes.
pub async fn journal(State(etat): Partage, Query(p): Query<Vec<(String, String)>>, entetes: HeaderMap) -> Response {
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    let Ok(agent_id) = agent_de(&p) else { return interne() };
    let cle = liens::cle_portee(agent_id.as_deref()).to_owned();
    let lu = avec_base(&etat, move |conn| {
        Ok(json!({
            "dreams": reve::journal(conn, &cle, 10)?,
            "proposals": reve::propositions(conn, &cle, "ouverte", 50)?,
        }))
    })
    .await;
    match lu {
        Ok(v) => json(StatusCode::OK, &v),
        Err(()) => interne(),
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct CorpsReve {
    #[serde(default)]
    agent_id: Option<String>,
}

/// `POST /memory/dream` : un rêve local maintenant, sur la portée `agent_id`
/// (toutes les portées s'il est absent), sans attendre le calme. Rend les rapports.
pub async fn rever(State(etat): Partage, entetes: HeaderMap, octets: Bytes) -> Response {
    let c: CorpsReve = if octets.is_empty() {
        CorpsReve::default()
    } else {
        match corps(&octets) {
            Ok(c) => c,
            Err(r) => return *r,
        }
    };
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    let Ok(agent_id) = portee(c.agent_id) else { return interne() };
    let cibles = match agent_id {
        Some(a) => vec![a],
        None => match avec_base(&etat, |conn| reve::portees(conn)).await {
            Ok(p) => p,
            Err(()) => return interne(),
        },
    };
    let mut rapports = Vec::with_capacity(cibles.len());
    for p in cibles {
        match reve::rever_portee(&etat.db, &etat.chat, &etat.reve, &p).await {
            Ok(r) => rapports.push(r),
            Err(e) => {
                eprintln!("mem0-rs : rêve de « {p} » impossible : {e}");
                return interne();
            }
        }
    }
    json(StatusCode::OK, &json!({ "dreams": rapports }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpsDecision {
    id: String,
    decision: String,
}

/// `POST /memory/dream/proposal` `{"id", "decision": "accept"|"reject"}` :
/// accepter applique la suppression proposée (s'il y en a une).
pub async fn decider(State(etat): Partage, entetes: HeaderMap, octets: Bytes) -> Response {
    let c: CorpsDecision = match corps(&octets) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    let accepter = match c.decision.as_str() {
        "accept" => true,
        "reject" => false,
        _ => return refus(StatusCode::UNPROCESSABLE_ENTITY, "decision : accept ou reject"),
    };
    let id = c.id.clone();
    match avec_base(&etat, move |conn| reve::decider(conn, &id, accepter, &horodatage::maintenant())).await {
        Ok(Decision::Faite(supprime)) => json(
            StatusCode::OK,
            &json!({ "id": c.id, "status": if accepter { "acceptee" } else { "refusee" }, "deleted": supprime }),
        ),
        Ok(Decision::Inconnue) => refus(StatusCode::NOT_FOUND, format!("proposition inconnue : {}", c.id)),
        Ok(Decision::DejaClose(statut)) => refus(StatusCode::CONFLICT, format!("proposition déjà {statut}")),
        Err(()) => interne(),
    }
}

/// `GET /memory/dream/dossier?agent_id=…` : ce que la session de consolidation
/// (phases 3 et 4, menée par le harness) doit lire.
pub async fn dossier(State(etat): Partage, Query(p): Query<Vec<(String, String)>>, entetes: HeaderMap) -> Response {
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    let Ok(agent_id) = agent_de(&p) else { return interne() };
    match avec_base(&etat, move |conn| consolidation::dossier(conn, USER, agent_id.as_deref())).await {
        Ok(d) => json(StatusCode::OK, &d),
        Err(()) => interne(),
    }
}

/// `POST /memory/dream/consolidation` : applique le résultat de la session de
/// consolidation (observations, retraits, causes, mental models) en une transaction.
pub async fn consolider(State(etat): Partage, entetes: HeaderMap, octets: Bytes) -> Response {
    let mut c: Consolidation = match corps(&octets) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    if let Some(r) = controle_jeton(&etat, &entetes) {
        return r;
    }
    let Ok(agent_id) = portee(c.agent_id.take()) else { return interne() };
    c.agent_id = agent_id;
    let c = Arc::new(c);
    let controle = {
        let c = Arc::clone(&c);
        avec_base(&etat, move |conn| Ok(consolidation::valider(conn, USER, &c))).await
    };
    match controle {
        Ok(Ok(())) => {}
        Ok(Err(raison)) => return refus(StatusCode::UNPROCESSABLE_ENTITY, raison),
        Err(()) => return interne(),
    }
    let textes = consolidation::textes(&c);
    let vecteurs = if textes.is_empty() {
        Vec::new()
    } else {
        match etat.embedder.plonger_lot(&textes).await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("mem0-rs : consolidation : {e}");
                return interne();
            }
        }
    };
    let ecrit = avec_base(&etat, move |conn| {
        // Revalidée sous le verrou : la base a pu changer pendant l'embedding.
        if let Err(raison) = consolidation::valider(conn, USER, &c) {
            return Ok(Err(raison));
        }
        Ok(Ok(consolidation::appliquer(conn, USER, &c, &vecteurs, &horodatage::maintenant())?))
    })
    .await;
    match ecrit {
        Ok(Ok(rapport)) => json(StatusCode::OK, &rapport),
        Ok(Err(raison)) => refus(StatusCode::CONFLICT, raison),
        Err(()) => interne(),
    }
}
