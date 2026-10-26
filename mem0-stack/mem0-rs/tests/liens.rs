//! Tests boîte noire des routes propres à mem0-rs : graphe de liens
//! (memoire-liee) et rêve de la mémoire (reve-memoire). Chaque test lance le
//! vrai binaire sur un port libre, branché sur un faux serveur OpenAI.

#[allow(dead_code, reason = "module partagé : chaque fichier de tests n'en utilise qu'une partie")]
mod common;

use common::{Dossier, FauxOpenAI, Lancement, Reponse, ReponseChat, Serveur};
use serde_json::{Value, json};

const AGENT: &str = "projet-liens";

struct Banc {
    serveur: Serveur,
    faux: FauxOpenAI,
    _dossier: Dossier,
}

async fn banc(nom: &str) -> Banc {
    let faux = FauxOpenAI::demarrer().await;
    let dossier = Dossier::nouveau(nom);
    let serveur =
        Serveur::demarrer(&Lancement { base: &dossier.base(), embedder_url: &faux.base_url, jeton: "", installation: "" })
            .await;
    Banc { serveur, faux, _dossier: dossier }
}

fn ok(r: &Reponse) -> Value {
    assert_eq!(r.statut, 200, "réponse : {}", r.texte);
    r.json()
}

async fn ajouter(s: &Serveur, texte: &str) -> String {
    let r = ok(&s.appeler("POST", "/memory/add", Some(&json!({"text": texte, "agent_id": AGENT, "infer": false}))).await);
    r["results"][0]["id"].as_str().unwrap().to_owned()
}

async fn chercher(s: &Serveur, corps: Value) -> Vec<Value> {
    ok(&s.appeler("POST", "/memory/search", Some(&corps)).await)["results"].as_array().unwrap().clone()
}

fn ids(lignes: &[Value]) -> Vec<&str> {
    lignes.iter().map(|l| l["id"].as_str().unwrap()).collect()
}

fn cles(v: &Value) -> Vec<&str> {
    v.as_object().unwrap().keys().map(String::as_str).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn liens_poses_vus_puis_retires() {
    let b = banc("liens").await;
    let s = &b.serveur;
    let effet = ajouter(s, "Le rappel automatique ralentissait chaque tour de vingt secondes.").await;
    let cause = ajouter(s, "Cause racine : recall.ts attendait l'embedding sans budget de temps.").await;

    // Type hors liste, boucle, corps illisible : 422 ; id inconnu : 404.
    for corps in [
        json!({"source": cause, "target": effet, "type": "semantique"}),
        json!({"source": cause, "target": cause, "type": "cause"}),
        json!({"source": cause, "target": effet}),
    ] {
        assert_eq!(s.appeler("POST", "/memory/link", Some(&corps)).await.statut, 422, "{corps}");
    }
    let r = s.appeler("POST", "/memory/link", Some(&json!({"source": cause, "target": "inconnu", "type": "cause"}))).await;
    assert_eq!((r.statut, r.json()["detail"].as_str()), (404, Some("souvenir inconnu : inconnu")));

    let pose = ok(&s
        .appeler("POST", "/memory/link", Some(&json!({"source": cause, "target": effet, "type": "cause", "reason": "  diagnostic  "})))
        .await);
    assert_eq!(pose["link"]["type"], "cause");
    assert_eq!(pose["link"]["origin"], "agent");
    assert_eq!(pose["link"]["reason"], "diagnostic");

    // Vu depuis l'effet : un lien entrant, avec le texte de la cause et les entités.
    let vu = ok(&s.appeler("GET", &format!("/memory/{effet}/links"), None).await);
    assert_eq!(vu["links"].as_array().unwrap().len(), 1);
    assert_eq!(vu["links"][0]["id"], cause.as_str());
    assert_eq!(vu["links"][0]["direction"], "in");
    assert!(vu["links"][0]["memory"].as_str().unwrap().starts_with("Cause racine"));
    let vu_cause = ok(&s.appeler("GET", &format!("/memory/{cause}/links"), None).await);
    assert_eq!(vu_cause["entities"], json!(["recall.ts"]));
    assert_eq!(s.appeler("GET", "/memory/inconnu/links", None).await.statut, 404);

    // La recherche ne rend les liens qu'avec `links: true`.
    let sans = chercher(s, json!({"query": "rappel automatique", "agent_id": AGENT})).await;
    assert!(sans.iter().all(|l| !cles(l).contains(&"links")));
    let avec = chercher(s, json!({"query": "rappel automatique", "agent_id": AGENT, "links": true, "threshold": 0})).await;
    let ligne = avec.iter().find(|l| l["id"] == effet.as_str()).unwrap();
    assert_eq!(ligne["links"][0]["type"], "cause");
    assert_eq!(cles(ligne).last(), Some(&"links"));

    let portee = ok(&s.appeler("GET", &format!("/memory/links?agent_id={AGENT}"), None).await);
    assert_eq!(portee["total"], 1);
    assert_eq!(ok(&s.appeler("GET", "/memory/entities", None).await)["entities"][0]["key"], "recall.ts");

    let r = ok(&s.appeler("POST", "/memory/unlink", Some(&json!({"source": cause, "target": effet, "type": "cause"}))).await);
    assert_eq!(r["removed"], true);
    assert_eq!(ok(&s.appeler("GET", &format!("/memory/links?agent_id={AGENT}"), None).await)["total"], 0);

    // Une suppression emporte les liens du souvenir.
    ok(&s.appeler("POST", "/memory/link", Some(&json!({"source": cause, "target": effet, "type": "voir"}))).await);
    ok(&s.appeler("DELETE", &format!("/memory/{cause}"), None).await);
    assert!(ok(&s.appeler("GET", &format!("/memory/{effet}/links"), None).await)["links"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn fusion_graphe_atteint_le_souvenir_relie_sous_le_seuil() {
    let b = banc("graphe").await;
    let s = &b.serveur;
    let effet = ajouter(s, "Le rappel automatique ralentissait chaque tour quand le serveur était froid.").await;
    let cause = ajouter(s, "Diagnostic : recall.ts attendait l'embedding sans budget de temps ; correctif posé.").await;
    for i in 0..5 {
        ajouter(s, &format!("Souvenir sans rapport numéro {i} sur la boutique et ses paniers.")).await;
    }
    ok(&s.appeler("POST", "/memory/link", Some(&json!({"source": cause, "target": effet, "type": "cause"}))).await);
    let corps = |fusion: &str| {
        json!({"query": "rappel automatique lent", "agent_id": AGENT, "threshold": 0.3, "explain": true, "fusion": fusion, "limit": 5})
    };
    let rrf = chercher(s, corps("rrf")).await;
    assert!(!ids(&rrf).contains(&cause.as_str()), "le RRF ne relie rien : {rrf:?}");
    let graphe = chercher(s, corps("graphe")).await;
    assert_eq!(ids(&graphe)[0], effet);
    let ligne = graphe.iter().find(|l| l["id"] == cause.as_str()).expect("la cause, atteinte par le lien");
    let d = &ligne["score_details"];
    assert!(d["semantic_score"].as_f64().unwrap() < 0.3, "{d}");
    assert!(d["entity_boost"].as_f64().unwrap() >= 0.7, "{d}");
    assert_eq!(cles(d), ["semantic_score", "bm25_score", "entity_boost", "raw_score", "max_possible_score", "final_score", "threshold"]);
    // Une recherche compte un rappel pour chaque souvenir rendu (lu par le rêve) :
    // rien de visible ici, sinon que la route reste un succès.
    assert!(b.faux.appels() > 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn reve_local_juge_les_paires_et_propose_sans_supprimer() {
    let b = banc("reve").await;
    let s = &b.serveur;
    let ancien = ajouter(s, "le port par défaut de mem0-rs est 8321").await;
    let recent = ajouter(s, "le port par défaut de mem0-rs est 8322").await;
    let autre = ajouter(s, "la boutique est réindexée chaque nuit").await;
    b.faux.scripter(vec![ReponseChat::Contenu(
        r#"{"verdict":"remplace","garder":"B","raison":"la valeur du port a changé"}"#.to_owned(),
    )]);
    let r = ok(&s.appeler("POST", "/memory/dream", Some(&json!({"agent_id": AGENT}))).await);
    let rapport = &r["dreams"][0];
    assert_eq!(rapport["agent_id"], AGENT);
    assert_eq!((rapport["pairs_judged"].as_u64(), rapport["proposals"].as_u64(), rapport["links"].as_u64()), (Some(1), Some(1), Some(1)));
    assert_eq!(b.faux.requetes_chat().len(), 1);
    let invite = b.faux.requetes_chat()[0]["messages"][1]["content"].as_str().unwrap().to_owned();
    assert!(invite.contains("8321") && invite.contains("8322"), "{invite}");

    // Rien n'est supprimé avant la décision ; la proposition nomme l'ancien.
    let all = ok(&s.appeler("GET", &format!("/memory/all?agent_id={AGENT}"), None).await);
    assert_eq!(all["total"], 3);
    let journal = ok(&s.appeler("GET", &format!("/memory/dream?agent_id={AGENT}"), None).await);
    let proposition = &journal["proposals"][0];
    assert_eq!(proposition["kind"], "remplace");
    assert_eq!(proposition["delete"], ancien.as_str());
    assert_eq!(proposition["memories"].as_array().unwrap().len(), 2);
    assert_eq!(journal["dreams"][0]["kind"], "local");
    let vu = ok(&s.appeler("GET", &format!("/memory/{recent}/links"), None).await);
    assert_eq!((vu["links"][0]["type"].as_str(), vu["links"][0]["origin"].as_str()), (Some("remplace"), Some("reve")));

    // Un nouveau rêve ne rejuge pas la paire (proposition ouverte).
    let r = ok(&s.appeler("POST", "/memory/dream", Some(&json!({"agent_id": AGENT}))).await);
    assert_eq!(r["dreams"][0]["pairs_judged"], 0);

    let id = proposition["id"].as_str().unwrap();
    assert_eq!(s.appeler("POST", "/memory/dream/proposal", Some(&json!({"id": id, "decision": "peut-être"}))).await.statut, 422);
    assert_eq!(s.appeler("POST", "/memory/dream/proposal", Some(&json!({"id": "x", "decision": "accept"}))).await.statut, 404);
    let d = ok(&s.appeler("POST", "/memory/dream/proposal", Some(&json!({"id": id, "decision": "accept"}))).await);
    assert_eq!((d["status"].as_str(), d["deleted"].as_bool()), (Some("acceptee"), Some(true)));
    assert_eq!(s.appeler("POST", "/memory/dream/proposal", Some(&json!({"id": id, "decision": "reject"}))).await.statut, 409);
    let all = ok(&s.appeler("GET", &format!("/memory/all?agent_id={AGENT}"), None).await);
    let restants: Vec<&str> = all["results"].as_array().unwrap().iter().map(|l| l["id"].as_str().unwrap()).collect();
    assert!(!restants.contains(&ancien.as_str()) && restants.contains(&recent.as_str()) && restants.contains(&autre.as_str()));
    // L'ancien est historisé comme toute suppression.
    let h = ok(&s.appeler("GET", &format!("/memory/{ancien}/history"), None).await);
    assert_eq!(h.as_array().unwrap().last().unwrap()["event"], "DELETE");
}

#[tokio::test(flavor = "multi_thread")]
async fn reve_local_llm_injoignable_journalise_l_erreur() {
    let b = banc("reve-erreur").await;
    let s = &b.serveur;
    ajouter(s, "le port par défaut de mem0-rs est 8321").await;
    ajouter(s, "le port par défaut de mem0-rs est 8322").await;
    b.faux.scripter(vec![ReponseChat::Statut(400)]);
    let r = ok(&s.appeler("POST", "/memory/dream", None).await);
    let rapport = &r["dreams"][0];
    assert_eq!(rapport["pairs_judged"], 0);
    assert!(rapport["errors"][0].as_str().unwrap().starts_with("LLM : "), "{rapport}");
    assert!(ok(&s.appeler("GET", &format!("/memory/dream?agent_id={AGENT}"), None).await)["proposals"].as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn consolidation_observations_causes_et_modeles() {
    let b = banc("consolidation").await;
    let s = &b.serveur;
    let f1 = ajouter(s, "Décision : chaque étape tourne sous systemd-run, confinée à son worktree.").await;
    let f2 = ajouter(s, "Bug : omp-harness-systemd-run échouait sous podman rootless sans Delegate=yes.").await;

    let d = ok(&s.appeler("GET", &format!("/memory/dream/dossier?agent_id={AGENT}"), None).await);
    assert_eq!(d["due"], true);
    assert_eq!(d["since"], Value::Null);
    assert_eq!(d["new_facts"].as_array().unwrap().len(), 2);
    assert_eq!(d["models"].as_array().unwrap().len(), 5);
    assert!(d["models"].as_array().unwrap().iter().all(|m| m["stale"] == true && m["content"] == ""));
    let horizon = d["horizon_us"].as_i64().unwrap();

    let refus = |corps: Value| async move { s.appeler("POST", "/memory/dream/consolidation", Some(&corps)).await };
    for corps in [
        json!({"agent_id": AGENT, "horizon_us": horizon, "observations": [{"text": "x", "evidence": ["inconnu"]}]}),
        json!({"agent_id": AGENT, "horizon_us": horizon, "observations": [{"text": "x", "evidence": []}]}),
        json!({"agent_id": AGENT, "horizon_us": horizon, "models": [{"name": "roman", "content": "x"}]}),
        json!({"agent_id": AGENT, "horizon_us": horizon, "causes": [{"source": f1, "target": f1}]}),
        json!({"agent_id": AGENT, "horizon_us": horizon, "obsolete": [f1]}),
        json!({"agent_id": AGENT, "horizon_us": horizon, "inconnu": 1}),
    ] {
        assert_eq!(refus(corps.clone()).await.statut, 422, "{corps}");
    }
    let r = ok(&refus(json!({
        "agent_id": AGENT,
        "horizon_us": horizon,
        "observations": [{"text": "Le confinement des étapes par systemd-run exige un cgroup délégué sous podman rootless.", "evidence": [f1, f2]}],
        "causes": [{"source": f1, "target": f2, "reason": "le confinement a exposé le cgroup"}],
        "models": [{"name": "pieges", "content": "- podman rootless : Delegate=yes dans omp-harness.slice.", "sources": [f2]}],
    }))
    .await);
    assert_eq!((r["observations_added"].as_u64(), r["causes"].as_u64(), r["models"].as_u64()), (Some(1), Some(1), Some(1)));

    let all = ok(&s.appeler("GET", &format!("/memory/all?agent_id={AGENT}"), None).await);
    let observation = all["results"].as_array().unwrap().iter().find(|l| l["metadata"]["memory_type"] == "observation").unwrap();
    assert_eq!(observation["metadata"]["tags"], "observation");
    assert_eq!(observation["metadata"]["preuves"], 2);
    assert_eq!(observation["metadata"]["origine"], "reve");
    let obs_id = observation["id"].as_str().unwrap().to_owned();
    // L'observation se cherche comme un souvenir.
    let trouves = chercher(s, json!({"query": "cgroup délégué podman rootless", "agent_id": AGENT, "threshold": 0})).await;
    assert!(ids(&trouves).contains(&obs_id.as_str()));

    let d = ok(&s.appeler("GET", &format!("/memory/dream/dossier?agent_id={AGENT}"), None).await);
    assert_eq!(d["due"], false);
    assert!(d["new_facts"].as_array().unwrap().is_empty());
    assert_eq!(d["observations"][0]["evidence"].as_array().unwrap().len(), 2);
    let modeles = ok(&s.appeler("GET", &format!("/memory/models?agent_id={AGENT}"), None).await);
    let pieges = modeles["models"].as_array().unwrap().iter().find(|m| m["name"] == "pieges").unwrap();
    assert!(pieges["content"].as_str().unwrap().contains("Delegate=yes"));
    assert_eq!(pieges["stale"], false);
    let vu = ok(&s.appeler("GET", &format!("/memory/{f2}/links"), None).await);
    let types: Vec<&str> = vu["links"].as_array().unwrap().iter().map(|l| l["type"].as_str().unwrap()).collect();
    assert!(types.contains(&"cause") && types.contains(&"preuve"), "{types:?}");

    // Un fait nouveau : le dossier le rend, l'observation se raffine.
    let f3 = ajouter(s, "Delegate=yes ne suffit pas sous cgroup v1 : il faut cgroup v2.").await;
    let d = ok(&s.appeler("GET", &format!("/memory/dream/dossier?agent_id={AGENT}"), None).await);
    assert_eq!(ids(d["new_facts"].as_array().unwrap()), [f3.as_str()]);
    let r = ok(&refus(json!({
        "agent_id": AGENT,
        "horizon_us": d["horizon_us"],
        "observations": [{"id": obs_id, "text": "Le confinement par systemd-run exige un cgroup v2 délégué (Delegate=yes) sous podman rootless.", "evidence": [f1, f2, f3]}],
    }))
    .await);
    assert_eq!(r["observations_refined"], 1);
    let h = ok(&s.appeler("GET", &format!("/memory/{obs_id}/history"), None).await);
    assert_eq!(h.as_array().unwrap().last().unwrap()["event"], "UPDATE");

    // Les preuves supprimées : l'observation orpheline part au rêve suivant.
    for f in [&f1, &f2, &f3] {
        ok(&s.appeler("DELETE", &format!("/memory/{f}"), None).await);
    }
    let r = ok(&s.appeler("POST", "/memory/dream", Some(&json!({"agent_id": AGENT}))).await);
    assert_eq!(r["dreams"][0]["orphans_removed"], 1);
    assert_eq!(ok(&s.appeler("GET", &format!("/memory/all?agent_id={AGENT}"), None).await)["total"], 0);
}
