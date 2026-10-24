//! Tests boîte noire du binaire mem0-rs (BR-1 de mem0-rs-noyau) : chaque test
//! lance le vrai binaire sur un port libre, branché sur un faux serveur OpenAI.

#[allow(dead_code, reason = "module partagé : chaque fichier de tests n'en utilise qu'une partie")]
mod common;

use std::time::Duration;

use common::{Dossier, FauxOpenAI, Lancement, Reponse, Serveur};
use md5::{Digest, Md5};
use serde_json::{Value, json};

const AGENT: &str = "contrat-noyau";
const CORPS_401: &str = r#"{"detail":"bad or missing X-Mem0-Token"}"#;

fn md5_hex(texte: &str) -> String {
    Md5::digest(texte.as_bytes()).iter().map(|o| format!("{o:02x}")).collect()
}

/// Banc : serveur lancé, faux embedder et dossier jetable. Les champs se libèrent
/// dans l'ordre : le serveur est tué avant que son dossier soit supprimé.
struct Banc {
    serveur: Serveur,
    faux: FauxOpenAI,
    _dossier: Dossier,
}

async fn banc(nom: &str, jeton: &str) -> Banc {
    let faux = FauxOpenAI::demarrer().await;
    let dossier = Dossier::nouveau(nom);
    let serveur = Serveur::demarrer(&Lancement {
        base: &dossier.base(),
        embedder_url: &faux.base_url,
        jeton,
        installation: "",
    })
    .await;
    Banc { serveur, faux, _dossier: dossier }
}

fn ok(r: &Reponse) -> Value {
    assert_eq!(r.statut, 200, "réponse : {}", r.texte);
    assert_eq!(r.content_type, "application/json");
    r.json()
}

fn assert_500(r: &Reponse) {
    assert_eq!(r.statut, 500, "réponse : {}", r.texte);
    assert_eq!(r.content_type, "text/plain; charset=utf-8");
    assert_eq!(r.texte, "Internal Server Error");
}

fn cles(v: &Value) -> Vec<&str> {
    v.as_object().expect("objet attendu").keys().map(String::as_str).collect()
}

/// add infer=false ; rend l'id.
async fn ajouter(s: &Serveur, corps: Value) -> String {
    let mut corps = corps;
    corps["infer"] = json!(false);
    let r = ok(&s.appeler("POST", "/memory/add", Some(&corps)).await);
    r["results"][0]["id"].as_str().expect("id").to_owned()
}

async fn tous(s: &Serveur, requete: &str) -> Value {
    ok(&s.appeler("GET", &format!("/memory/all{requete}"), None).await)
}

async fn historique(s: &Serveur, id: &str) -> Value {
    ok(&s.appeler("GET", &format!("/memory/{id}/history"), None).await)
}

fn ligne<'a>(all: &'a Value, id: &str) -> &'a Value {
    all["results"].as_array().unwrap().iter().find(|l| l["id"] == id).unwrap_or_else(|| panic!("{id} absent de all"))
}

/// POST /memory/search réussi : les lignes de `results`.
async fn chercher(s: &Serveur, corps: Value) -> Vec<Value> {
    let r = ok(&s.appeler("POST", "/memory/search", Some(&corps)).await);
    assert_eq!(cles(&r), ["results"]);
    r["results"].as_array().unwrap().clone()
}

/// Cosinus du faux embedder (vecteurs déjà normalisés).
fn cosinus(a: &str, b: &str) -> f64 {
    common::plonger(a).iter().zip(common::plonger(b)).map(|(x, y)| x * y).sum()
}

/// Clé de tri d'un isoformat (`.ffffff` éventuellement omis) : comparable.
fn cle_instant(iso: &str) -> String {
    let (base, reste) = iso.split_at(19);
    let fraction = reste.strip_prefix('.').map(|r| &r[..6]).unwrap_or("000000");
    format!("{base}.{fraction}")
}

#[tokio::test(flavor = "multi_thread")]
async fn health_sans_jeton_et_installation() {
    let faux = FauxOpenAI::demarrer().await;
    let dossier = Dossier::nouveau("health");
    let s = Serveur::demarrer(&Lancement {
        base: &dossier.base(),
        embedder_url: &faux.base_url,
        jeton: "jeton-health",
        installation: "inst-42",
    })
    .await;
    let r = s.envoyer("GET", "/health", None, &[]).await;
    assert_eq!(ok(&r), json!({"ok":true,"mem0":concat!("mem0-rs ", env!("CARGO_PKG_VERSION")),"user":"moi","installation":"inst-42"}));
    assert_eq!(cles(&r.json()), ["ok", "mem0", "user", "installation"]);
    let b = banc("health-vide", "").await;
    assert_eq!(b.serveur.envoyer("GET", "/health", None, &[]).await.texte, format!(r#"{{"ok":true,"mem0":"mem0-rs {}","user":"moi"}}"#, env!("CARGO_PKG_VERSION")));
    assert_eq!(faux.appels(), 0);
    let journal = s.journal();
    assert!(journal.contains("à l'écoute sur http://127.0.0.1:"), "{journal}");
    assert!(!journal.contains("jeton-health") && !journal.contains("jeton-omlx"), "secret imprimé : {journal}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ac2_jeton_401_sans_embedding_ni_ecriture() {
    let b = banc("ac2", "jeton-ac2").await;
    let s = &b.serveur;
    let id = ajouter(s, json!({"text":"souvenir protégé"})).await;
    let appels = b.faux.appels();
    let avant_all = tous(s, "").await;
    let avant_hist = historique(s, &id).await;
    let requetes: Vec<(&str, String, Option<&str>)> = vec![
        ("POST", "/memory/add".into(), Some(r#"{"text":"x","infer":false}"#)),
        ("POST", "/memory/add".into(), Some(r#"{"text":"x"}"#)),
        ("POST", "/memory/add_procedure".into(), Some(r#"{"steps":"x","agent_id":"a"}"#)),
        ("POST", "/memory/search".into(), Some(r#"{"query":"x"}"#)),
        ("GET", "/memory/all".into(), None),
        ("GET", "/memory/graph".into(), None),
        ("PUT", format!("/memory/{id}"), Some(r#"{"text":"y"}"#)),
        ("DELETE", format!("/memory/{id}"), None),
        ("GET", format!("/memory/{id}/history"), None),
    ];
    for (methode, chemin, corps) in &requetes {
        for entetes in [
            &[("content-type", "application/json")][..],
            &[("content-type", "application/json"), ("X-Mem0-Token", "mauvais")],
            &[("content-type", "application/json"), ("X-Mem0-Token", "JETON-AC2")],
        ] {
            let r = s.envoyer(methode, chemin, *corps, entetes).await;
            assert_eq!(r.statut, 401, "{methode} {chemin} {entetes:?} : {}", r.texte);
            assert_eq!(r.content_type, "application/json");
            assert_eq!(r.texte, CORPS_401);
        }
    }
    assert_eq!(b.faux.appels(), appels, "l'embedder a été appelé malgré le 401");
    assert_eq!(tous(s, "").await, avant_all);
    assert_eq!(avant_all["total"], 1);
    assert_eq!(historique(s, &id).await, avant_hist);
    // Nom d'en-tête insensible à la casse.
    let r = s.envoyer("GET", "/memory/all", None, &[("x-mem0-token", "jeton-ac2")]).await;
    assert_eq!(ok(&r)["total"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn ac2_validation_422_avant_jeton_401() {
    let b = banc("ac2-422", "jeton-ac2").await;
    let s = &b.serveur;
    let json_ct = [("content-type", "application/json")];
    let r = s.envoyer("POST", "/memory/add", Some("{}"), &json_ct).await;
    assert_eq!(r.statut, 422);
    assert_eq!(r.content_type, "application/json");
    assert_eq!(r.json(), json!({"detail":[{"type":"missing","loc":["body","text"],"msg":"Field required","input":{}}]}));
    let r = s.envoyer("PUT", "/memory/x", None, &json_ct).await;
    assert_eq!(r.json(), json!({"detail":[{"type":"missing","loc":["body"],"msg":"Field required","input":null}]}));
    let r = s.envoyer("POST", "/memory/search", Some(r#"{"query":"x","limit":"abc"}"#), &json_ct).await;
    assert_eq!(r.statut, 422);
    assert_eq!(r.json()["detail"][0]["type"], "int_parsing");
    let r = s.envoyer("POST", "/memory/add_procedure", Some(r#"{"steps":"x"}"#), &[]).await;
    assert_eq!(r.statut, 422);
    assert_eq!(r.json()["detail"][0]["type"], "model_attributes_type");
    let r = s.envoyer("POST", "/memory/add", Some("{"), &json_ct).await;
    assert_eq!(r.statut, 422);
    assert_eq!(r.json()["detail"][0]["type"], "json_invalid");
    assert_eq!(cles(&r.json()["detail"][0]), ["type", "loc", "msg", "input", "ctx"]);
    // Corps valide sans jeton : 401.
    let r = s.envoyer("POST", "/memory/add", Some(r#"{"text":"x"}"#), &json_ct).await;
    assert_eq!((r.statut, r.texte.as_str()), (401, CORPS_401));
    assert_eq!(b.faux.appels(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn ac4_hash_md5_et_revision_add() {
    let b = banc("ac4", "").await;
    let s = &b.serveur;
    let t = "Révision « AC-4 » : ligne 1\nligne 2 — fin";
    let r = ok(&s.appeler("POST", "/memory/add", Some(&json!({"text":t,"agent_id":AGENT,"infer":false}))).await);
    let id = r["results"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(r, json!({"results":[{"id":id,"memory":t,"event":"ADD","actor_id":null,"role":"user"}]}));
    assert_eq!(cles(&r["results"][0]), ["id", "memory", "event", "actor_id", "role"]);
    assert!(uuid::Uuid::parse_str(&id).is_ok() && id == id.to_lowercase());
    assert_eq!(b.faux.textes(), ["Révision « AC-4 » : ligne 1 ligne 2 — fin"]);

    let all = tous(s, &format!("?agent_id={AGENT}")).await;
    assert_eq!(all["total"], 1);
    let l = ligne(&all, &id);
    assert_eq!(cles(l), ["id", "memory", "hash", "metadata", "created_at", "updated_at", "user_id", "agent_id", "role"]);
    assert_eq!(l["memory"], t);
    assert_eq!(l["hash"], md5_hex(t));
    assert_eq!(l["metadata"], Value::Null);
    assert_eq!(l["created_at"], l["updated_at"]);
    assert!(l["created_at"].as_str().unwrap().ends_with("+00:00"));
    assert_eq!((l["user_id"].as_str(), l["agent_id"].as_str(), l["role"].as_str()), (Some("moi"), Some(AGENT), Some("user")));

    let h = historique(s, &id).await;
    assert_eq!(h.as_array().unwrap().len(), 1);
    let add = &h[0];
    assert_eq!(cles(add), ["id", "memory_id", "old_memory", "new_memory", "event", "created_at", "updated_at", "is_deleted", "actor_id", "role"]);
    assert_eq!(add["memory_id"], id.as_str());
    assert_eq!(add["event"], "ADD");
    assert_eq!(add["old_memory"], Value::Null);
    assert_eq!(add["new_memory"], t);
    assert_eq!(add["is_deleted"], false);
    assert_eq!(add["actor_id"], Value::Null);
    assert_eq!(add["role"], "user");
    assert_eq!(add["created_at"], l["created_at"]);
    assert_eq!(add["updated_at"], l["updated_at"]);
    // Id inconnu : liste vide.
    assert_eq!(historique(s, "inconnu").await, json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn ac5_put_fusionne_reembarque_historise() {
    let b = banc("ac5", "").await;
    let s = &b.serveur;
    let (v1, v2) = ("pomme cerise abricot", "voilier phare marée");
    let id = ajouter(s, json!({"text":v1,"agent_id":AGENT,"run_id":"course-1","tags":"alpha"})).await;
    let avant = ligne(&tous(s, "").await, &id).clone();
    assert_eq!(avant["metadata"], json!({"tags":"alpha"}));
    let appels = b.faux.appels();

    tokio::time::sleep(Duration::from_millis(2)).await;
    let r = ok(&s.appeler("PUT", &format!("/memory/{id}"), Some(&json!({"text":v2,"tags":"beta"}))).await);
    assert_eq!(r, json!({"message":"Memory updated successfully!"}));
    assert_eq!(b.faux.appels(), appels + 1, "le PUT doit ré-embarquer le texte");
    assert_eq!(b.faux.textes().last().map(String::as_str), Some(v2));
    let l = ligne(&tous(s, &format!("?agent_id={AGENT}")).await, &id).clone();
    assert_eq!(cles(&l), ["id", "memory", "hash", "metadata", "created_at", "updated_at", "user_id", "agent_id", "run_id", "role"]);
    assert_eq!(l["memory"], v2);
    assert_eq!(l["hash"], md5_hex(v2));
    assert_eq!(l["metadata"], json!({"tags":"beta"}));
    assert_eq!((l["agent_id"].as_str(), l["run_id"].as_str(), l["role"].as_str()), (Some(AGENT), Some("course-1"), Some("user")));
    assert_eq!(l["created_at"], avant["created_at"]);
    assert!(cle_instant(l["updated_at"].as_str().unwrap()) > cle_instant(l["created_at"].as_str().unwrap()));

    // tags absent : inchangés.
    ok(&s.appeler("PUT", &format!("/memory/{id}"), Some(&json!({"text":v2}))).await);
    assert_eq!(b.faux.appels(), appels + 2);
    assert_eq!(ligne(&tous(s, "").await, &id)["metadata"], json!({"tags":"beta"}));

    // Recherche : le nouveau vecteur retrouve V2 ; l'ancien texte ne passe plus le seuil.
    let r = chercher(s, json!({"query":v2,"agent_id":AGENT,"explain":true})).await;
    let trouve = r.iter().find(|l| l["id"] == id.as_str()).expect("V2 retrouvé par la recherche");
    assert!(trouve["score_details"]["semantic_score"].as_f64().unwrap() >= 0.999, "{trouve}");
    let r = chercher(s, json!({"query":v1,"agent_id":AGENT,"threshold":0.5,"explain":true})).await;
    assert!(r.iter().all(|l| l["id"] != id.as_str()), "V1 ne doit plus le retrouver : {r:?}");

    let h = historique(s, &id).await;
    let resume: Vec<(&str, Value, Value)> = h
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["event"].as_str().unwrap(), r["old_memory"].clone(), r["new_memory"].clone()))
        .collect();
    assert_eq!(resume, [("ADD", Value::Null, json!(v1)), ("UPDATE", json!(v1), json!(v2)), ("UPDATE", json!(v2), json!(v2))]);
    for r in h.as_array().unwrap() {
        assert_eq!(r["created_at"], avant["created_at"]);
        assert_eq!((r["is_deleted"].as_bool(), r["role"].as_str()), (Some(false), Some("user")));
    }

    // tags null et "" : présents, rendus tels quels.
    ok(&s.appeler("PUT", &format!("/memory/{id}"), Some(&json!({"text":v2,"tags":null}))).await);
    assert_eq!(ligne(&tous(s, "").await, &id)["metadata"], json!({"tags":null}));
    ok(&s.appeler("PUT", &format!("/memory/{id}"), Some(&json!({"text":v2,"tags":""}))).await);
    assert_eq!(ligne(&tous(s, "").await, &id)["metadata"], json!({"tags":""}));
    // add avec tags "" : pas de clé tags.
    let sans = ajouter(s, json!({"text":"x","tags":""})).await;
    assert_eq!(ligne(&tous(s, "").await, &sans)["metadata"], Value::Null);
}

async fn verifier_procedure(s: &Serveur, steps: &str) {
    let r = ok(&s.appeler("POST", "/memory/add_procedure", Some(&json!({"steps":steps,"agent_id":AGENT}))).await);
    assert_eq!(r["results"][0]["memory"], steps);
    let id = r["results"][0]["id"].as_str().unwrap();
    let l = ligne(&tous(s, &format!("?agent_id={AGENT}")).await, id).clone();
    assert_eq!(l["memory"].as_str().unwrap().as_bytes(), steps.as_bytes());
    assert_eq!(l["hash"], md5_hex(steps));
    assert_eq!((l["agent_id"].as_str(), l["metadata"].clone()), (Some(AGENT), Value::Null));
    assert_eq!(historique(s, id).await[0]["new_memory"], steps);
}

#[tokio::test(flavor = "multi_thread")]
async fn ac6_procedure_octet_pour_octet() {
    let b = banc("ac6", "").await;
    let s = &b.serveur;
    verifier_procedure(s, "# Procédure\r\n\n1. **Lancer** `cargo test`  \n\t- cas \"limite\" \\ fin 🚀\n").await;
    verifier_procedure(s, "avant\u{0}après NUL\u{0}\r\n  ").await;
    // agent_id "" : traité comme absent.
    let r = ok(&s.appeler("POST", "/memory/add_procedure", Some(&json!({"steps":"sans agent","agent_id":""}))).await);
    let id = r["results"][0]["id"].as_str().unwrap();
    assert!(ligne(&tous(s, "").await, id).get("agent_id").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn ac7_delete_retire_et_historise() {
    let b = banc("ac7", "").await;
    let s = &b.serveur;
    let texte = "souvenir à supprimer zéphyr";
    let id = ajouter(s, json!({"text":texte,"agent_id":AGENT})).await;
    let garde = ajouter(s, json!({"text":"souvenir gardé","agent_id":AGENT})).await;
    let appels = b.faux.appels();
    tokio::time::sleep(Duration::from_millis(2)).await;
    let r = ok(&s.appeler("DELETE", &format!("/memory/{id}"), None).await);
    assert_eq!(r, json!({"message":"Memory deleted successfully!"}));
    assert_eq!(b.faux.appels(), appels, "DELETE n'embarque rien");
    let all = tous(s, &format!("?agent_id={AGENT}")).await;
    assert_eq!(all["total"], 1);
    assert_eq!(all["results"][0]["id"], garde.as_str());
    let r = chercher(s, json!({"query":texte,"agent_id":AGENT,"threshold":0,"explain":true})).await;
    assert!(r.iter().all(|l| l["id"] != id.as_str()), "supprimé mais rendu par search : {r:?}");
    assert!(r.iter().all(|l| l["score_details"]["bm25_score"] == 0.0 || l["id"] == garde.as_str()));

    let h = historique(s, &id).await;
    let h = h.as_array().unwrap();
    assert_eq!(h.len(), 2);
    let (add, del) = (&h[0], &h[1]);
    assert_eq!(add["event"], "ADD");
    assert_eq!(cles(del), ["id", "memory_id", "old_memory", "new_memory", "event", "created_at", "updated_at", "is_deleted", "actor_id", "role"]);
    assert_eq!(del["event"], "DELETE");
    assert_eq!(del["old_memory"], texte);
    assert_eq!(del["new_memory"], Value::Null);
    assert_eq!(del["is_deleted"], true);
    assert_eq!(del["actor_id"], Value::Null);
    assert_eq!(del["role"], "user");
    assert_eq!(del["created_at"], add["created_at"]);
    assert!(cle_instant(del["updated_at"].as_str().unwrap()) >= cle_instant(add["updated_at"].as_str().unwrap()));

    // Absent : 500, sans écriture.
    assert_500(&s.appeler("DELETE", &format!("/memory/{id}"), None).await);
    assert_500(&s.appeler("PUT", &format!("/memory/{id}"), Some(&json!({"text":"retour"}))).await);
    assert_500(&s.appeler("PUT", "/memory/pas-un-uuid", Some(&json!({"text":"retour"}))).await);
    assert_eq!(historique(s, &id).await.as_array().unwrap().len(), 2);
    assert_eq!(tous(s, "").await["total"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn ac3_relance_meme_base() {
    let faux = FauxOpenAI::demarrer().await;
    let dossier = Dossier::nouveau("ac3");
    let base = dossier.base();
    let lancement = Lancement { base: &base, embedder_url: &faux.base_url, jeton: "", installation: "" };
    let s = Serveur::demarrer(&lancement).await;
    let a = ajouter(&s, json!({"text":"premier souvenir","agent_id":AGENT,"tags":"un"})).await;
    let b = ajouter(&s, json!({"text":"deuxième souvenir","run_id":"r1"})).await;
    let c = ajouter(&s, json!({"text":"troisième souvenir"})).await;
    ok(&s.appeler("PUT", &format!("/memory/{a}"), Some(&json!({"text":"premier, réécrit","tags":null}))).await);
    ok(&s.appeler("DELETE", &format!("/memory/{b}"), None).await);
    let all = tous(&s, "").await;
    let historiques = [historique(&s, &a).await, historique(&s, &b).await, historique(&s, &c).await];
    assert_eq!(all["total"], 2);

    let statut = s.arreter().await;
    assert_eq!(statut.code(), Some(0), "arrêt SIGTERM : {statut:?}");

    let s = Serveur::demarrer(&lancement).await;
    assert_eq!(tous(&s, "").await, all);
    for (id, avant) in [&a, &b, &c].iter().zip(&historiques) {
        assert_eq!(&historique(&s, id).await, avant);
    }
    let statut = s.arreter().await;
    assert_eq!(statut.code(), Some(0));
    for nom in dossier.entrees() {
        assert!(
            ["mem0-rs.db", "mem0-rs.db-wal", "mem0-rs.db-shm", "mem0-rs.db-journal", "mem0-rs.db.lock"].contains(&nom.as_str()),
            "fichier inattendu : {nom}"
        );
    }
    assert!(base.exists());
}

/// AC-11 (mem0-rs-migration, moitié serveur, S-10) : un second mem0-rs lancé sur
/// une base déjà servie sort en code 1 avec le message qui nomme le verrou, sans
/// toucher la base ; le premier continue de servir, et son arrêt libère le verrou.
#[tokio::test(flavor = "multi_thread")]
async fn ac11_second_serveur_refuse_par_le_verrou() {
    let faux = FauxOpenAI::demarrer().await;
    let dossier = Dossier::nouveau("ac11-verrou");
    let base = dossier.base();
    let lancement = Lancement { base: &base, embedder_url: &faux.base_url, jeton: "", installation: "" };
    let s = Serveur::demarrer(&lancement).await;
    ajouter(&s, json!({"text":"souvenir gardé","agent_id":AGENT})).await;
    let all = tous(&s, "").await;
    let octets = |nom: &str| std::fs::read(dossier.chemin.join(nom)).ok();
    let avant = (dossier.entrees(), octets("mem0-rs.db"), octets("mem0-rs.db-wal"));

    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mut second = std::process::Command::new(env!("CARGO_BIN_EXE_mem0-rs"))
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        .env("OMLX_BASE_URL", &faux.base_url)
        .env("EMBEDDING_DIMS", common::DIMENSIONS.to_string())
        .env("MEM0_DB_PATH", &base)
        .env("MEM0_HTTP_TOKEN", "")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("lancement du second mem0-rs");
    let debut = std::time::Instant::now();
    let statut = loop {
        if let Some(statut) = second.try_wait().unwrap() {
            break statut;
        }
        if debut.elapsed() > Duration::from_secs(30) {
            let _ = second.kill();
            panic!("le second mem0-rs sert la base au lieu de refuser");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let mut stderr = String::new();
    std::io::Read::read_to_string(&mut second.stderr.take().unwrap(), &mut stderr).unwrap();
    assert_eq!(statut.code(), Some(1), "stderr : {stderr}");
    let chemin = base.display();
    assert_eq!(
        stderr,
        format!("MEM0_DB_PATH={chemin} est déjà servie par un autre processus mem0-rs (verrou {chemin}.lock)\n")
    );
    assert_eq!((dossier.entrees(), octets("mem0-rs.db"), octets("mem0-rs.db-wal")), avant);
    assert_eq!(tous(&s, "").await, all, "le premier serveur sert toujours");

    assert_eq!(s.arreter().await.code(), Some(0));
    let s = Serveur::demarrer(&lancement).await;
    assert_eq!(tous(&s, "").await, all, "verrou libéré à l'arrêt");
}

#[tokio::test(flavor = "multi_thread")]
async fn ac8_all_505_souvenirs() {
    let b = banc("ac8", "").await;
    let s = &b.serveur;
    let mut ids = Vec::with_capacity(505);
    for i in 0..505 {
        ids.push(ajouter(s, json!({"text":format!("souvenir numéro {i}")})).await);
    }
    let elus = [&ids[3], &ids[500], &ids[0], &ids[250], &ids[504]];
    for id in elus {
        tokio::time::sleep(Duration::from_millis(2)).await;
        ok(&s.appeler("PUT", &format!("/memory/{id}"), Some(&json!({"text":"souvenir mis à jour"}))).await);
    }
    let all = tous(s, "").await;
    let lignes = all["results"].as_array().unwrap();
    assert_eq!(all["total"], 505);
    assert_eq!(lignes.len(), 505);
    let tete: Vec<&str> = lignes[..5].iter().map(|l| l["id"].as_str().unwrap()).collect();
    let attendu: Vec<&str> = elus.iter().rev().map(|s| s.as_str()).collect();
    assert_eq!(tete, attendu);
    for paire in lignes.windows(2) {
        let (u0, u1) = (cle_instant(paire[0]["updated_at"].as_str().unwrap()), cle_instant(paire[1]["updated_at"].as_str().unwrap()));
        let (i0, i1) = (paire[0]["id"].as_str().unwrap(), paire[1]["id"].as_str().unwrap());
        assert!(u0 > u1 || (u0 == u1 && i0 < i1), "ordre rompu entre {i0} ({u0}) et {i1} ({u1})");
    }
    let mut vus: Vec<&str> = lignes.iter().map(|l| l["id"].as_str().unwrap()).collect();
    vus.sort_unstable();
    let mut tous_ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    tous_ids.sort_unstable();
    assert_eq!(vus, tous_ids, "des lignes manquent");
}

#[tokio::test(flavor = "multi_thread")]
async fn routes_404_405_json() {
    let b = banc("routes", "").await;
    let s = &b.serveur;
    for (methode, chemin) in [("GET", "/nope"), ("GET", "/memory"), ("GET", "/memory/"), ("POST", "/memory/a/b/c")] {
        let r = s.envoyer(methode, chemin, None, &[]).await;
        assert_eq!((r.statut, r.content_type.as_str(), r.texte.as_str()), (404, "application/json", r#"{"detail":"Not Found"}"#), "{methode} {chemin}");
    }
    for (methode, chemin) in [
        ("GET", "/memory/un-id"),
        ("POST", "/memory/un-id"),
        ("POST", "/health"),
        ("GET", "/memory/add"),
        ("POST", "/memory/all"),
        ("POST", "/memory/un-id/history"),
        ("DELETE", "/memory/un-id/history"),
    ] {
        let r = s.envoyer(methode, chemin, None, &[]).await;
        assert_eq!(
            (r.statut, r.content_type.as_str(), r.texte.as_str()),
            (405, "application/json", r#"{"detail":"Method Not Allowed"}"#),
            "{methode} {chemin}"
        );
    }
    // Comme starlette, PUT/DELETE sur un chemin statique atteignent /memory/{memory_id}.
    assert_500(&s.appeler("PUT", "/memory/all", Some(&json!({"text":"x"}))).await);
    assert_eq!(s.appeler("PUT", "/memory/all", Some(&json!({}))).await.statut, 422);
    assert_500(&s.appeler("DELETE", "/memory/graph", None).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn identifiants_de_portee() {
    let b = banc("portee", "").await;
    let s = &b.serveur;
    for corps in [json!({"text":"x","agent_id":"a b"}), json!({"text":"x","agent_id":"   "}), json!({"text":"x","run_id":"r\tun"})] {
        let mut c = corps.clone();
        c["infer"] = json!(false);
        assert_500(&s.appeler("POST", "/memory/add", Some(&c)).await);
    }
    assert_500(&s.appeler("POST", "/memory/add_procedure", Some(&json!({"steps":"x","agent_id":"a b"}))).await);
    assert_500(&s.appeler("GET", "/memory/all?agent_id=a%20b", None).await);
    assert_eq!(b.faux.appels(), 0, "aucun embedding pour une portée invalide");
    assert_eq!(tous(s, "").await["total"], 0);

    let id = ajouter(s, json!({"text":"x","agent_id":"  agent-trim\u{a0}","run_id":""})).await;
    let l = ligne(&tous(s, "?agent_id=%20agent-trim%20").await, &id).clone();
    assert_eq!(l["agent_id"], "agent-trim");
    assert!(l.get("run_id").is_none());
    assert_eq!(tous(s, "?agent_id=autre").await["total"], 0);
    assert_eq!(tous(s, "?agent_id=").await["total"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn embedder_injoignable_500_sans_ecriture() {
    // Un port fermé : connexion refusée, 2 nouvelles tentatives, puis 500.
    let ferme = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let dossier = Dossier::nouveau("injoignable");
    let s = Serveur::demarrer(&Lancement {
        base: &dossier.base(),
        embedder_url: &format!("http://127.0.0.1:{ferme}/v1"),
        jeton: "",
        installation: "",
    })
    .await;
    let debut = std::time::Instant::now();
    assert_500(&s.appeler("POST", "/memory/add", Some(&json!({"text":"x","infer":false}))).await);
    assert!(debut.elapsed() >= Duration::from_millis(1400), "nouvelles tentatives attendues (0,5 s puis 1 s)");
    assert_eq!(tous(&s, "").await, json!({"total":0,"results":[]}));
}

const CLES_RECHERCHE: [&str; 11] =
    ["id", "memory", "hash", "metadata", "score", "created_at", "updated_at", "user_id", "agent_id", "role", "score_details"];
const CLES_DETAILS: [&str; 7] =
    ["semantic_score", "bm25_score", "entity_boost", "raw_score", "max_possible_score", "final_score", "threshold"];

#[tokio::test(flavor = "multi_thread")]
async fn ac10_semantic_score_est_le_cosinus_brut() {
    let b = banc("ac10", "").await;
    let s = &b.serveur;
    let textes = [
        "Le serveur mem0-rs écoute sur le port 8321",
        "The runners are running: run, RUN!",
        "pomme cerise abricot pomme",
        "Constante EMBEDDING_DIMS du serveur",
        "réglage du seuil de recherche hybride",
    ];
    let mut ids = Vec::new();
    for t in textes {
        ids.push(ajouter(s, json!({"text":t,"agent_id":AGENT,"tags":"t"})).await);
    }
    for (query, threshold) in [("serveur port", json!(0)), ("running runners", json!(0)), ("  seuil   hybride ", Value::Null)] {
        let r = chercher(s, json!({"query":query,"agent_id":AGENT,"limit":10,"threshold":threshold,"explain":true})).await;
        assert!(!r.is_empty(), "{query} : aucun résultat");
        for l in &r {
            assert_eq!(cles(l), CLES_RECHERCHE, "{l}");
            let d = &l["score_details"];
            assert_eq!(cles(d), CLES_DETAILS);
            let texte = l["memory"].as_str().unwrap();
            let attendu = cosinus(query.trim(), texte);
            let obtenu = d["semantic_score"].as_f64().unwrap();
            assert!((obtenu - attendu).abs() <= 1e-6, "{query} / {texte} : {obtenu} ≠ cos {attendu}");
            // score = final_score = min((cos + bm25)/max_possible, 1), entity_boost nul.
            let (bm25, max) = (d["bm25_score"].as_f64().unwrap(), d["max_possible_score"].as_f64().unwrap());
            assert!(max == 1.0 || max == 2.0);
            assert_eq!(d["entity_boost"], 0.0);
            assert!((d["raw_score"].as_f64().unwrap() - (obtenu + bm25)).abs() < 1e-12);
            assert_eq!(l["score"], d["final_score"]);
            assert!((d["final_score"].as_f64().unwrap() - ((obtenu + bm25) / max).min(1.0)).abs() < 1e-12);
            assert_eq!(d["threshold"], if threshold.is_null() { json!(0.1) } else { json!(0.0) });
            assert_eq!(l["metadata"], json!({"tags":"t"}));
        }
        // Tri par score combiné décroissant.
        assert!(r.windows(2).all(|w| w[0]["score"].as_f64() >= w[1]["score"].as_f64()));
    }
    // Sans explain : pas de score_details, le reste dans le même ordre.
    let r = chercher(s, json!({"query":"serveur","agent_id":AGENT})).await;
    assert_eq!(cles(&r[0]), CLES_RECHERCHE[..10]);
    // Racine commune (running/runners → run, runner) : BM25 actif sur la requête fléchie.
    let r = chercher(s, json!({"query":"run","agent_id":AGENT,"threshold":0,"explain":true})).await;
    let coureur = r.iter().find(|l| l["id"] == ids[1].as_str()).unwrap();
    assert!(coureur["score_details"]["bm25_score"].as_f64().unwrap() > 0.0);
    assert_eq!(coureur["score_details"]["max_possible_score"], 2.0);
}

#[tokio::test(flavor = "multi_thread")]
async fn ac11_threshold_ecarte_le_souvenir_lexical_avant_la_fusion() {
    let b = banc("ac11", "").await;
    let s = &b.serveur;
    // Contient exactement la requête (BM25 fort) mais noyé dans 20 autres mots :
    // cosinus ≈ 1/√21 ≈ 0.22.
    let lexical = "zéphyr alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike \
                   november oscar papa quebec romeo sierra tango";
    let id = ajouter(s, json!({"text":lexical,"agent_id":AGENT})).await;
    let proche = ajouter(s, json!({"text":"zéphyr marin","agent_id":AGENT})).await;
    assert!(cosinus("zéphyr", lexical) < 0.5);

    let r = chercher(s, json!({"query":"zéphyr","agent_id":AGENT,"threshold":0.5,"explain":true})).await;
    let rendus: Vec<&str> = r.iter().map(|l| l["id"].as_str().unwrap()).collect();
    assert_eq!(rendus, [proche.as_str()], "le souvenir sous le seuil doit être écarté malgré son BM25");
    // BM25 actif (le souvenir écarté compte quand même dans max_possible).
    assert_eq!(r[0]["score_details"]["max_possible_score"], 2.0);

    let r = chercher(s, json!({"query":"zéphyr","agent_id":AGENT,"threshold":0,"explain":true})).await;
    let l = r.iter().find(|l| l["id"] == id.as_str()).expect("rendu à threshold 0");
    assert!(l["score_details"]["bm25_score"].as_f64().unwrap() > 0.0);
    assert!(l["score_details"]["semantic_score"].as_f64().unwrap() < 0.5);
}

#[tokio::test(flavor = "multi_thread")]
async fn ac15_graphe_noeud_central_9_voisins() {
    let b = banc("ac15", "").await;
    let s = &b.serveur;
    assert_eq!(ok(&s.appeler("GET", "/memory/graph", None).await), json!({"total":0,"threshold":0.75,"top_k":8,"edges":[]}));

    let base: Vec<String> = (0..20).map(|i| format!("noyau{i}")).collect();
    let centre = base.join(" ");
    let mut textes = vec![centre.clone()];
    for k in 0..9 {
        textes.push(format!("{centre} voisin{k}"));
    }
    textes.push("souvenir isolé sans rapport".to_owned());
    let mut cle_de = std::collections::HashMap::new();
    for (i, t) in textes.iter().enumerate() {
        // Agents différents : le graphe couvre toute la portée de l'utilisateur.
        let id = ajouter(s, json!({"text":t,"agent_id":format!("agent{}", i % 2)})).await;
        cle_de.insert(id, i);
    }
    let g = ok(&s.appeler("GET", "/memory/graph?threshold=0&top_k=50", None).await);
    assert_eq!(cles(&g), ["total", "threshold", "top_k", "edges"]);
    assert_eq!((g["total"].as_u64(), g["threshold"].as_f64(), g["top_k"].as_u64()), (Some(11), Some(0.75), Some(8)));
    let edges = g["edges"].as_array().unwrap();
    for e in edges {
        assert_eq!(cles(e), ["source", "target", "score"]);
        let (src, tgt) = (e["source"].as_str().unwrap(), e["target"].as_str().unwrap());
        assert!(src < tgt);
        let attendu = cosinus(&textes[cle_de[src]], &textes[cle_de[tgt]]);
        assert!((e["score"].as_f64().unwrap() - attendu).abs() <= 1e-6);
        assert!(attendu >= 0.75);
    }
    for w in edges.windows(2) {
        let cle = |e: &Value| (-e["score"].as_f64().unwrap(), e["source"].as_str().unwrap().to_owned(), e["target"].as_str().unwrap().to_owned());
        assert!(cle(&w[0]) < cle(&w[1]), "tri (score décroissant, source, target)");
    }
    let touche = |i: usize| edges.iter().filter(|e| [&e["source"], &e["target"]].iter().any(|x| cle_de[x.as_str().unwrap()] == i)).count();
    // Le centre garde 8 voisins de son côté, mais chaque voisin le classe premier.
    assert_eq!(touche(0), 9);
    assert_eq!(touche(10), 0);
    // Chaque voisin : le centre + ses 7 meilleurs voisins, plus ceux qui l'ont choisi.
    assert!((1..10).all(|k| touche(k) >= 8));
}

#[tokio::test(flavor = "multi_thread")]
async fn recherche_validation_filtres_et_limite() {
    let b = banc("recherche", "").await;
    let s = &b.serveur;
    let alpha = ajouter(s, json!({"text":"cerise rouge","agent_id":AGENT,"tags":"alpha"})).await;
    let beta = ajouter(s, json!({"text":"cerise noire","agent_id":AGENT,"run_id":"r1"})).await;
    let autre = ajouter(s, json!({"text":"cerise jaune","agent_id":"ailleurs"})).await;
    let appels = b.faux.appels();

    // 500 sans embedding : requête vide, seuil hors [0, 1], limite négative, portée invalide.
    for corps in [
        json!({"query":" \t\n"}),
        json!({"query":"cerise","threshold":1.5}),
        json!({"query":"cerise","limit":-1}),
        json!({"query":"cerise","agent_id":"a b"}),
        json!({"query":"cerise","filters":{"tags":1.5}}),
        json!({"query":"cerise","filters":{"tags":null}}),
    ] {
        assert_500(&s.appeler("POST", "/memory/search", Some(&corps)).await);
    }
    // 501 pour les opérateurs de filters, sans embedding ni lecture.
    let corps_501 = json!({"detail":"filters avancés (opérateurs, AND/OR/NOT, listes, \"*\") non supportés par mem0-rs"});
    for f in [json!({"tags":{"in":["alpha"]}}), json!({"tags":["alpha"]}), json!({"tags":"*"}), json!({"OR":[{"tags":"alpha"}]})] {
        let r = s.appeler("POST", "/memory/search", Some(&json!({"query":"cerise","filters":f}))).await;
        assert_eq!((r.statut, r.content_type.as_str()), (501, "application/json"), "{f}");
        assert_eq!(r.json(), corps_501);
    }
    assert_eq!(b.faux.appels(), appels, "aucun embedding pour une recherche refusée");

    let ids = |r: &[Value]| r.iter().map(|l| l["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    // Scope : sans agent_id, tous les agents ; avec, le seul agent.
    assert_eq!(chercher(s, json!({"query":"cerise","threshold":0})).await.len(), 3);
    let r = chercher(s, json!({"query":"cerise","agent_id":AGENT,"threshold":0})).await;
    assert!(!ids(&r).contains(&autre));
    // Filtres d'égalité stricte ; la portée écrase le client.
    assert_eq!(ids(&chercher(s, json!({"query":"cerise","threshold":0,"filters":{"tags":"alpha"}})).await), [alpha]);
    assert_eq!(ids(&chercher(s, json!({"query":"cerise","threshold":0,"filters":{"run_id":"r1"}})).await), [beta]);
    assert!(chercher(s, json!({"query":"cerise","threshold":0,"filters":{"run_id":1}})).await.is_empty());
    assert!(chercher(s, json!({"query":"cerise","threshold":0,"filters":{"inconnue":"x"}})).await.is_empty());
    let r = chercher(s, json!({"query":"cerise","agent_id":AGENT,"threshold":0,"filters":{"agent_id":"ailleurs","user_id":"x"}})).await;
    assert_eq!(r.len(), 2);
    assert_eq!(ids(&chercher(s, json!({"query":"cerise","threshold":0,"filters":{"agent_id":"ailleurs"}})).await), [autre]);
    // Limite : 0 rend une liste vide ; 1 tronque.
    assert_eq!(ok(&s.appeler("POST", "/memory/search", Some(&json!({"query":"cerise","limit":0}))).await), json!({"results":[]}));
    assert_eq!(chercher(s, json!({"query":"cerise","limit":1,"threshold":0})).await.len(), 1);
    // Un souvenir à texte vide n'est jamais rendu.
    ajouter(s, json!({"text":"","agent_id":AGENT})).await;
    assert!(chercher(s, json!({"query":"cerise","threshold":0,"limit":10})).await.iter().all(|l| l["memory"] != ""));
}

/// Masquage serveur (redaction) : add, add_procedure et PUT n'écrivent, n'embarquent
/// et ne renvoient que le texte masqué — les clients qui écrivent sans le plugin
/// (oracle du harness, apps) sont couverts. Le jeton est assemblé à l'exécution :
/// d'un seul tenant dans le source, la push protection de GitHub le refuserait.
#[tokio::test(flavor = "multi_thread")]
async fn redaction_add_procedure_et_put_masquent_les_secrets() {
    let b = banc("redaction", "").await;
    let s = &b.serveur;
    let stripe = format!("{}{}{}", "sk", "_live_", "AbCdEfGhIjKlMnOpQrStUvWx");
    let secret = format!("Clé de paiement {stripe} et password=S3cretValue123 en clair");
    let masque = "Clé de paiement [REDACTED] et [REDACTED] en clair";

    let r = ok(&s.appeler("POST", "/memory/add", Some(&json!({"text":secret,"agent_id":AGENT,"infer":false}))).await);
    assert_eq!(r["results"][0]["memory"], masque);
    let id = r["results"][0]["id"].as_str().unwrap().to_owned();
    let l = ligne(&tous(s, "").await, &id).clone();
    assert_eq!((l["memory"].as_str(), l["hash"].as_str()), (Some(masque), Some(md5_hex(masque).as_str())));
    assert_eq!(historique(s, &id).await[0]["new_memory"], masque);

    let steps = format!("1. Exporter STRIPE={stripe}\n2. Lancer");
    let r = ok(&s.appeler("POST", "/memory/add_procedure", Some(&json!({"steps":steps,"agent_id":AGENT}))).await);
    assert_eq!(r["results"][0]["memory"], "1. Exporter STRIPE=[REDACTED]\n2. Lancer");

    ok(&s.appeler("PUT", &format!("/memory/{id}"), Some(&json!({"text":format!("Remplacé : {stripe}")}))).await);
    assert_eq!(ligne(&tous(s, "").await, &id)["memory"], "Remplacé : [REDACTED]");

    let fuites: Vec<String> =
        b.faux.textes().into_iter().filter(|t| t.contains(&stripe) || t.contains("S3cretValue123")).collect();
    assert!(fuites.is_empty(), "secret envoyé à l'embedder : {fuites:?}");
}

/// Corps au-delà de `CORPS_MAX` (1 Mio) : 413 en JSON `{"detail"}`, sans embedding
/// ni écriture ; un corps sous la borne passe.
#[tokio::test(flavor = "multi_thread")]
async fn corps_au_dela_d_un_mio_refuse_en_413() {
    let b = banc("corps-max", "").await;
    let s = &b.serveur;
    let entetes = [("content-type", "application/json")];
    let trop = format!(r#"{{"text":"{}","infer":false}}"#, "a".repeat(1024 * 1024));
    for (methode, chemin) in [("POST", "/memory/add"), ("POST", "/memory/search"), ("PUT", "/memory/inconnu")] {
        let r = s.envoyer(methode, chemin, Some(&trop), &entetes).await;
        assert_eq!((r.statut, r.content_type.as_str()), (413, "application/json"), "{methode} {chemin} : {}", r.texte);
        assert_eq!(r.json(), json!({"detail":"corps de requête au-delà de 1048576 octets"}));
    }
    assert_eq!(b.faux.appels(), 0, "aucun embedding pour un corps refusé");
    assert_eq!(tous(s, "").await["total"], 0);
    let juste = format!(r#"{{"text":"{}","infer":false}}"#, "a".repeat(512 * 1024));
    ok(&s.envoyer("POST", "/memory/add", Some(&juste), &entetes).await);
    assert_eq!(tous(s, "").await["total"], 1);
}
