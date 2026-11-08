//! Tests boîte noire des jetons à portées (politique par dépôt) : un jeton de
//! `MEM0_HTTP_TOKENS` n'ouvre que ses portées (200), tout le reste lui est refusé
//! (403) ; le jeton total `MEM0_HTTP_TOKEN` garde tous ses droits.

#[allow(dead_code, reason = "module partagé : chaque fichier de tests n'en utilise qu'une partie")]
mod common;

use common::{Dossier, FauxOpenAI, Lancement, Reponse, Serveur};
use serde_json::{Value, json};

const TOTAL: &str = "jeton-total-de-test";
const CORPO: &str = "jeton-corpo-0123456789";
const PERSO: &str = "jeton-perso-0123456789";

/// Le serveur et ses dépendances : le serveur tombe avant son dossier.
struct Banc {
    serveur: Serveur,
    _faux: FauxOpenAI,
    _dossier: Dossier,
}

async fn banc(nom: &str, env: &[(&str, &str)]) -> Banc {
    let faux = FauxOpenAI::demarrer().await;
    let dossier = Dossier::nouveau(nom);
    let serveur = Serveur::demarrer_avec(
        &Lancement { base: &dossier.base(), embedder_url: &faux.base_url, jeton: TOTAL, installation: "" },
        env,
    )
    .await;
    Banc { serveur, _faux: faux, _dossier: dossier }
}

/// Une requête JSON sous le jeton `jeton`.
async fn sous(s: &Serveur, jeton: &str, methode: &str, chemin: &str, corps: Option<Value>) -> Reponse {
    let texte = corps.map(|c| c.to_string());
    s.envoyer(methode, chemin, texte.as_deref(), &[("content-type", "application/json"), ("X-Mem0-Token", jeton)]).await
}

/// add infer=false sous `jeton` ; rend l'id (200 exigé).
async fn ajouter(s: &Serveur, jeton: &str, agent: &str, texte: &str) -> String {
    let r = sous(s, jeton, "POST", "/memory/add", Some(json!({ "text": texte, "agent_id": agent, "infer": false }))).await;
    assert_eq!(r.statut, 200, "add {agent} : {}", r.texte);
    r.json()["results"][0]["id"].as_str().unwrap().to_owned()
}

fn refuse(r: &Reponse, quoi: &str) {
    assert_eq!(r.statut, 403, "{quoi} aurait dû être refusé : {}", r.texte);
    assert!(r.json()["detail"].as_str().unwrap().contains("corpo"), "{quoi} : le refus nomme le jeton");
}

#[tokio::test(flavor = "multi_thread")]
async fn jeton_a_portees_200_dans_ses_portees() {
    let b = banc("jetons-dans", &[("MEM0_HTTP_TOKENS", &format!("corpo:{CORPO}:corpo-api,corpo-web;perso:{PERSO}:perso"))])
        .await;
    let s = &b.serveur;
    let id = ajouter(s, CORPO, "corpo-api", "le déploiement passe par la recette").await;
    ajouter(s, CORPO, "corpo-web", "le front parle à l'API par un proxy").await;
    let r = sous(s, CORPO, "POST", "/memory/search", Some(json!({ "query": "déploiement", "agent_id": "corpo-api" }))).await;
    assert_eq!(r.statut, 200, "{}", r.texte);
    assert_eq!(r.json()["results"][0]["id"], id.as_str());
    let r = sous(s, CORPO, "GET", "/memory/all?agent_id=corpo-api", None).await;
    assert_eq!((r.statut, r.json()["total"].as_u64()), (200, Some(1)));
    let r = sous(s, CORPO, "PUT", &format!("/memory/{id}"), Some(json!({ "text": "la recette précède la prod" }))).await;
    assert_eq!(r.statut, 200, "{}", r.texte);
    assert_eq!(sous(s, CORPO, "GET", &format!("/memory/{id}/history"), None).await.statut, 200);
    assert_eq!(sous(s, CORPO, "GET", &format!("/memory/{id}/links"), None).await.statut, 200);
    assert_eq!(sous(s, CORPO, "GET", "/memory/entities?agent_id=corpo-web", None).await.statut, 200);
    assert_eq!(sous(s, CORPO, "DELETE", &format!("/memory/{id}"), None).await.statut, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn jeton_a_portees_403_hors_de_ses_portees() {
    let b = banc("jetons-hors", &[("MEM0_HTTP_TOKENS", &format!("corpo:{CORPO}:corpo-api;perso:{PERSO}:perso"))]).await;
    let s = &b.serveur;
    let perso = ajouter(s, PERSO, "perso", "mon vélo est un gravel").await;
    let corpo = ajouter(s, CORPO, "corpo-api", "la base est un Postgres 16").await;
    // Une autre portée, nommée.
    refuse(
        &sous(s, CORPO, "POST", "/memory/add", Some(json!({ "text": "x", "agent_id": "perso", "infer": false }))).await,
        "add dans perso",
    );
    refuse(&sous(s, CORPO, "POST", "/memory/search", Some(json!({ "query": "vélo", "agent_id": "perso" }))).await, "search perso");
    refuse(&sous(s, CORPO, "GET", "/memory/all?agent_id=perso", None).await, "all perso");
    refuse(&sous(s, CORPO, "GET", "/memory/links?agent_id=perso", None).await, "links perso");
    refuse(&sous(s, CORPO, "GET", "/memory/dream/dossier?agent_id=perso", None).await, "dossier perso");
    // Toutes les portées à la fois.
    refuse(&sous(s, CORPO, "POST", "/memory/search", Some(json!({ "query": "vélo" }))).await, "search sans agent_id");
    refuse(&sous(s, CORPO, "GET", "/memory/all", None).await, "all sans agent_id");
    refuse(&sous(s, CORPO, "GET", "/memory/graph", None).await, "graph");
    refuse(&sous(s, CORPO, "POST", "/memory/dream", Some(json!({}))).await, "rêve de toutes les portées");
    // Un souvenir d'une autre portée, ou inconnu.
    refuse(&sous(s, CORPO, "PUT", &format!("/memory/{perso}"), Some(json!({ "text": "volé" }))).await, "put perso");
    refuse(&sous(s, CORPO, "DELETE", &format!("/memory/{perso}"), None).await, "delete perso");
    refuse(&sous(s, CORPO, "GET", &format!("/memory/{perso}/history"), None).await, "history perso");
    refuse(&sous(s, CORPO, "GET", &format!("/memory/{perso}/links"), None).await, "links du souvenir perso");
    refuse(
        &sous(s, CORPO, "POST", "/memory/link", Some(json!({ "source": corpo, "target": perso, "type": "voir" }))).await,
        "lien vers perso",
    );
    refuse(&sous(s, CORPO, "DELETE", "/memory/inconnu", None).await, "souvenir inconnu");
    // Rien n'a bougé chez perso.
    let r = sous(s, PERSO, "GET", "/memory/all?agent_id=perso", None).await;
    assert_eq!(r.json()["results"][0]["memory"], "mon vélo est un gravel");
    // Un jeton inconnu reste un 401.
    assert_eq!(sous(s, "jeton-inconnu-0000000", "GET", "/memory/all?agent_id=perso", None).await.statut, 401);
}

/// `/metrics` compte toutes les portées : le jeton total seul l'ouvre, en `X-Mem0-Token` ou en
/// `Authorization: Bearer` ; un jeton à portées y est refusé (403), par l'une ou l'autre voie.
#[tokio::test(flavor = "multi_thread")]
async fn metriques_au_seul_jeton_total() {
    let b = banc("jetons-metriques", &[("MEM0_HTTP_TOKENS", &format!("corpo:{CORPO}:corpo-api"))]).await;
    let s = &b.serveur;
    let porteur = |jeton: &str| format!("Bearer {jeton}");
    assert_eq!(s.envoyer("GET", "/metrics", None, &[("X-Mem0-Token", TOTAL)]).await.statut, 200);
    assert_eq!(s.envoyer("GET", "/metrics", None, &[("authorization", &porteur(TOTAL))]).await.statut, 200);
    refuse(&s.envoyer("GET", "/metrics", None, &[("X-Mem0-Token", CORPO)]).await, "/metrics en X-Mem0-Token");
    refuse(&s.envoyer("GET", "/metrics", None, &[("authorization", &porteur(CORPO))]).await, "/metrics en Bearer");
    assert_eq!(s.envoyer("GET", "/metrics", None, &[]).await.statut, 401);
}

#[tokio::test(flavor = "multi_thread")]
async fn jeton_total_inchange() {
    let b = banc("jetons-total", &[("MEM0_HTTP_TOKENS", &format!("corpo:{CORPO}:corpo-api"))]).await;
    let s = &b.serveur;
    let corpo = ajouter(s, CORPO, "corpo-api", "la base est un Postgres 16").await;
    let perso = ajouter(s, TOTAL, "perso", "mon vélo est un gravel").await;
    let r = s.appeler("GET", "/memory/all", None).await;
    assert_eq!((r.statut, r.json()["total"].as_u64()), (200, Some(2)));
    assert_eq!(s.appeler("GET", "/memory/graph", None).await.statut, 200);
    assert_eq!(s.appeler("POST", "/memory/search", Some(&json!({ "query": "base" }))).await.statut, 200);
    let lien = json!({ "source": corpo, "target": perso, "type": "voir" });
    assert_eq!(s.appeler("POST", "/memory/link", Some(&lien)).await.statut, 200);
    assert_eq!(s.appeler("DELETE", &format!("/memory/{corpo}"), None).await.statut, 200);
    assert_eq!(s.appeler("GET", &format!("/memory/{corpo}/history"), None).await.statut, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn jetons_illisibles_refusent_le_demarrage() {
    let faux = FauxOpenAI::demarrer().await;
    let dossier = Dossier::nouveau("jetons-illisibles");
    // La configuration est lue avant l'écoute : le port n'est jamais ouvert.
    let sortie = std::process::Command::new(env!("CARGO_BIN_EXE_mem0-rs"))
        .args(["--host", "127.0.0.1", "--port", "65000"])
        .env("OMLX_BASE_URL", &faux.base_url)
        .env("MEM0_DB_PATH", dossier.base())
        .env("MEM0_HTTP_TOKENS", "corpo:court:corpo")
        .output()
        .expect("lancement de mem0-rs");
    assert_eq!(sortie.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&sortie.stderr).contains("MEM0_HTTP_TOKENS"));
}
