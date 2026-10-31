//! Banc d'essai des tests d'intégration : faux serveur OpenAI-compatible
//! (embeddings et chat/completions scriptées), lanceur du binaire `mem0-rs` sur un
//! port libre avec une base dans un dossier jetable, et, pour `mem0-rs import`,
//! fausse Qdrant (scroll), history.db au schéma de mem0 et lanceur de commande.

use std::collections::VecDeque;
use std::io::Read;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Notify;

/// Dimension des vecteurs du faux embedder (`DIMENSIONS` de faux-openai.ts).
pub const DIMENSIONS: usize = 1024;

/// `OMLX_API_TOKEN` et `OMLX_LLM_MODEL` des instances lancées par les tests.
pub const JETON_OMLX: &str = "jeton-omlx";
pub const MODELE_CHAT: &str = "modele-chat-test";

/// `plonger` de scripts/mem0-http-contrat/faux-openai.ts : sac de mots haché par
/// sha256, normalisé en L2 ; sans jeton, le vecteur unitaire e0.
///
/// Les jetons sont les suites de caractères alphanumériques Unicode (`\p{L}\p{N}`
/// côté TypeScript ; `char::is_alphanumeric` ici, qui en diffère seulement sur
/// quelques marques combinantes absentes des textes de test).
pub fn plonger(texte: &str) -> Vec<f64> {
    let mut vecteur = vec![0.0f64; DIMENSIONS];
    let minuscules = texte.to_lowercase();
    let jetons: Vec<&str> = minuscules.split(|c: char| !c.is_alphanumeric()).filter(|j| !j.is_empty()).collect();
    for jeton in &jetons {
        let empreinte = Sha256::digest(jeton.as_bytes());
        let indice = u32::from_be_bytes([empreinte[0], empreinte[1], empreinte[2], empreinte[3]]) as usize % DIMENSIONS;
        vecteur[indice] += 1.0;
    }
    if jetons.is_empty() {
        vecteur[0] = 1.0;
    }
    let norme = vecteur.iter().map(|x| x * x).sum::<f64>().sqrt();
    vecteur.iter().map(|x| x / norme).collect()
}

/// Réponse scriptée de `POST /v1/chat/completions`.
#[derive(Debug, Clone)]
pub enum ReponseChat {
    /// 200, `choices[0].message.content` = ce texte.
    Contenu(String),
    /// Ce statut, corps d'erreur OpenAI.
    Statut(u16),
    /// 200, ce corps JSON tel quel (enveloppe incomplète, `content` non textuel…).
    Enveloppe(Value),
}

#[derive(Default)]
struct EtatFaux {
    appels: AtomicUsize,
    textes: Mutex<Vec<String>>,
    entrees: Mutex<Vec<Vec<String>>>,
    file_chat: Mutex<VecDeque<ReponseChat>>,
    requetes_chat: Mutex<Vec<Value>>,
    autorisations_chat: Mutex<Vec<String>>,
}

/// Faux serveur OpenAI-compatible (`POST /v1/embeddings`, `POST /v1/chat/completions`)
/// sur 127.0.0.1:0.
pub struct FauxOpenAI {
    /// Base à passer dans `OMLX_BASE_URL`.
    pub base_url: String,
    etat: Arc<EtatFaux>,
}

impl FauxOpenAI {
    pub async fn demarrer() -> FauxOpenAI {
        let etat = Arc::new(EtatFaux::default());
        let app = axum::Router::new()
            .route("/v1/embeddings", post(embeddings))
            .route("/v1/chat/completions", post(chat))
            .with_state(Arc::clone(&etat));
        let ecoute = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("faux OpenAI : écoute");
        let port = ecoute.local_addr().expect("faux OpenAI : adresse").port();
        tokio::spawn(async move {
            axum::serve(ecoute, app).await.expect("faux OpenAI : service");
        });
        FauxOpenAI { base_url: format!("http://127.0.0.1:{port}/v1"), etat }
    }

    /// Nombre de requêtes d'embeddings reçues.
    pub fn appels(&self) -> usize {
        self.etat.appels.load(Ordering::SeqCst)
    }

    /// Textes reçus par les embeddings, dans l'ordre.
    pub fn textes(&self) -> Vec<String> {
        verrou(&self.etat.textes).clone()
    }

    /// `input` de chaque requête d'embeddings, dans l'ordre.
    pub fn entrees(&self) -> Vec<Vec<String>> {
        verrou(&self.etat.entrees).clone()
    }

    /// Ajoute des réponses à la file de chat/completions ; file vide : `{"memory":[]}`.
    pub fn scripter(&self, reponses: Vec<ReponseChat>) {
        verrou(&self.etat.file_chat).extend(reponses);
    }

    /// Corps des requêtes chat/completions reçues, dans l'ordre.
    pub fn requetes_chat(&self) -> Vec<Value> {
        verrou(&self.etat.requetes_chat).clone()
    }

    /// En-têtes `authorization` des requêtes chat/completions, dans l'ordre.
    pub fn autorisations_chat(&self) -> Vec<String> {
        verrou(&self.etat.autorisations_chat).clone()
    }
}

async fn embeddings(State(etat): State<Arc<EtatFaux>>, Json(corps): Json<Value>) -> Json<Value> {
    etat.appels.fetch_add(1, Ordering::SeqCst);
    let textes: Vec<String> = match &corps["input"] {
        Value::String(s) => vec![s.clone()],
        Value::Array(v) => v.iter().map(|t| t.as_str().expect("input non textuel").to_owned()).collect(),
        autre => panic!("faux embedder : input invalide {autre}"),
    };
    assert_eq!(corps["encoding_format"], "float");
    assert!(corps.get("dimensions").is_none(), "mem0-rs ne doit pas envoyer `dimensions`");
    verrou(&etat.textes).extend(textes.iter().cloned());
    verrou(&etat.entrees).push(textes.clone());
    let data: Vec<Value> = textes
        .iter()
        .enumerate()
        .map(|(index, t)| json!({ "object": "embedding", "index": index, "embedding": plonger(t) }))
        .collect();
    Json(json!({ "object": "list", "data": data, "model": corps["model"], "usage": { "prompt_tokens": 0, "total_tokens": 0 } }))
}

async fn chat(State(etat): State<Arc<EtatFaux>>, entetes: HeaderMap, Json(corps): Json<Value>) -> Response {
    let autorisation = entetes.get("authorization").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default();
    verrou(&etat.autorisations_chat).push(autorisation);
    verrou(&etat.requetes_chat).push(corps.clone());
    let reponse = verrou(&etat.file_chat).pop_front().unwrap_or_else(|| ReponseChat::Contenu(r#"{"memory":[]}"#.into()));
    match reponse {
        ReponseChat::Contenu(contenu) => Json(json!({
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 0,
            "model": corps["model"],
            "choices": [{ "index": 0, "message": { "role": "assistant", "content": contenu }, "finish_reason": "stop" }],
            "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
        }))
        .into_response(),
        ReponseChat::Statut(statut) => (
            StatusCode::from_u16(statut).unwrap(),
            Json(json!({ "error": { "message": "faux OpenAI : erreur scriptée", "type": "server_error" } })),
        )
            .into_response(),
        ReponseChat::Enveloppe(v) => Json(v).into_response(),
    }
}

/// Dossier temporaire unique, supprimé à la fin du test.
pub struct Dossier {
    pub chemin: PathBuf,
}

impl Dossier {
    pub fn nouveau(nom: &str) -> Dossier {
        static COMPTEUR: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let chemin = std::env::temp_dir().join(format!(
            "mem0-rs-test-{nom}-{}-{nanos}-{}",
            std::process::id(),
            COMPTEUR.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&chemin).expect("dossier temporaire");
        Dossier { chemin }
    }

    /// Chemin de la base dans ce dossier.
    pub fn base(&self) -> PathBuf {
        self.chemin.join("mem0-rs.db")
    }

    /// Noms des entrées du dossier, triés.
    pub fn entrees(&self) -> Vec<String> {
        let mut noms: Vec<String> = std::fs::read_dir(&self.chemin)
            .expect("lecture du dossier")
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        noms.sort();
        noms
    }
}

impl Drop for Dossier {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.chemin);
    }
}

/// Réponse HTTP lue en entier.
#[derive(Debug, Clone)]
pub struct Reponse {
    pub statut: u16,
    pub content_type: String,
    pub texte: String,
}

impl Reponse {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.texte).unwrap_or_else(|e| panic!("JSON attendu ({e}) : {}", self.texte))
    }
}

/// Paramètres de lancement de mem0-rs.
pub struct Lancement<'a> {
    pub base: &'a Path,
    pub embedder_url: &'a str,
    pub jeton: &'a str,
    pub installation: &'a str,
}

/// Une instance de mem0-rs lancée par le test ; tuée si le test l'abandonne.
pub struct Serveur {
    enfant: Child,
    pub url: String,
    jeton: String,
    client: reqwest::Client,
    journal: Arc<Mutex<String>>,
}

impl Serveur {
    /// Lance le binaire sur un port libre et attend que /health réponde.
    pub async fn demarrer(l: &Lancement<'_>) -> Serveur {
        Serveur::demarrer_avec(l, &[]).await
    }

    /// [`Serveur::demarrer`] avec des variables d'environnement en plus. La
    /// fusion de recherche héritée du poste (`MEM0_SEARCH_FUSION`, `MEM0_RRF_K`)
    /// est retirée : seules celles de `env` comptent.
    pub async fn demarrer_avec(l: &Lancement<'_>, env: &[(&str, &str)]) -> Serveur {
        for _ in 0..5 {
            let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
            let mut enfant = Command::new(env!("CARGO_BIN_EXE_mem0-rs"))
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .env_remove("MEM0_SEARCH_FUSION")
                .env_remove("MEM0_RRF_K")
                .env_remove("MEM0_DREAM_INTERVAL_MINUTES")
                .env_remove("MEM0_DREAM_QUIET_MINUTES")
                .env_remove("MEM0_DREAM_PAIRS")
                .env_remove("MEM0_DREAM_FORGET_DAYS")
                .env_remove("OMLX_CHAT_BASE_URL")
                .env_remove("OMLX_CHAT_API_TOKEN")
                .env("OMLX_BASE_URL", l.embedder_url)
                .env("OMLX_API_TOKEN", JETON_OMLX)
                .env("OMLX_LLM_MODEL", MODELE_CHAT)
                .env("EMBEDDING_DIMS", DIMENSIONS.to_string())
                .env("MEM0_DB_PATH", l.base)
                .env("MEM0_HTTP_TOKEN", l.jeton)
                .env("OMP_INSTALLATION_TOKEN", l.installation)
                .envs(env.iter().copied())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .expect("lancement de mem0-rs");
            let journal = Arc::new(Mutex::new(String::new()));
            let mut stderr = enfant.stderr.take().unwrap();
            let copie = Arc::clone(&journal);
            std::thread::spawn(move || {
                let mut tampon = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut tampon) {
                    if n == 0 {
                        break;
                    }
                    verrou(&copie).push_str(&String::from_utf8_lossy(&tampon[..n]));
                }
            });
            let mut serveur = Serveur {
                enfant,
                url: format!("http://127.0.0.1:{port}"),
                jeton: l.jeton.to_owned(),
                client: reqwest::Client::builder().no_proxy().build().unwrap(),
                journal,
            };
            match serveur.attendre_sante().await {
                Ok(()) => return serveur,
                Err(journal) if journal.contains("écoute impossible") => continue,
                Err(journal) => panic!("mem0-rs n'a pas démarré : {journal}"),
            }
        }
        panic!("mem0-rs : aucun port libre après 5 essais");
    }

    async fn attendre_sante(&mut self) -> Result<(), String> {
        let debut = Instant::now();
        loop {
            if let Ok(r) = self.client.get(format!("{}/health", self.url)).send().await
                && r.status().is_success()
            {
                return Ok(());
            }
            if let Ok(Some(_)) = self.enfant.try_wait() {
                // Laisse le fil de lecture vider stderr.
                tokio::time::sleep(Duration::from_millis(100)).await;
                return Err(self.journal());
            }
            if debut.elapsed() > Duration::from_secs(30) {
                return Err(format!("délai dépassé ; stderr : {}", self.journal()));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// SIGTERM (`kill -TERM`), puis attend la fin du processus.
    pub async fn arreter(mut self) -> ExitStatus {
        let pid = self.enfant.id().to_string();
        let kill = Command::new("kill").args(["-TERM", &pid]).status().expect("kill -TERM");
        assert!(kill.success(), "kill -TERM {pid} a échoué");
        let debut = Instant::now();
        loop {
            if let Some(statut) = self.enfant.try_wait().expect("attente de mem0-rs") {
                return statut;
            }
            assert!(debut.elapsed() < Duration::from_secs(15), "mem0-rs ne s'arrête pas après SIGTERM");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Ce que le serveur a écrit sur stderr.
    pub fn journal(&self) -> String {
        verrou(&self.journal).clone()
    }

    /// Requête brute : méthode, chemin, corps et en-têtes tels quels.
    pub async fn envoyer(&self, methode: &str, chemin: &str, corps: Option<&str>, entetes: &[(&str, &str)]) -> Reponse {
        let methode = reqwest::Method::from_bytes(methode.as_bytes()).unwrap();
        let mut requete = self.client.request(methode, format!("{}{chemin}", self.url));
        for (nom, valeur) in entetes {
            requete = requete.header(*nom, *valeur);
        }
        if let Some(c) = corps {
            requete = requete.body(c.to_owned());
        }
        let r = requete.send().await.unwrap_or_else(|e| panic!("requête {chemin} : {e} ; stderr : {}", self.journal()));
        let statut = r.status().as_u16();
        let content_type = r
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_owned())
            .unwrap_or_default();
        let texte = r.text().await.unwrap();
        Reponse { statut, content_type, texte }
    }

    /// Requête d'un client correct : corps JSON et jeton du serveur s'il en a un.
    pub async fn appeler(&self, methode: &str, chemin: &str, corps: Option<&Value>) -> Reponse {
        let texte = corps.map(Value::to_string);
        let mut entetes = vec![("content-type", "application/json")];
        if !self.jeton.is_empty() {
            entetes.push(("X-Mem0-Token", self.jeton.as_str()));
        }
        self.envoyer(methode, chemin, texte.as_deref(), &entetes).await
    }
}

impl Drop for Serveur {
    fn drop(&mut self) {
        let _ = self.enfant.kill();
        let _ = self.enfant.wait();
    }
}

/// Verrou sans chemin d'erreur : un test qui a paniqué laisse ses données lisibles.
fn verrou<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// ─── mem0-rs import (mem0-rs-migration, BR-2) ───────────────────────────────

/// Collection lue par défaut par `mem0-rs import`.
pub const COLLECTION: &str = "omp_memory";

/// Forme du champ `vector` d'un point Qdrant (DOC-1 de mem0-rs-migration).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Forme {
    /// `{"": dense, "bm25": {"indices": […], "values": […]}}` (mem0 2.x hybride).
    Nommee,
    /// `[dense]` : point antérieur à l'hybridation, sans vecteur creux.
    Nue,
}

pub fn md5_hex(texte: &str) -> String {
    md5::Md5::digest(texte.as_bytes()).iter().map(|o| format!("{o:02x}")).collect()
}

pub fn sha256_hex(octets: &[u8]) -> String {
    Sha256::digest(octets).iter().map(|o| format!("{o:02x}")).collect()
}

/// sha256 d'un fichier.
pub fn sha256_fichier(chemin: &Path) -> String {
    sha256_hex(&std::fs::read(chemin).unwrap_or_else(|e| panic!("lecture de {} : {e}", chemin.display())))
}

/// Empreinte d'un dossier : ses entrées triées, avec le sha256 de chaque fichier
/// (`<dossier>` pour un sous-dossier, non parcouru).
pub fn empreinte(dossier: &Path) -> Vec<(String, String)> {
    let mut entrees: Vec<(String, String)> = std::fs::read_dir(dossier)
        .unwrap_or_else(|e| panic!("lecture de {} : {e}", dossier.display()))
        .map(|e| {
            let e = e.unwrap();
            let nom = e.file_name().to_string_lossy().into_owned();
            let contenu = if e.file_type().unwrap().is_dir() { "<dossier>".to_owned() } else { sha256_fichier(&e.path()) };
            (nom, contenu)
        })
        .collect();
    entrees.sort();
    entrees
}

/// n-ième instant de test au format de mem0 2.2.1 (`isoformat()` UTC, microsecondes).
pub fn date_mem0(n: usize) -> String {
    format!("2026-10-12T{:02}:{:02}:{:02}.123456+00:00", 10 + n / 3600, (n / 60) % 60, n % 60)
}

/// Id de point stable (uuid en chaîne), croissant avec n.
pub fn id_point(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

/// Vecteur creux `bm25` plausible : un indice par jeton distinct (sha256), poids 1.
pub fn creux(texte: &str) -> Value {
    let mut indices: Vec<u32> = Vec::new();
    for jeton in texte.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|j| !j.is_empty()) {
        let e = Sha256::digest(jeton.as_bytes());
        let indice = u32::from_be_bytes([e[0], e[1], e[2], e[3]]);
        if !indices.contains(&indice) {
            indices.push(indice);
        }
    }
    let values: Vec<f64> = indices.iter().map(|_| 1.0).collect();
    json!({ "indices": indices, "values": values })
}

/// Payload d'un souvenir écrit par mem0 2.2.1 (`add infer=false` avec tags) :
/// created_at = updated_at = `date_mem0(n)`.
pub fn payload_mem0(data: &str, agent_id: Option<&str>, n: usize) -> Value {
    let mut p = json!({ "tags": "import", "user_id": "moi" });
    if let Some(a) = agent_id {
        p["agent_id"] = json!(a);
    }
    p["role"] = json!("user");
    p["data"] = json!(data);
    p["hash"] = json!(md5_hex(data));
    p["created_at"] = json!(date_mem0(n));
    p["updated_at"] = json!(date_mem0(n));
    p["text_lemmatized"] = json!(data);
    p
}

/// Record de scroll `{id, payload, vector}` d'un souvenir, dense = `plonger(data)`.
pub fn point_mem0(id: &str, data: &str, agent_id: Option<&str>, n: usize, forme: Forme) -> Value {
    let dense = plonger(data);
    let vector = match forme {
        Forme::Nommee => json!({ "": dense, "bm25": creux(data) }),
        Forme::Nue => json!(dense),
    };
    json!({ "id": id, "payload": payload_mem0(data, agent_id, n), "vector": vector })
}

/// Requête reçue par la fausse Qdrant.
#[derive(Debug, Clone)]
pub struct RequeteQdrant {
    pub methode: String,
    /// Chemin et requête (`/collections/…?…`).
    pub chemin: String,
    pub entetes: Vec<(String, String)>,
    pub corps: String,
}

impl RequeteQdrant {
    pub fn entete(&self, nom: &str) -> Option<&str> {
        self.entetes.iter().find(|(n, _)| n.eq_ignore_ascii_case(nom)).map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Value {
        serde_json::from_str(&self.corps).unwrap_or_else(|e| panic!("corps JSON attendu ({e}) : {}", self.corps))
    }
}

/// Comportement de la fausse Qdrant.
pub struct OptionsQdrant {
    /// Seule collection connue ; toute autre rend 404.
    pub collection: String,
    /// Records `{id, payload, vector}` servis dans cet ordre.
    pub points: Vec<Value>,
    /// Clé exigée dans l'en-tête `api-key` (absente ou fausse : 401).
    pub cle: Option<String>,
    /// Après la page n servie, la Qdrant cesse d'écouter et coupe ses connexions.
    pub coupure_apres: Option<usize>,
    /// Attente avant de servir la page n.
    pub delai_avant: Option<(usize, Duration)>,
}

impl OptionsQdrant {
    pub fn new(points: Vec<Value>) -> OptionsQdrant {
        OptionsQdrant { collection: COLLECTION.to_owned(), points, cle: None, coupure_apres: None, delai_avant: None }
    }
}

struct EtatQdrant {
    options: OptionsQdrant,
    pages: AtomicUsize,
    requetes: Mutex<Vec<RequeteQdrant>>,
    coupe: Arc<AtomicBool>,
    arret: Arc<Notify>,
}

/// Fausse Qdrant sur 127.0.0.1:0 : `POST /collections/{collection}/points/scroll`
/// paginé par `limit`/`offset` ; toute requête, sur toute route, est enregistrée.
pub struct FauxQdrant {
    /// Base, sans barre oblique finale.
    pub url: String,
    etat: Arc<EtatQdrant>,
}

impl FauxQdrant {
    pub async fn demarrer(options: OptionsQdrant) -> FauxQdrant {
        let coupe = Arc::new(AtomicBool::new(false));
        let arret = Arc::new(Notify::new());
        let etat = Arc::new(EtatQdrant {
            options,
            pages: AtomicUsize::new(0),
            requetes: Mutex::new(Vec::new()),
            coupe: Arc::clone(&coupe),
            arret: Arc::clone(&arret),
        });
        let app = axum::Router::new().fallback(qdrant).with_state(Arc::clone(&etat));
        let ecoute = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("fausse Qdrant : écoute");
        let port = ecoute.local_addr().expect("fausse Qdrant : adresse").port();
        let ecoute = EcouteCoupable { ecoute: Some(ecoute), coupe, arret };
        tokio::spawn(async move {
            axum::serve(ecoute, app).await.expect("fausse Qdrant : service");
        });
        FauxQdrant { url: format!("http://127.0.0.1:{port}"), etat }
    }

    /// Requêtes reçues, dans l'ordre d'arrivée.
    pub fn requetes(&self) -> Vec<RequeteQdrant> {
        verrou(&self.etat.requetes).clone()
    }
}

async fn qdrant(State(etat): State<Arc<EtatQdrant>>, methode: Method, uri: Uri, entetes: HeaderMap, corps: Bytes) -> Response {
    verrou(&etat.requetes).push(RequeteQdrant {
        methode: methode.to_string(),
        chemin: uri.path_and_query().map(|p| p.as_str().to_owned()).unwrap_or_default(),
        entetes: entetes
            .iter()
            .map(|(n, v)| (n.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
            .collect(),
        corps: String::from_utf8_lossy(&corps).into_owned(),
    });
    let o = &etat.options;
    let erreur = |statut: StatusCode, message: String| {
        (statut, Json(json!({ "status": { "error": message }, "time": 0.0 }))).into_response()
    };
    if let Some(cle) = &o.cle
        && entetes.get("api-key").map(|v| v.as_bytes()) != Some(cle.as_bytes())
    {
        return (StatusCode::UNAUTHORIZED, "Must provide an API key or an Authorization bearer token").into_response();
    }
    let segments: Vec<&str> = uri.path().split('/').collect();
    let ["", "collections", collection, "points", "scroll"] = segments.as_slice() else {
        return erreur(StatusCode::NOT_FOUND, format!("route inconnue {methode} {}", uri.path()));
    };
    if methode != Method::POST {
        return erreur(StatusCode::METHOD_NOT_ALLOWED, format!("méthode {methode}"));
    }
    if *collection != o.collection {
        return erreur(StatusCode::NOT_FOUND, format!("Not found: Collection `{collection}` doesn't exist!"));
    }
    let page = etat.pages.fetch_add(1, Ordering::SeqCst) + 1;
    if o.coupure_apres.is_some_and(|n| page > n) {
        // L'écriture de cette réponse échoue : la connexion est fermée sans réponse.
        etat.coupe.store(true, Ordering::SeqCst);
        etat.arret.notify_one();
        return erreur(StatusCode::SERVICE_UNAVAILABLE, "coupée".into());
    }
    if let Some((n, delai)) = o.delai_avant
        && n == page
    {
        tokio::time::sleep(delai).await;
    }
    let Ok(requete) = serde_json::from_slice::<Value>(&corps) else {
        return erreur(StatusCode::BAD_REQUEST, "corps non JSON".into());
    };
    let limite = requete.get("limit").and_then(Value::as_u64).unwrap_or(10) as usize;
    let debut = match requete.get("offset") {
        None | Some(Value::Null) => 0,
        Some(offset) => match o.points.iter().position(|p| &p["id"] == offset) {
            Some(i) => i,
            None => return erreur(StatusCode::BAD_REQUEST, format!("offset inconnu {offset}")),
        },
    };
    let fin = (debut + limite).min(o.points.len());
    let suivant = o.points.get(fin).map(|p| p["id"].clone()).unwrap_or(Value::Null);
    Json(json!({
        "result": { "points": &o.points[debut..fin], "next_page_offset": suivant },
        "status": "ok",
        "time": 0.001,
    }))
    .into_response()
}

/// Écoute qui, une fois coupée, ferme sa socket (connexions refusées) ; ses
/// connexions déjà ouvertes échouent à la lecture et à l'écriture suivantes.
struct EcouteCoupable {
    ecoute: Option<tokio::net::TcpListener>,
    coupe: Arc<AtomicBool>,
    arret: Arc<Notify>,
}

impl axum::serve::Listener for EcouteCoupable {
    type Io = FluxCoupable;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (FluxCoupable, SocketAddr) {
        loop {
            let Some(ecoute) = &self.ecoute else {
                std::future::pending::<()>().await;
                continue;
            };
            let coupee = tokio::select! {
                r = ecoute.accept() => match r {
                    Ok((flux, adresse)) => return (FluxCoupable { flux, coupe: Arc::clone(&self.coupe) }, adresse),
                    Err(_) => false,
                },
                () = self.arret.notified() => true,
            };
            if coupee {
                self.ecoute = None;
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        match &self.ecoute {
            Some(e) => e.local_addr(),
            None => Err(std::io::ErrorKind::NotConnected.into()),
        }
    }
}

struct FluxCoupable {
    flux: tokio::net::TcpStream,
    coupe: Arc<AtomicBool>,
}

impl FluxCoupable {
    fn coupure(&self) -> Option<std::io::Error> {
        self.coupe.load(Ordering::SeqCst).then(|| std::io::ErrorKind::ConnectionReset.into())
    }
}

impl AsyncRead for FluxCoupable {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        match self.coupure() {
            Some(e) => Poll::Ready(Err(e)),
            None => Pin::new(&mut self.get_mut().flux).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for FluxCoupable {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        match self.coupure() {
            Some(e) => Poll::Ready(Err(e)),
            None => Pin::new(&mut self.get_mut().flux).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.coupure() {
            Some(e) => Poll::Ready(Err(e)),
            None => Pin::new(&mut self.get_mut().flux).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().flux).poll_shutdown(cx)
    }
}

/// Ligne de la table `history` de mem0 2.2.1 ; `None` = NULL.
#[derive(Debug, Clone, Default)]
pub struct Revision {
    pub id: Option<String>,
    pub memory_id: Option<String>,
    pub old_memory: Option<String>,
    pub new_memory: Option<String>,
    pub event: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub is_deleted: Option<i64>,
    pub actor_id: Option<String>,
    pub role: Option<String>,
}

impl Revision {
    /// Ligne écrite par mem0 2.2.1 pour `event` (ADD, UPDATE, DELETE) : created_at
    /// = `date_mem0(n)`, updated_at NULL pour ADD et `date_mem0(n + 1)` sinon,
    /// is_deleted 1 pour DELETE, role "user".
    pub fn mem0(id: &str, memory_id: &str, event: &str, ancien: Option<&str>, nouveau: Option<&str>, n: usize) -> Revision {
        Revision {
            id: Some(id.to_owned()),
            memory_id: Some(memory_id.to_owned()),
            old_memory: ancien.map(str::to_owned),
            new_memory: nouveau.map(str::to_owned),
            event: Some(event.to_owned()),
            created_at: Some(date_mem0(n)),
            updated_at: (event != "ADD").then(|| date_mem0(n + 1)),
            is_deleted: Some(i64::from(event == "DELETE")),
            actor_id: None,
            role: Some("user".to_owned()),
        }
    }
}

/// history.db au schéma exact de mem0 2.2.1 (`SQLiteManager`), journal rollback.
pub struct HistoryDb {
    pub chemin: PathBuf,
}

impl HistoryDb {
    pub fn nouveau(chemin: &Path) -> HistoryDb {
        let conn = rusqlite::Connection::open(chemin).expect("history.db : création");
        let mode: String = conn.query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "delete");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS history (
                id           TEXT PRIMARY KEY,
                memory_id    TEXT,
                old_memory   TEXT,
                new_memory   TEXT,
                event        TEXT,
                created_at   DATETIME,
                updated_at   DATETIME,
                is_deleted   INTEGER,
                actor_id     TEXT,
                role         TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
                id            TEXT PRIMARY KEY,
                session_scope TEXT,
                role          TEXT,
                content       TEXT,
                name          TEXT,
                created_at    DATETIME
            );",
        )
        .expect("history.db : schéma");
        HistoryDb { chemin: chemin.to_owned() }
    }

    fn connexion(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(&self.chemin).expect("history.db : ouverture")
    }

    pub fn ligne(&self, r: &Revision) {
        self.connexion()
            .execute(
                "INSERT INTO history (id, memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    r.id, r.memory_id, r.old_memory, r.new_memory, r.event, r.created_at, r.updated_at, r.is_deleted, r.actor_id,
                    r.role
                ],
            )
            .expect("history.db : insertion history");
    }

    pub fn message(
        &self,
        id: Option<&str>,
        session_scope: Option<&str>,
        role: Option<&str>,
        content: Option<&str>,
        name: Option<&str>,
        created_at: Option<&str>,
    ) {
        self.connexion()
            .execute(
                "INSERT INTO messages (id, session_scope, role, content, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, session_scope, role, content, name, created_at],
            )
            .expect("history.db : insertion messages");
    }
}

/// Lanceur de `mem0-rs` en ligne de commande, environnement vidé : seules
/// `EMBEDDING_DIMS=1024` et les variables passées par le test sont posées
/// (`MEM0_DB_PATH` obligatoire ; pas de `QDRANT_API_KEY`, `HOME` ni proxy hérités).
pub struct Commande;

impl Commande {
    fn preparer(args: &[&str], env: &[(&str, &str)]) -> Command {
        assert!(env.iter().any(|(n, _)| *n == "MEM0_DB_PATH"), "MEM0_DB_PATH doit être passée par le test");
        let mut c = Command::new(env!("CARGO_BIN_EXE_mem0-rs"));
        c.env_clear().env("EMBEDDING_DIMS", DIMENSIONS.to_string()).args(args).stdin(Stdio::null());
        for (nom, valeur) in env {
            c.env(nom, valeur);
        }
        c
    }

    /// Lance et attend la fin : (code, stdout, stderr).
    pub async fn lancer(args: &[&str], env: &[(&str, &str)]) -> (Option<i32>, String, String) {
        let mut c = Commande::preparer(args, env);
        let sortie = tokio::task::spawn_blocking(move || c.output()).await.unwrap().expect("lancement de mem0-rs");
        (
            sortie.status.code(),
            String::from_utf8(sortie.stdout).expect("stdout UTF-8"),
            String::from_utf8(sortie.stderr).expect("stderr UTF-8"),
        )
    }

    /// Lance sans attendre (stdout et stderr en tubes).
    pub fn demarrer(args: &[&str], env: &[(&str, &str)]) -> Child {
        Commande::preparer(args, env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("lancement de mem0-rs")
    }

    /// Attend la fin d'un processus lancé par `demarrer`.
    pub async fn attendre(enfant: &mut Child, delai: Duration) -> ExitStatus {
        let debut = Instant::now();
        loop {
            if let Some(statut) = enfant.try_wait().expect("attente de mem0-rs") {
                return statut;
            }
            if debut.elapsed() > delai {
                let _ = enfant.kill();
                panic!("mem0-rs ne s'est pas terminé en {delai:?}");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
