//! Client embeddings OpenAI-compatible (D-1 « Embedder OpenAI », D-8).
//!
//! Imite mem0 2.2.1 sur openai-python 3.24.0 : `\n` remplacé par une espace,
//! `{"input":[texte],"model":…,"encoding_format":"float"}` sans `dimensions`,
//! 2 nouvelles tentatives (0,5 s puis 1 s) sur erreur de connexion ou statut
//! 408, 409, 429 ou ≥ 500 ; 600 s par tentative, dont 5 s de connexion.

use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{Value, json};

/// Délais avant chaque nouvelle tentative.
const NOUVELLES_TENTATIVES: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(1000)];

/// Échec de l'embedder : la requête HTTP rend 500 (S-2).
#[derive(Debug)]
pub struct ErreurEmbedding(pub String);

impl std::fmt::Display for ErreurEmbedding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone)]
pub struct Embedder {
    client: reqwest::Client,
    url: String,
    model: String,
    /// Secret : jamais imprimé.
    token: String,
    dims: usize,
}

impl Embedder {
    pub fn new(base_url: &str, model: &str, token: &str, dims: usize) -> Result<Self, ErreurEmbedding> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .connect_timeout(Duration::from_secs(5))
            .no_proxy()
            .build()
            .map_err(|e| ErreurEmbedding(format!("client HTTP : {e}")))?;
        Ok(Embedder {
            client,
            url: format!("{}/embeddings", base_url.trim_end_matches('/')),
            model: model.to_owned(),
            token: token.to_owned(),
            dims,
        })
    }

    /// Vecteur de `texte` (longueur contrôlée = EMBEDDING_DIMS).
    pub async fn plonger(&self, texte: &str) -> Result<Vec<f32>, ErreurEmbedding> {
        let corps = json!({
            "input": [texte.replace('\n', " ")],
            "model": self.model,
            "encoding_format": "float",
        });
        let mut delais = NOUVELLES_TENTATIVES.iter();
        let reponse = loop {
            let essai = self.client.post(&self.url).bearer_auth(&self.token).json(&corps).send().await;
            let a_retenter = match &essai {
                Ok(r) => retentable(r.status()),
                Err(e) => e.is_connect() || e.is_timeout() || e.is_request(),
            };
            match (a_retenter, delais.next()) {
                (true, Some(delai)) => tokio::time::sleep(*delai).await,
                _ => break essai.map_err(|e| ErreurEmbedding(format!("embedder injoignable : {e}")))?,
            }
        };
        let statut = reponse.status();
        if !statut.is_success() {
            return Err(ErreurEmbedding(format!("embedder : statut {statut}")));
        }
        let valeur: Value = reponse
            .json()
            .await
            .map_err(|e| ErreurEmbedding(format!("embedder : réponse illisible : {e}")))?;
        self.vecteur(&valeur)
    }

    fn vecteur(&self, valeur: &Value) -> Result<Vec<f32>, ErreurEmbedding> {
        let composantes = valeur
            .pointer("/data/0/embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| ErreurEmbedding("embedder : data[0].embedding absent".to_owned()))?;
        if composantes.len() != self.dims {
            return Err(ErreurEmbedding(format!(
                "embedder : {} composantes reçues, EMBEDDING_DIMS={}",
                composantes.len(),
                self.dims
            )));
        }
        composantes
            .iter()
            .map(|c| {
                c.as_f64()
                    .map(|x| x as f32)
                    .ok_or_else(|| ErreurEmbedding("embedder : composante non numérique".to_owned()))
            })
            .collect()
    }
}

fn retentable(statut: StatusCode) -> bool {
    matches!(statut.as_u16(), 408 | 409 | 429) || statut.is_server_error()
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
    fn url_et_controle_de_longueur() {
        let e = Embedder::new("http://h/v1/", "m", "k", 3).unwrap();
        assert_eq!(e.url, "http://h/v1/embeddings");
        assert_eq!(e.vecteur(&json!({"data":[{"embedding":[1, 0.5, -2]}]})).unwrap(), vec![1.0, 0.5, -2.0]);
        assert!(e.vecteur(&json!({"data":[{"embedding":[1, 0.5]}]})).is_err());
        assert!(e.vecteur(&json!({"data":[{"embedding":[1, "a", 2]}]})).is_err());
        assert!(e.vecteur(&json!({"data":[]})).is_err());
    }
}
