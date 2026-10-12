//! Client embeddings OpenAI-compatible (D-1 « Embedder OpenAI », D-8).
//!
//! Imite mem0 2.2.1 sur openai-python 3.24.0 : `\n` remplacé par une espace,
//! `{"input":[texte…],"model":…,"encoding_format":"float"}` sans `dimensions`.
//! Délais et nouvelles tentatives : [`crate::openai::poster`].

use serde_json::{Value, json};

use crate::openai;

/// Nombre maximal de textes par requête de [`Embedder::plonger_lot`] (`embed_batch`).
const TEXTES_PAR_LOT: usize = 100;

/// Échec de l'embedder : la requête HTTP rend 500 (S-2).
#[derive(Debug)]
pub struct ErreurEmbedding(pub String);

impl std::fmt::Display for ErreurEmbedding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<openai::ErreurOpenAI> for ErreurEmbedding {
    fn from(e: openai::ErreurOpenAI) -> Self {
        ErreurEmbedding(format!("embedder : {e}"))
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
    pub fn new(client: reqwest::Client, base_url: &str, model: &str, token: &str, dims: usize) -> Self {
        Embedder { client, url: openai::url(base_url, "embeddings"), model: model.to_owned(), token: token.to_owned(), dims }
    }

    /// Vecteur de `texte` (longueur contrôlée = EMBEDDING_DIMS).
    pub async fn plonger(&self, texte: &str) -> Result<Vec<f32>, ErreurEmbedding> {
        let mut vecteurs = self.requete(std::slice::from_ref(&texte)).await?;
        Ok(vecteurs.swap_remove(0))
    }

    /// Vecteurs de `textes`, dans leur ordre, par lots de 100 (`embed_batch`) ;
    /// une liste vide n'émet aucune requête. Un lot en échec fait échouer le tout.
    pub async fn plonger_lot(&self, textes: &[String]) -> Result<Vec<Vec<f32>>, ErreurEmbedding> {
        let mut vecteurs = Vec::with_capacity(textes.len());
        for lot in textes.chunks(TEXTES_PAR_LOT) {
            vecteurs.extend(self.requete(lot).await?);
        }
        Ok(vecteurs)
    }

    /// Une requête embeddings pour `textes` (non vide) : un vecteur par texte.
    async fn requete(&self, textes: &[impl AsRef<str>]) -> Result<Vec<Vec<f32>>, ErreurEmbedding> {
        let entrees: Vec<String> = textes.iter().map(|t| t.as_ref().replace('\n', " ")).collect();
        let corps = json!({
            "input": entrees,
            "model": self.model,
            "encoding_format": "float",
        });
        let valeur = openai::poster(&self.client, &self.url, &self.token, &corps).await?;
        self.vecteurs(&valeur, textes.len())
    }

    /// Les `n` vecteurs de `data`, rangés par `index` (en son absence, l'ordre
    /// reçu), chacun de longueur EMBEDDING_DIMS.
    fn vecteurs(&self, valeur: &Value, n: usize) -> Result<Vec<Vec<f32>>, ErreurEmbedding> {
        let data = valeur
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| ErreurEmbedding("embedder : data absent".to_owned()))?;
        if data.len() != n {
            return Err(ErreurEmbedding(format!("embedder : {} vecteurs reçus pour {n} textes", data.len())));
        }
        let mut ranges: Vec<(u64, &Value)> = data
            .iter()
            .enumerate()
            .map(|(i, d)| (d.get("index").and_then(Value::as_u64).unwrap_or(i as u64), d))
            .collect();
        ranges.sort_by_key(|(index, _)| *index);
        ranges.into_iter().map(|(_, d)| self.vecteur(d)).collect()
    }

    fn vecteur(&self, donnee: &Value) -> Result<Vec<f32>, ErreurEmbedding> {
        let composantes = donnee
            .get("embedding")
            .and_then(Value::as_array)
            .ok_or_else(|| ErreurEmbedding("embedder : embedding absent".to_owned()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn embedder() -> Embedder {
        Embedder::new(openai::client().unwrap(), "http://h/v1/", "m", "k", 3)
    }

    #[test]
    fn url_et_controle_de_longueur() {
        let e = embedder();
        assert_eq!(e.url, "http://h/v1/embeddings");
        assert_eq!(e.vecteurs(&json!({"data":[{"embedding":[1, 0.5, -2]}]}), 1).unwrap(), vec![vec![1.0, 0.5, -2.0]]);
        assert!(e.vecteurs(&json!({"data":[{"embedding":[1, 0.5]}]}), 1).is_err());
        assert!(e.vecteurs(&json!({"data":[{"embedding":[1, "a", 2]}]}), 1).is_err());
        assert!(e.vecteurs(&json!({"data":[]}), 1).is_err());
    }

    #[test]
    fn ac1_lot_range_par_index_et_compte_controle() {
        let e = embedder();
        let data = json!({"data":[
            {"index": 1, "embedding": [0, 1, 0]},
            {"index": 0, "embedding": [1, 0, 0]},
        ]});
        assert_eq!(e.vecteurs(&data, 2).unwrap(), vec![vec![1.0, 0.0, 0.0], vec![0.0, 1.0, 0.0]]);
        assert!(e.vecteurs(&data, 3).is_err(), "nombre de vecteurs différent du nombre de textes");
    }
}
