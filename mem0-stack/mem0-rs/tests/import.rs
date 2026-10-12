//! Tests boîte noire de `mem0-rs import` (BR-2 de mem0-rs-migration) : chaque test
//! lance le vrai binaire contre une fausse Qdrant et un history.db au schéma de
//! mem0 2.2.1, puis inspecte le rapport, les codes et la base écrite.

#[allow(dead_code, reason = "module partagé : chaque fichier de tests n'en utilise qu'une partie")]
mod common;

use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::time::{Duration, Instant};

use common::{
    Commande, Dossier, FauxOpenAI, FauxQdrant, Forme, HistoryDb, Lancement, OptionsQdrant, Reponse, Revision, Serveur, date_mem0,
    empreinte, id_point, plonger, point_mem0, sha256_fichier,
};
use serde_json::{Value, json};

/// Message de S-10 quand la base est servie.
fn message_verrou(base: &Path) -> String {
    let chemin = base.display();
    format!("la base {chemin} est servie par un mem0-rs en cours d'exécution (verrou {chemin}.lock) : arrête-le avant d'importer\n")
}

/// Source d'import : fausse Qdrant + history.db dans un dossier jetable.
struct Source {
    qdrant: FauxQdrant,
    history: HistoryDb,
    dossier: Dossier,
}

impl Source {
    async fn nouvelle(nom: &str, options: OptionsQdrant) -> Source {
        let dossier = Dossier::nouveau(nom);
        let history = HistoryDb::nouveau(&dossier.chemin.join("history.db"));
        let qdrant = FauxQdrant::demarrer(options).await;
        Source { qdrant, history, dossier }
    }

    /// Arguments de `mem0-rs import` vers cette source, suivis de `options`.
    fn args<'a>(&'a self, options: &[&'a str]) -> Vec<&'a str> {
        let mut args = vec!["import", "--history-db", self.history.chemin.to_str().unwrap(), "--qdrant-url", self.qdrant.url.as_str()];
        args.extend_from_slice(options);
        args
    }

    async fn importer(&self, base: &Path, options: &[&str], env: &[(&str, &str)]) -> (Option<i32>, String, String) {
        let mut e = vec![("MEM0_DB_PATH", base.to_str().unwrap())];
        e.extend_from_slice(env);
        Commande::lancer(&self.args(options), &e).await
    }
}

/// Import qui doit réussir sans rejet ; rend stdout.
async fn importer_ok(source: &Source, base: &Path, options: &[&str]) -> String {
    let (code, stdout, stderr) = source.importer(base, options, &[]).await;
    assert_eq!(code, Some(0), "stdout : {stdout}\nstderr : {stderr}");
    stdout
}

fn ok(r: &Reponse) -> Value {
    assert_eq!(r.statut, 200, "réponse : {}", r.texte);
    r.json()
}

async fn serveur(base: &Path, faux: &FauxOpenAI) -> Serveur {
    Serveur::demarrer(&Lancement { base, embedder_url: &faux.base_url, jeton: "", installation: "" }).await
}

async fn tous(s: &Serveur) -> Vec<Value> {
    ok(&s.appeler("GET", "/memory/all", None).await)["results"].as_array().expect("results").clone()
}

/// Ligne de GET /memory/all attendue pour un point écrit par `point_mem0`.
fn ligne_attendue(point: &Value) -> Value {
    let p = &point["payload"];
    let mut l = json!({
        "id": point["id"],
        "memory": p["data"],
        "hash": p["hash"],
        "metadata": { "tags": p["tags"] },
        "created_at": p["created_at"],
        "updated_at": p["updated_at"],
        "user_id": p["user_id"],
    });
    if let Some(agent) = p.get("agent_id") {
        l["agent_id"] = agent.clone();
    }
    l["role"] = p["role"].clone();
    l
}

/// GET /memory/all attendu : updated_at décroissant.
fn all_attendu(points: &[Value]) -> Vec<Value> {
    let mut lignes: Vec<Value> = points.iter().map(ligne_attendue).collect();
    lignes.sort_by(|a, b| b["updated_at"].as_str().cmp(&a["updated_at"].as_str()));
    lignes
}

/// `n` souvenirs valides de l'agent, ids `id_point(debut..debut + n)`.
fn souvenirs(debut: usize, n: usize, agent: &str, forme: Forme) -> Vec<Value> {
    (debut..debut + n)
        .map(|i| point_mem0(&id_point(i), &format!("souvenir {i} de {agent} : migration vers sqlite"), Some(agent), i, forme))
        .collect()
}

/// Rejet attendu dans le rapport JSON.
fn rejet(element: &str, id: &str, raison: &str, detail: &str) -> Value {
    json!({ "element": element, "id": id, "raison": raison, "detail": detail })
}

/// Entrée `agents[]` attendue du rapport JSON (clés dans l'ordre de S-9).
fn agent(agent_id: Option<&str>, importes: u64, deja: u64, rejetes: Vec<Value>, revisions: u64, messages: u64) -> Value {
    json!({
        "agent_id": agent_id,
        "importes": importes,
        "deja_presents": deja,
        "rejetes": rejetes,
        "revisions": revisions,
        "messages": messages,
    })
}

/// Rapport JSON attendu ; les totaux sont la somme des agents.
fn rapport(agents: Vec<Value>) -> Value {
    let somme = |cle: &str| agents.iter().map(|a| a[cle].as_u64().unwrap()).sum::<u64>();
    let rejetes = agents.iter().map(|a| a["rejetes"].as_array().unwrap().len() as u64).sum::<u64>();
    json!({
        "agents": agents,
        "totaux": {
            "importes": somme("importes"),
            "deja_presents": somme("deja_presents"),
            "rejetes": rejetes,
            "revisions": somme("revisions"),
            "messages": somme("messages"),
        },
    })
}

fn json_unique(stdout: &str) -> Value {
    assert!(stdout.ends_with('\n') && stdout.matches('\n').count() == 1, "une seule ligne attendue : {stdout:?}");
    serde_json::from_str(stdout).unwrap_or_else(|e| panic!("JSON attendu ({e}) : {stdout}"))
}

fn ligne_simulation(base: &Path) -> String {
    format!("simulation : rien n'a été écrit dans {}", base.display())
}

/// AC-3 (mem0-rs-migration, S-2, S-5) : la même source en vecteurs nommés
/// `{"": dense, "bm25": creux}` et en liste nue s'importe en code 0 ; les deux bases
/// rendent le même GET /memory/all (ids, texte, hash, métadonnées, dates), et la
/// recherche du texte exact d'un souvenir le classe premier dans les deux.
#[tokio::test(flavor = "multi_thread")]
async fn ac3_formes() {
    let points = |forme| {
        let mut p = souvenirs(0, 3, "agent-a", forme);
        p.extend(souvenirs(3, 3, "agent-b", forme));
        p
    };
    let nommee = Source::nouvelle("ac3-nommee", OptionsQdrant::new(points(Forme::Nommee))).await;
    let nue = Source::nouvelle("ac3-nue", OptionsQdrant::new(points(Forme::Nue))).await;
    let cibles = Dossier::nouveau("ac3-cibles");
    let base_nommee = cibles.chemin.join("nommee.db");
    let base_nue = cibles.chemin.join("nue.db");
    importer_ok(&nommee, &base_nommee, &[]).await;
    importer_ok(&nue, &base_nue, &[]).await;

    let faux = FauxOpenAI::demarrer().await;
    let attendu = all_attendu(&points(Forme::Nommee));
    let mut alls = Vec::new();
    for base in [&base_nommee, &base_nue] {
        let s = serveur(base, &faux).await;
        let all = tous(&s).await;
        assert_eq!(all, attendu, "base {}", base.display());
        let cible = "souvenir 4 de agent-b : migration vers sqlite";
        let r = ok(&s.appeler("POST", "/memory/search", Some(&json!({"query": cible, "limit": 3}))).await);
        assert_eq!(r["results"][0]["id"], id_point(4), "recherche sur {} : {r}", base.display());
        alls.push(all);
    }
    assert_eq!(alls[0], alls[1]);
}

/// AC-5 (mem0-rs-migration, S-6) : après import, un PUT, un add et un DELETE via
/// mem0-rs ; le ré-import de la même source compte tous les points en « déjà
/// présents » (0 importé), et la base garde la version mem0-rs : pas de doublon,
/// le modifié garde son texte, le nouveau reste, le supprimé n'est pas ressuscité.
#[tokio::test(flavor = "multi_thread")]
async fn ac5_cible_gagne() {
    let points = souvenirs(0, 4, "a5", Forme::Nommee);
    let source = Source::nouvelle("ac5-source", OptionsQdrant::new(points.clone())).await;
    for (i, p) in points.iter().enumerate() {
        let id = p["id"].as_str().unwrap();
        source.history.ligne(&Revision::mem0(&format!("h{i}"), id, "ADD", None, p["payload"]["data"].as_str(), i));
    }
    let cible = Dossier::nouveau("ac5-cible");
    let base = cible.base();
    let premier = json_unique(&importer_ok(&source, &base, &["--json"]).await);
    assert_eq!(premier, rapport(vec![agent(Some("a5"), 4, 0, vec![], 4, 0)]));

    let faux = FauxOpenAI::demarrer().await;
    let s = serveur(&base, &faux).await;
    let (modifie, supprime) = (id_point(0), id_point(1));
    ok(&s.appeler("PUT", &format!("/memory/{modifie}"), Some(&json!({"text": "version écrite par mem0-rs"}))).await);
    let r = ok(&s.appeler("POST", "/memory/add", Some(&json!({"text": "nouveau souvenir mem0-rs", "agent_id": "a5", "infer": false}))).await);
    let nouveau = r["results"][0]["id"].as_str().expect("id du nouveau").to_owned();
    ok(&s.appeler("DELETE", &format!("/memory/{supprime}"), None).await);
    assert_eq!(s.arreter().await.code(), Some(0));

    let second = json_unique(&importer_ok(&source, &base, &["--json"]).await);
    assert_eq!(second, rapport(vec![agent(Some("a5"), 0, 4, vec![], 0, 0)]));

    let s = serveur(&base, &faux).await;
    let all = tous(&s).await;
    let mut ids: Vec<&str> = all.iter().map(|l| l["id"].as_str().unwrap()).collect();
    ids.sort_unstable();
    let total = ids.len();
    ids.dedup();
    assert_eq!(ids.len(), total, "doublon dans {all:?}");
    assert_eq!(total, 4, "4 importés − 1 supprimé + 1 ajouté : {all:?}");
    let ligne = |id: &str| all.iter().find(|l| l["id"] == id).cloned();
    assert_eq!(ligne(&modifie).expect("modifié présent")["memory"], "version écrite par mem0-rs");
    assert_eq!(ligne(&nouveau).expect("nouveau présent")["memory"], "nouveau souvenir mem0-rs");
    assert!(ligne(&supprime).is_none(), "supprimé ressuscité : {all:?}");
    for p in &points[2..] {
        assert_eq!(ligne(p["id"].as_str().unwrap()), Some(ligne_attendue(p)));
    }
}

/// Cible non vide : un import préalable de 3 souvenirs dans `cible`.
async fn cible_non_vide(nom: &str) -> (Dossier, Source) {
    let prealable = Source::nouvelle(&format!("{nom}-prealable"), OptionsQdrant::new(souvenirs(1000, 3, "a6", Forme::Nommee))).await;
    let cible = Dossier::nouveau(nom);
    importer_ok(&prealable, &cible.base(), &[]).await;
    (cible, prealable)
}

/// AC-6 (mem0-rs-migration, S-2, S-7) : une Qdrant qui tombe après la 1re page du
/// scroll fait échouer l'import en code 1, stdout vide, `Qdrant injoignable (…`, et
/// le dossier de la cible non vide garde exactement ses fichiers et ses octets.
#[tokio::test(flavor = "multi_thread")]
async fn ac6_coupure() {
    let (cible, _prealable) = cible_non_vide("ac6-coupure").await;
    let avant = empreinte(&cible.chemin);
    let mut options = OptionsQdrant::new(souvenirs(0, 300, "a6", Forme::Nommee));
    options.coupure_apres = Some(1);
    let source = Source::nouvelle("ac6-coupure-source", options).await;
    let (code, stdout, stderr) = source.importer(&cible.base(), &[], &[]).await;
    assert_eq!(code, Some(1), "stderr : {stderr}");
    assert_eq!(stdout, "");
    assert!(stderr.starts_with("Qdrant injoignable ("), "stderr : {stderr}");
    assert!(source.qdrant.requetes().len() >= 2, "la 2e page doit avoir été demandée");
    assert_eq!(empreinte(&cible.chemin), avant);
}

/// AC-6 (mem0-rs-migration, S-1, S-7) : un Ctrl-C (SIGINT) pendant la lecture du
/// scroll tue l'import (statut « tué par signal », non nul) et laisse le dossier de
/// la cible non vide strictement identique.
#[tokio::test(flavor = "multi_thread")]
async fn ac6_sigint() {
    let (cible, _prealable) = cible_non_vide("ac6-sigint").await;
    let avant = empreinte(&cible.chemin);
    let mut options = OptionsQdrant::new(souvenirs(0, 300, "a6", Forme::Nommee));
    options.delai_avant = Some((2, Duration::from_secs(30)));
    let source = Source::nouvelle("ac6-sigint-source", options).await;
    let base = cible.base();
    let mut enfant = Commande::demarrer(&source.args(&[]), &[("MEM0_DB_PATH", base.to_str().unwrap())]);
    let debut = Instant::now();
    while source.qdrant.requetes().len() < 2 {
        if let Some(statut) = enfant.try_wait().unwrap() {
            panic!("import terminé avant la 2e page : {statut:?}");
        }
        assert!(debut.elapsed() < Duration::from_secs(30), "la 2e page n'est jamais demandée");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let kill = std::process::Command::new("kill").args(["-INT", &enfant.id().to_string()]).status().expect("kill -INT");
    assert!(kill.success());
    let statut = Commande::attendre(&mut enfant, Duration::from_secs(15)).await;
    assert_eq!(statut.code(), None, "statut : {statut:?}");
    assert_eq!(statut.signal(), Some(2), "statut : {statut:?}");
    assert!(!statut.success());
    let mut stdout = String::new();
    std::io::Read::read_to_string(&mut enfant.stdout.take().unwrap(), &mut stdout).unwrap();
    assert_eq!(stdout, "");
    assert_eq!(empreinte(&cible.chemin), avant);
}

/// AC-6 (mem0-rs-migration, S-2, S-3, S-7) : une source illisible (clé refusée,
/// collection absente, Qdrant injoignable, history.db absent) donne code 1, stdout
/// vide, le message exact, et aucun fichier ni dossier de la cible n'est créé.
#[tokio::test(flavor = "multi_thread")]
async fn ac6_erreurs_source_sans_ecriture() {
    let cibles = Dossier::nouveau("ac6-erreurs");
    let base = cibles.chemin.join("cible").join("mem0-rs.db");
    let b = base.to_str().unwrap();
    let verifier = |(code, stdout, stderr): (Option<i32>, String, String), attendu: &dyn Fn(&str) -> bool| {
        assert_eq!(code, Some(1), "stderr : {stderr}");
        assert_eq!(stdout, "");
        assert!(attendu(&stderr), "stderr : {stderr:?}");
        assert!(cibles.entrees().is_empty(), "créé : {:?}", cibles.entrees());
    };

    let mut options = OptionsQdrant::new(souvenirs(0, 2, "a6", Forme::Nommee));
    options.cle = Some("bonne-cle".into());
    let protegee = Source::nouvelle("ac6-erreurs-401", options).await;
    let refus = |s: &str| s == "Qdrant refuse la clé API (HTTP 401)\n";
    verifier(protegee.importer(&base, &[], &[("QDRANT_API_KEY", "mauvaise-cle")]).await, &refus);
    verifier(protegee.importer(&base, &[], &[]).await, &refus);
    verifier(protegee.importer(&base, &[], &[("QDRANT_API_KEY", "")]).await, &refus);
    assert_eq!(protegee.importer(&base, &["--dry-run"], &[("QDRANT_API_KEY", "bonne-cle")]).await.0, Some(0));

    let source = Source::nouvelle("ac6-erreurs-404", OptionsQdrant::new(souvenirs(0, 2, "a6", Forme::Nommee))).await;
    let h = source.history.chemin.to_str().unwrap();
    let url_barre = format!("{}/", source.qdrant.url);
    let introuvable = format!("collection autre introuvable sur {}\n", source.qdrant.url);
    verifier(
        Commande::lancer(&["import", "--history-db", h, "--qdrant-url", url_barre.as_str(), "--collection", "autre"], &[("MEM0_DB_PATH", b)]).await,
        &|s| s == introuvable,
    );

    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let ferme = format!("http://127.0.0.1:{port}");
    verifier(
        Commande::lancer(&["import", "--history-db", h, "--qdrant-url", ferme.as_str()], &[("MEM0_DB_PATH", b)]).await,
        &|s| s.starts_with(&format!("Qdrant injoignable ({ferme}")),
    );

    let absent = source.dossier.chemin.join("absent.db");
    let absent = absent.to_str().unwrap();
    verifier(
        Commande::lancer(&["import", "--history-db", absent, "--qdrant-url", &source.qdrant.url], &[("MEM0_DB_PATH", b)]).await,
        &|s| s == format!("history.db introuvable : {absent}\n"),
    );
    assert!(!Path::new(absent).exists());
}

/// AC-7 (mem0-rs-migration, S-4, D-1) : points sans vecteur dense (null, objet sans
/// clé ""), en 768 dims, sans texte, et une ligne d'historique orpheline sont rejetés
/// avec id, raison et détail exacts (code 3) ; les autres souvenirs sont importés,
/// les lignes d'un point rejeté sont tues, et l'historique d'un souvenir supprimé
/// (DELETE) est importé en révisions de l'agent null.
#[tokio::test(flavor = "multi_thread")]
async fn ac7_rejets() {
    let valide = |i: usize, forme| point_mem0(&id_point(i), &format!("souvenir valide {i}"), Some("a7"), i, forme);
    let mut sans_vecteur = valide(1, Forme::Nommee);
    sans_vecteur["vector"] = Value::Null;
    let mut dims_768 = valide(2, Forme::Nue);
    dims_768["vector"] = json!(plonger("souvenir valide 2")[..768]);
    let mut sans_texte = valide(4, Forme::Nommee);
    sans_texte["payload"].as_object_mut().unwrap().shift_remove("data");
    let mut sans_cle_vide = valide(5, Forme::Nommee);
    sans_cle_vide["vector"].as_object_mut().unwrap().shift_remove("");
    let points = vec![
        valide(0, Forme::Nommee),
        sans_vecteur,
        dims_768,
        valide(3, Forme::Nommee),
        sans_texte,
        sans_cle_vide,
        valide(6, Forme::Nue),
    ];
    let source = Source::nouvelle("ac7", OptionsQdrant::new(points.clone())).await;
    let h = &source.history;
    h.ligne(&Revision::mem0("h0", &id_point(0), "ADD", None, Some("souvenir valide 0"), 0));
    h.ligne(&Revision::mem0("h-rejete", &id_point(2), "ADD", None, Some("souvenir valide 2"), 2));
    h.ligne(&Revision::mem0("h-orphelin", "absent-orphelin", "ADD", None, Some("orphelin"), 10));
    h.ligne(&Revision::mem0("h-sup-1", "supprime-1", "ADD", None, Some("souvenir supprimé"), 11));
    h.ligne(&Revision::mem0("h-sup-2", "supprime-1", "DELETE", Some("souvenir supprimé"), None, 12));
    h.ligne(&Revision::mem0("h3", &id_point(3), "ADD", None, Some("souvenir valide 3"), 3));

    let cible = Dossier::nouveau("ac7-cible");
    let (code, stdout, stderr) = source.importer(&cible.base(), &["--json"], &[]).await;
    assert_eq!(code, Some(3), "stdout : {stdout}\nstderr : {stderr}");
    let attendu = rapport(vec![
        agent(
            Some("a7"),
            3,
            0,
            vec![
                rejet("souvenir", &id_point(1), "vecteur_absent", "aucun vecteur dense"),
                rejet("souvenir", &id_point(2), "dimension", "768 dimensions, 1024 attendues"),
                rejet("souvenir", &id_point(4), "texte_absent", "payload sans texte"),
                rejet("souvenir", &id_point(5), "vecteur_absent", "aucun vecteur dense"),
            ],
            2,
            0,
        ),
        agent(None, 0, 0, vec![rejet("historique", "h-orphelin", "historique_orphelin", "memory_id absent-orphelin")], 2, 0),
    ]);
    assert_eq!(json_unique(&stdout), attendu);

    let faux = FauxOpenAI::demarrer().await;
    let s = serveur(&cible.base(), &faux).await;
    let importes: Vec<Value> = [0, 3, 6].iter().map(|&i| points[i].clone()).collect();
    assert_eq!(tous(&s).await, all_attendu(&importes));
    let historique = |id: String| {
        let s = &s;
        async move { ok(&s.appeler("GET", &format!("/memory/{id}/history"), None).await) }
    };
    let sup = historique("supprime-1".into()).await;
    let ids: Vec<&Value> = sup.as_array().expect("historique").iter().map(|l| &l["id"]).collect();
    assert_eq!(ids, [&json!("h-sup-1"), &json!("h-sup-2")]);
    assert_eq!(historique("absent-orphelin".into()).await, json!([]));
    assert_eq!(historique(id_point(2)).await, json!([]));
    assert_eq!(historique(id_point(0)).await.as_array().unwrap().len(), 1);
}

/// AC-8 (mem0-rs-migration, S-2, S-3) : un import réel puis un `--dry-run` n'émettent
/// vers Qdrant que des `POST /collections/omp_memory/points/scroll` au corps exact
/// (offset recopié dès la 2e page), avec `api-key` si QDRANT_API_KEY est posée et
/// sans elle sinon ; history.db garde son sha256 et l'embedder ne reçoit rien.
#[tokio::test(flavor = "multi_thread")]
async fn ac8_lecture_seule() {
    let mut options = OptionsQdrant::new(souvenirs(0, 300, "a8", Forme::Nommee));
    options.cle = Some("cle-ac8".into());
    let source = Source::nouvelle("ac8", options).await;
    for i in 0..5 {
        source.history.ligne(&Revision::mem0(&format!("h{i}"), &id_point(i), "ADD", None, Some("texte"), i));
    }
    source.history.message(Some("m1"), Some("agent_id=a8&user_id=moi"), Some("user"), Some("bonjour"), None, Some(&date_mem0(1)));
    let sha_avant = sha256_fichier(&source.history.chemin);
    let source_avant = empreinte(&source.dossier.chemin);

    let faux = FauxOpenAI::demarrer().await;
    let cibles = Dossier::nouveau("ac8-cibles");
    let env = [("QDRANT_API_KEY", "cle-ac8"), ("OMLX_BASE_URL", faux.base_url.as_str())];
    let (code, _, stderr) = source.importer(&cibles.chemin.join("reel.db"), &[], &env).await;
    assert_eq!(code, Some(0), "stderr : {stderr}");
    let (code, _, stderr) = source.importer(&cibles.chemin.join("simulation.db"), &["--dry-run"], &env).await;
    assert_eq!(code, Some(0), "stderr : {stderr}");

    let page1 = json!({"limit": 256, "with_payload": true, "with_vector": true});
    let page2 = json!({"limit": 256, "with_payload": true, "with_vector": true, "offset": id_point(256)});
    let requetes = source.qdrant.requetes();
    let corps: Vec<Value> = requetes.iter().map(|r| r.json()).collect();
    assert_eq!(corps, [page1.clone(), page2.clone(), page1.clone(), page2]);
    for r in &requetes {
        assert_eq!((r.methode.as_str(), r.chemin.as_str()), ("POST", "/collections/omp_memory/points/scroll"));
        assert_eq!(r.entete("api-key"), Some("cle-ac8"));
    }
    assert_eq!(sha256_fichier(&source.history.chemin), sha_avant);
    assert_eq!(empreinte(&source.dossier.chemin), source_avant);
    assert_eq!(faux.appels(), 0);
    assert!(faux.requetes_chat().is_empty());

    let libre = Source::nouvelle("ac8-sans-cle", OptionsQdrant::new(souvenirs(0, 2, "a8", Forme::Nue))).await;
    let (code, _, stderr) = libre.importer(&cibles.chemin.join("libre.db"), &["--dry-run"], &[("QDRANT_API_KEY", "")]).await;
    assert_eq!(code, Some(0), "stderr : {stderr}");
    let requetes = libre.qdrant.requetes();
    assert_eq!(requetes.len(), 1);
    assert_eq!(requetes[0].json(), page1);
    assert_eq!(requetes[0].entete("api-key"), None, "clé vide : pas d'en-tête");
}

/// Source d'AC-9 : 5 souvenirs sur deux agents, historique et messages.
async fn source_ac9(nom: &str) -> Source {
    let mut points = souvenirs(0, 3, "a9", Forme::Nommee);
    points.extend(souvenirs(3, 2, "b9", Forme::Nue));
    let source = Source::nouvelle(nom, OptionsQdrant::new(points)).await;
    for i in 0..5 {
        source.history.ligne(&Revision::mem0(&format!("h{i}"), &id_point(i), "ADD", None, Some("texte"), i));
    }
    source.history.message(Some("m1"), Some("agent_id=a9&user_id=moi"), Some("user"), Some("bonjour"), None, Some(&date_mem0(1)));
    source
}

/// AC-9 (mem0-rs-migration, S-8) : `--dry-run` vers une cible absente ne crée rien
/// (ni dossier parent, ni base, ni -wal/-shm/.lock), annonce la simulation sur
/// stderr, et son stdout (texte et `--json`) égale celui de l'import réel qui suit ;
/// vers une cible existante (import partiel, servie puis arrêtée), il laisse le
/// dossier octet pour octet et son stdout égale celui de l'import réel qui suit.
#[tokio::test(flavor = "multi_thread")]
async fn ac9_simulation() {
    let source = source_ac9("ac9").await;
    let faux = FauxOpenAI::demarrer().await;
    for format in [&[][..], &["--json"][..]] {
        let cible = Dossier::nouveau("ac9-absente");
        let base = cible.chemin.join("absent").join("sous").join("mem0-rs.db");
        let simulation: Vec<&str> = [&["--dry-run"][..], format].concat();
        let (code, stdout_sim, stderr) = source.importer(&base, &simulation, &[]).await;
        assert_eq!(code, Some(0), "stderr : {stderr}");
        assert!(stderr.lines().any(|l| l == ligne_simulation(&base)), "stderr : {stderr:?}");
        assert!(cible.entrees().is_empty(), "créé : {:?}", cible.entrees());
        let (code, stdout_reel, stderr) = source.importer(&base, format, &[]).await;
        assert_eq!(code, Some(0), "stderr : {stderr}");
        assert!(!stderr.contains("simulation"), "stderr : {stderr}");
        assert_eq!(stdout_sim, stdout_reel, "format {format:?}");
        assert!(stdout_reel.contains('5'), "rapport : {stdout_reel}");

        let cible = Dossier::nouveau("ac9-existante");
        let base = cible.base();
        let partielle = Source::nouvelle("ac9-partielle", OptionsQdrant::new(souvenirs(0, 2, "a9", Forme::Nommee))).await;
        importer_ok(&partielle, &base, &[]).await;
        let s = serveur(&base, &faux).await;
        assert_eq!(tous(&s).await.len(), 2);
        assert_eq!(s.arreter().await.code(), Some(0));
        let avant = empreinte(&cible.chemin);
        let (code, stdout_sim, stderr) = source.importer(&base, &simulation, &[]).await;
        assert_eq!(code, Some(0), "stderr : {stderr}");
        assert!(stderr.lines().any(|l| l == ligne_simulation(&base)), "stderr : {stderr:?}");
        assert_eq!(empreinte(&cible.chemin), avant);
        let stdout_reel = importer_ok(&source, &base, format).await;
        assert_eq!(stdout_sim, stdout_reel, "format {format:?}");
        if format == ["--json"] {
            let r = json_unique(&stdout_reel);
            assert_eq!((&r["totaux"]["importes"], &r["totaux"]["deja_presents"]), (&json!(3), &json!(2)), "{r}");
        }
    }
}

/// Source d'AC-10 : quatre agents (dont un en majuscule, qui trie avant les
/// minuscules), un point sans agent_id, un point rejeté, de l'historique, et des
/// messages dont une portée à agent échappé (`x&y`) sans aucun souvenir.
async fn source_ac10(nom: &str) -> Source {
    let point = |i: usize, agent: Option<&str>| point_mem0(&id_point(i), &format!("souvenir {i} rapport"), agent, i, Forme::Nommee);
    let mut rejete = point(5, Some("b-agent"));
    rejete["vector"][""] = json!(plonger("souvenir 5 rapport")[..768]);
    let points = vec![
        point(0, Some("b-agent")),
        point(1, Some("Zeta")),
        point(2, None),
        point(3, Some("a-agent")),
        point(4, Some("a-agent")),
        rejete,
    ];
    let source = Source::nouvelle(nom, OptionsQdrant::new(points)).await;
    let h = &source.history;
    h.ligne(&Revision::mem0("h0", &id_point(0), "ADD", None, Some("souvenir 0 rapport"), 0));
    h.ligne(&Revision::mem0("h0b", &id_point(0), "UPDATE", Some("souvenir 0 rapport"), Some("souvenir 0 rapport"), 20));
    h.ligne(&Revision::mem0("h1", &id_point(1), "ADD", None, Some("souvenir 1 rapport"), 1));
    h.ligne(&Revision::mem0("h3", &id_point(3), "ADD", None, Some("souvenir 3 rapport"), 3));
    h.ligne(&Revision::mem0("h2", &id_point(2), "ADD", None, Some("souvenir 2 rapport"), 2));
    h.ligne(&Revision::mem0("h5", &id_point(5), "ADD", None, Some("souvenir 5 rapport"), 5));
    for (id, portee) in [
        ("m1", "agent_id=a-agent&user_id=moi"),
        ("m2", "agent_id=a-agent&user_id=moi"),
        ("m3", "agent_id=Zeta&user_id=moi"),
        ("m4", "user_id=moi"),
        ("m5", "agent_id=x%26y&user_id=moi"),
    ] {
        h.message(Some(id), Some(portee), Some("user"), Some("bonjour"), None, Some(&date_mem0(30)));
    }
    source
}

/// AC-10 (mem0-rs-migration, S-9) : avec `--json`, stdout est un unique objet JSON
/// sur une ligne, aux clés dans l'ordre de S-9, agents triés par octets avec null en
/// dernier et comptes exacts ; sans `--json`, le texte porte les mêmes comptes.
#[tokio::test(flavor = "multi_thread")]
async fn ac10_rapport() {
    let source = source_ac10("ac10").await;
    let cibles = Dossier::nouveau("ac10-cibles");
    let attendu = rapport(vec![
        agent(Some("Zeta"), 1, 0, vec![], 1, 1),
        agent(Some("a-agent"), 2, 0, vec![], 1, 2),
        agent(
            Some("b-agent"),
            1,
            0,
            vec![rejet("souvenir", &id_point(5), "dimension", "768 dimensions, 1024 attendues")],
            2,
            0,
        ),
        agent(Some("x&y"), 0, 0, vec![], 0, 1),
        agent(None, 1, 0, vec![], 1, 1),
    ]);
    let (code, stdout, stderr) = source.importer(&cibles.chemin.join("json.db"), &["--json"], &[]).await;
    assert_eq!(code, Some(3), "stderr : {stderr}");
    assert_eq!(stdout, format!("{}\n", serde_json::to_string(&attendu).unwrap()));
    assert_eq!(json_unique(&stdout), attendu);

    let (code, stdout, stderr) = source.importer(&cibles.chemin.join("texte.db"), &[], &[]).await;
    assert_eq!(code, Some(3), "stderr : {stderr}");
    let lignes = [
        "Zeta : 1 importés, 0 déjà présents, 0 rejetés, 1 révisions, 1 messages".to_owned(),
        "a-agent : 2 importés, 0 déjà présents, 0 rejetés, 1 révisions, 2 messages".to_owned(),
        "b-agent : 1 importés, 0 déjà présents, 1 rejetés, 2 révisions, 0 messages".to_owned(),
        format!("  rejet souvenir {} : dimension (768 dimensions, 1024 attendues)", id_point(5)),
        "x&y : 0 importés, 0 déjà présents, 0 rejetés, 0 révisions, 1 messages".to_owned(),
        "(sans agent_id) : 1 importés, 0 déjà présents, 0 rejetés, 1 révisions, 1 messages".to_owned(),
        "total : 5 importés, 0 déjà présents, 1 rejetés, 5 révisions, 5 messages".to_owned(),
    ];
    assert_eq!(stdout, format!("{}\n", lignes.join("\n")));
}

/// AC-11 (mem0-rs-migration, moitié import, S-10) : un import, réel ou `--dry-run`,
/// vers une base servie par un mem0-rs en marche sort en code 1 avec le message de
/// S-10, sans lire la source ni toucher la base ; une fois le serveur arrêté,
/// l'import passe.
#[tokio::test(flavor = "multi_thread")]
async fn ac11_serveur_actif() {
    let source = Source::nouvelle("ac11", OptionsQdrant::new(souvenirs(0, 2, "a11", Forme::Nommee))).await;
    let faux = FauxOpenAI::demarrer().await;
    let cible = Dossier::nouveau("ac11-cible");
    let base = cible.base();
    let s = serveur(&base, &faux).await;
    ok(&s.appeler("POST", "/memory/add", Some(&json!({"text": "souvenir servi", "agent_id": "a11", "infer": false}))).await);
    let octets = |nom: &str| std::fs::read(cible.chemin.join(nom)).ok();
    let avant = (cible.entrees(), octets("mem0-rs.db"), octets("mem0-rs.db-wal"));
    for options in [&[][..], &["--dry-run"][..], &["--json"][..]] {
        let (code, stdout, stderr) = source.importer(&base, options, &[]).await;
        assert_eq!(code, Some(1), "options {options:?}, stderr : {stderr}");
        assert_eq!(stdout, "");
        assert_eq!(stderr, message_verrou(&base), "options {options:?}");
        assert_eq!((cible.entrees(), octets("mem0-rs.db"), octets("mem0-rs.db-wal")), avant);
    }
    assert!(source.qdrant.requetes().is_empty(), "la source ne doit pas être lue");
    assert_eq!(tous(&s).await.len(), 1);
    assert_eq!(s.arreter().await.code(), Some(0));
    importer_ok(&source, &base, &[]).await;
    let s = serveur(&base, &faux).await;
    assert_eq!(tous(&s).await.len(), 3);
}
