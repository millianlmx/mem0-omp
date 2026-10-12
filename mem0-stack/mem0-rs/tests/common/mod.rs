//! Banc d'essai des tests HTTP : faux serveur OpenAI-compatible (embeddings et
//! chat/completions scriptées) et lanceur du binaire `mem0-rs` sur un port libre,
//! avec une base dans un dossier jetable.

use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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
        for _ in 0..5 {
            let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
            let mut enfant = Command::new(env!("CARGO_BIN_EXE_mem0-rs"))
                .args(["--host", "127.0.0.1", "--port", &port.to_string()])
                .env("OMLX_BASE_URL", l.embedder_url)
                .env("OMLX_API_TOKEN", JETON_OMLX)
                .env("OMLX_LLM_MODEL", MODELE_CHAT)
                .env("EMBEDDING_DIMS", DIMENSIONS.to_string())
                .env("MEM0_DB_PATH", l.base)
                .env("MEM0_HTTP_TOKEN", l.jeton)
                .env("OMP_INSTALLATION_TOKEN", l.installation)
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
