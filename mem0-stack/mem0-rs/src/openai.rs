//! Appels à l'API OpenAI-compatible (oMLX) : une seule politique, partagée par
//! les embeddings et par chat/completions (D-3).
//!
//! Imite openai-python 3.24.0 tel que mem0 2.2.1 l'utilise : 600 s par
//! tentative dont 5 s de connexion, sans proxy ; 2 nouvelles tentatives (0,5 s
//! puis 1 s) sur erreur de connexion, de délai ou de requête, et sur les statuts
//! 408, 409, 429 et ≥ 500. `Retry-After`, `x-should-retry` et la gigue ne sont
//! pas repris (non-objectifs de S-1).

use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{Value, json};

use crate::extraction;

/// Délais avant chaque nouvelle tentative.
const NOUVELLES_TENTATIVES: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(1000)];

/// Paramètres d'échantillonnage : défauts d'`OpenAIConfig` de mem0 (D-2).
const MAX_TOKENS: u32 = 2000;
const TEMPERATURE: f64 = 0.1;
const TOP_P: f64 = 0.1;

/// Échec d'un appel : la requête HTTP de mem0-rs rend 500.
#[derive(Debug)]
pub struct ErreurOpenAI(pub String);

impl std::fmt::Display for ErreurOpenAI {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Le client HTTP commun (délais d'openai-python, sans proxy).
pub fn client() -> Result<reqwest::Client, ErreurOpenAI> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .connect_timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .map_err(|e| ErreurOpenAI(format!("client HTTP : {e}")))
}

/// `{base sans "/" final}/<chemin>`.
pub fn url(base: &str, chemin: &str) -> String {
    format!("{}/{chemin}", base.trim_end_matches('/'))
}

/// POST JSON avec les nouvelles tentatives ; rend le corps JSON d'une réponse 2xx.
pub async fn poster(client: &reqwest::Client, url: &str, jeton: &str, corps: &Value) -> Result<Value, ErreurOpenAI> {
    let mut delais = NOUVELLES_TENTATIVES.iter();
    let reponse = loop {
        let essai = client.post(url).bearer_auth(jeton).json(corps).send().await;
        let a_retenter = match &essai {
            Ok(r) => retentable(r.status()),
            Err(e) => e.is_connect() || e.is_timeout() || e.is_request(),
        };
        match (a_retenter, delais.next()) {
            (true, Some(delai)) => tokio::time::sleep(*delai).await,
            _ => break essai.map_err(|e| ErreurOpenAI(format!("{url} injoignable : {e}")))?,
        }
    };
    let statut = reponse.status();
    if !statut.is_success() {
        return Err(ErreurOpenAI(format!("{url} : statut {statut}")));
    }
    reponse.json().await.map_err(|e| ErreurOpenAI(format!("{url} : réponse illisible : {e}")))
}

fn retentable(statut: StatusCode) -> bool {
    matches!(statut.as_u16(), 408 | 409 | 429) || statut.is_server_error()
}

/// Client chat/completions de l'extraction (S-1).
#[derive(Clone)]
pub struct ClientChat {
    client: reqwest::Client,
    url: String,
    model: String,
    /// Secret : jamais imprimé.
    jeton: String,
}

impl ClientChat {
    pub fn new(client: reqwest::Client, base_url: &str, model: &str, jeton: &str) -> ClientChat {
        ClientChat { client, url: url(base_url, "chat/completions"), model: model.to_owned(), jeton: jeton.to_owned() }
    }

    /// Corps exact de la requête (6 clés, dans l'ordre d'openai-python).
    fn corps(&self, system: &str, user: &str) -> Value {
        json!({
            "model": self.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "max_tokens": MAX_TOKENS,
            "response_format": { "type": "json_object" },
            "temperature": TEMPERATURE,
            "top_p": TOP_P,
        })
    }

    /// Un appel en mode JSON ; rend le contenu de `choices[0].message` (S-1).
    pub async fn completer(&self, system: &str, user: &str) -> Result<String, ErreurOpenAI> {
        let reponse = poster(&self.client, &self.url, &self.jeton, &self.corps(system, user)).await?;
        let message = reponse
            .pointer("/choices/0/message")
            .and_then(Value::as_object)
            .ok_or_else(|| ErreurOpenAI(format!("{} : choices[0].message absent", self.url)))?;
        Ok(extraction::contenu_reponse(message.get("content").unwrap_or(&Value::Null)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuts_retentables() {
        for s in [408, 409, 429, 500, 502, 503, 599] {
            assert!(retentable(StatusCode::from_u16(s).unwrap()), "{s}");
        }
        for s in [200, 400, 401, 404, 422] {
            assert!(!retentable(StatusCode::from_u16(s).unwrap()), "{s}");
        }
    }

    #[test]
    fn ac2_corps_chat_six_cles_dans_l_ordre() {
        let c = ClientChat::new(client().unwrap(), "http://h/v1/", "modele", "k");
        assert_eq!(c.url, "http://h/v1/chat/completions");
        assert_eq!(
            serde_json::to_string(&c.corps("S", "U")).unwrap(),
            r#"{"model":"modele","messages":[{"role":"system","content":"S"},{"role":"user","content":"U"}],"max_tokens":2000,"response_format":{"type":"json_object"},"temperature":0.1,"top_p":0.1}"#
        );
    }
}
