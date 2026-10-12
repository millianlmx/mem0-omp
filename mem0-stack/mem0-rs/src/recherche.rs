//! Recherche hybride (S-5) : reproduction de `Memory._search_vector_store`
//! (mem0/memory/main.py:3330-3431) et de `mem0/utils/scoring.py` de mem0ai
//! 2.2.1 (D-1). entity_boost y est inactif (spaCy absent) : il vaut toujours 0.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use crate::bm25::{self, VecteurCreux};
use crate::config::{blanc_python, strip_python};
use crate::db::{self, Souvenir};
use crate::validation::SearchRequest;

/// `threshold=None` de mem0 (main.py:3331-3332).
const SEUIL_PAR_DEFAUT: f64 = 0.1;
/// Plancher du sur-échantillonnage `max(limit*4, 60)`.
const CANDIDATS_MIN: usize = 60;

/// Refus d'une recherche avant tout embedding et toute lecture.
#[derive(Debug, PartialEq)]
pub enum Refus {
    /// 500 : `ValueError` de mem0 (requête vide, seuil hors [0, 1], limite
    /// négative) ou valeur de filtre que `MatchValue` de qdrant_client refuse.
    Interne,
    /// 501 : opérateurs de `filters` (non-objectif de S-5).
    FiltresAvances,
}

/// Une recherche validée.
#[derive(Debug)]
pub struct Requete {
    /// La requête trimée, qui sert à tout le reste.
    pub query: String,
    user_id: String,
    agent_id: Option<String>,
    limit: usize,
    threshold: f64,
    /// Filtres d'égalité après la fusion de `scope_filters` : `None` = une valeur
    /// (nombre entier, booléen) qui ne correspond à aucun champ texte.
    filtres: Vec<(String, Option<String>)>,
}

/// Validation et fusion des filtres (S-5, étapes 1-2). `agent_id` est déjà
/// passé par le contrôle des identifiants de portée (S-2).
pub fn preparer(req: SearchRequest, user_id: &str, agent_id: Option<String>) -> Result<Requete, Refus> {
    let query = strip_python(&req.query);
    let threshold = req.threshold.unwrap_or(SEUIL_PAR_DEFAUT);
    if query.is_empty() || !(0.0..=1.0).contains(&threshold) || req.limit < 0 {
        return Err(Refus::Interne);
    }
    // `scope_filters` : les filtres du client d'abord, la portée par-dessus.
    let mut fusion = req.filters.unwrap_or_default();
    fusion.insert("user_id".to_owned(), Value::from(user_id));
    if let Some(a) = &agent_id {
        fusion.insert("agent_id".to_owned(), Value::from(a.as_str()));
    }
    let avance = |cle: &str, v: &Value| {
        matches!(cle, "AND" | "OR" | "NOT" | "$and" | "$or" | "$not")
            || matches!(v, Value::Object(_) | Value::Array(_))
            || v.as_str() == Some("*")
    };
    if fusion.iter().any(|(cle, v)| avance(cle, v)) {
        return Err(Refus::FiltresAvances);
    }
    let filtres = fusion
        .into_iter()
        .map(|(cle, v)| match v {
            Value::String(s) => Ok((cle, Some(s))),
            Value::Bool(_) => Ok((cle, None)),
            Value::Number(n) if n.is_i64() => Ok((cle, None)),
            // Flottant, entier hors int64, null : refusés par `MatchValue`.
            _ => Err(Refus::Interne),
        })
        .collect::<Result<_, _>>()?;
    Ok(Requete {
        query: query.to_owned(),
        user_id: user_id.to_owned(),
        agent_id,
        limit: usize::try_from(req.limit).unwrap_or(usize::MAX),
        threshold,
        filtres,
    })
}

/// Valeur d'un champ du payload Qdrant de mem0 : `None` = clé absente,
/// `Some(None)` = `null`.
fn champ<'a>(s: &'a Souvenir, cle: &str) -> Option<Option<&'a str>> {
    match cle {
        "user_id" => Some(Some(&s.user_id)),
        "agent_id" => s.agent_id.as_deref().map(Some),
        "run_id" => s.run_id.as_deref().map(Some),
        "role" => s.role.as_deref().map(Some),
        "tags" => s.tags.as_ref().map(|t| t.as_deref()),
        "data" | "text_lemmatized" => Some(Some(&s.memory)),
        "hash" => Some(Some(&s.hash)),
        "created_at" => Some(Some(&s.created_at)),
        "updated_at" => Some(Some(&s.updated_at)),
        _ => None,
    }
}

fn correspond(s: &Souvenir, filtres: &[(String, Option<String>)]) -> bool {
    filtres.iter().all(|(cle, attendu)| attendu.as_deref().is_some_and(|a| champ(s, cle) == Some(Some(a))))
}

/// `get_bm25_params` (scoring.py:16-40) : (midpoint, steepness) selon le nombre
/// de mots de la requête.
pub fn parametres_bm25(mots: usize) -> (f64, f64) {
    match mots {
        0..=3 => (5.0, 0.7),
        4..=6 => (7.0, 0.6),
        7..=9 => (9.0, 0.5),
        10..=15 => (10.0, 0.5),
        _ => (12.0, 0.5),
    }
}

/// `normalize_bm25` (scoring.py:43-55) : sigmoïde.
pub fn normaliser_bm25(brut: f64, milieu: f64, pente: f64) -> f64 {
    1.0 / (1.0 + (-pente * (brut - milieu)).exp())
}

/// IDF de Qdrant (D-5) : `ln((N − n + 0.5)/(n + 0.5) + 1)`.
fn idf(total: u64, n: u64) -> f64 {
    let (total, n) = (total as f64, n as f64);
    ((total - n + 0.5) / (n + 0.5) + 1.0).ln()
}

/// Score brut d'un document : `Σ q_i·idf_i·d_i` sur les indices communs.
fn score_bm25(requete: &[(u32, f32)], document: &VecteurCreux, idf: &HashMap<u32, f64>) -> f64 {
    let poids: HashMap<u32, f32> = document.iter().copied().collect();
    requete
        .iter()
        .filter_map(|(i, q)| Some(f64::from(*q) * idf.get(i)? * f64::from(*poids.get(i)?)))
        .sum()
}

/// `score_details` de mem0, dans l'ordre de ses clés.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Details {
    pub semantic_score: f64,
    pub bm25_score: f64,
    pub entity_boost: f64,
    pub raw_score: f64,
    pub max_possible_score: f64,
    pub final_score: f64,
    pub threshold: f64,
}

/// Un candidat sémantique, dans l'ordre dense.
#[derive(Debug, Clone, Copy)]
pub struct Candidat {
    pub cosinus: f64,
    /// Score BM25 normalisé (0 si le souvenir n'est pas un hit BM25).
    pub bm25: f64,
    /// `memory` vide : retiré après la troncature.
    pub vide: bool,
}

/// `score_and_rank` (scoring.py:61-139) puis le retrait des lignes à `data`
/// vide (main.py:3405) : (indice du candidat, détails), au plus `limit`.
/// `bm25_actif` = au moins un hit BM25 retenu, même hors des candidats.
pub fn classer(candidats: &[Candidat], bm25_actif: bool, threshold: f64, limit: usize) -> Vec<(usize, Details)> {
    let max_possible = if bm25_actif { 2.0 } else { 1.0 };
    let mut classes: Vec<(usize, Details)> = candidats
        .iter()
        .enumerate()
        .filter(|(_, c)| c.cosinus >= threshold)
        .map(|(i, c)| {
            // `semantic + bm25 + entity_boost`, entity_boost étant toujours 0.
            let brut = c.cosinus + c.bm25;
            let combine = (brut / max_possible).min(1.0);
            (
                i,
                Details {
                    semantic_score: c.cosinus,
                    bm25_score: c.bm25,
                    entity_boost: 0.0,
                    raw_score: brut,
                    max_possible_score: max_possible,
                    final_score: combine,
                    threshold,
                },
            )
        })
        .collect();
    // Tri stable, comme `list.sort(reverse=True)`.
    classes.sort_by(|a, b| b.1.final_score.total_cmp(&a.1.final_score));
    classes.truncate(limit);
    classes.retain(|(i, _)| !candidats[*i].vide);
    classes
}

/// Une ligne de résultat.
#[derive(Debug)]
pub struct Resultat {
    pub souvenir: Souvenir,
    pub details: Details,
}

/// Étapes 4-8 de S-5, sur l'embedding `vecteur` de la requête.
pub fn executer(conn: &Connection, r: &Requete, vecteur: &[f32]) -> rusqlite::Result<Vec<Resultat>> {
    let interne = r.limit.saturating_mul(4).max(CANDIDATS_MIN);
    let agent = r.agent_id.as_deref();

    // Candidats sémantiques : cosinus décroissant, puis id croissant.
    let mut denses: Vec<(Souvenir, f64)> =
        db::cosinus(conn, &r.user_id, agent, vecteur)?.into_iter().filter(|(s, _)| correspond(s, &r.filtres)).collect();
    denses.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.id.cmp(&b.0.id)));
    denses.truncate(interne);

    // Hits BM25 du scope : score brut > 0 décroissant, puis id croissant.
    let creux = bm25::encoder(&r.query);
    let indices: Vec<u32> = creux.iter().map(|&(i, _)| i).collect();
    let mut bm25_scores: HashMap<String, f64> = HashMap::new();
    if !indices.is_empty() {
        let (total, documents) = db::statistiques_idf(conn, &indices)?;
        let idf: HashMap<u32, f64> = documents.into_iter().map(|(i, n)| (i, idf(total, n))).collect();
        let mut hits: Vec<(String, f64)> = db::porteurs(conn, &r.user_id, agent, &indices)?
            .into_iter()
            .filter(|(s, _)| correspond(s, &r.filtres))
            .map(|(s, document)| (s.id, score_bm25(&creux, &document, &idf)))
            .filter(|(_, brut)| *brut > 0.0)
            .collect();
        hits.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        hits.truncate(interne);
        let mots = r.query.split(blanc_python).filter(|m| !m.is_empty()).count();
        let (milieu, pente) = parametres_bm25(mots);
        bm25_scores = hits.into_iter().map(|(id, brut)| (id, normaliser_bm25(brut, milieu, pente))).collect();
    }

    let candidats: Vec<Candidat> = denses
        .iter()
        .map(|(s, cos)| Candidat {
            cosinus: *cos,
            bm25: bm25_scores.get(&s.id).copied().unwrap_or(0.0),
            vide: s.memory.is_empty(),
        })
        .collect();
    let classes = classer(&candidats, !bm25_scores.is_empty(), r.threshold, r.limit);
    let mut denses: Vec<Option<Souvenir>> = denses.into_iter().map(|(s, _)| Some(s)).collect();
    Ok(classes
        .into_iter()
        .filter_map(|(i, details)| Some(Resultat { souvenir: denses[i].take()?, details }))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn requete(corps: Value) -> SearchRequest {
        let o = corps.as_object().unwrap();
        SearchRequest {
            query: o["query"].as_str().unwrap().to_owned(),
            agent_id: None,
            limit: o.get("limit").and_then(Value::as_i64).unwrap_or(5),
            filters: o.get("filters").and_then(Value::as_object).cloned(),
            threshold: o.get("threshold").and_then(Value::as_f64),
            explain: false,
        }
    }

    fn cand(cosinus: f64, bm25: f64) -> Candidat {
        Candidat { cosinus, bm25, vide: false }
    }

    #[test]
    fn ac13_tranches_de_mots_get_bm25_params() {
        for (mots, attendu) in [
            (1, (5.0, 0.7)),
            (3, (5.0, 0.7)),
            (4, (7.0, 0.6)),
            (6, (7.0, 0.6)),
            (7, (9.0, 0.5)),
            (9, (9.0, 0.5)),
            (10, (10.0, 0.5)),
            (15, (10.0, 0.5)),
            (16, (12.0, 0.5)),
            (40, (12.0, 0.5)),
        ] {
            assert_eq!(parametres_bm25(mots), attendu, "{mots} mots");
        }
        assert_eq!(normaliser_bm25(5.0, 5.0, 0.7), 0.5);
        let n = normaliser_bm25(7.0, 5.0, 0.7);
        assert!((n - 1.0 / (1.0 + (-1.4f64).exp())).abs() < 1e-15);
    }

    #[test]
    fn ac13_max_possible_selon_bm25() {
        let sans = classer(&[cand(0.8, 0.0)], false, 0.1, 5);
        assert_eq!(sans[0].1.max_possible_score, 1.0);
        assert_eq!(sans[0].1.final_score, 0.8);
        // Un hit BM25 hors candidats suffit à passer à 2.
        let avec = classer(&[cand(0.8, 0.0)], true, 0.1, 5);
        assert_eq!(avec[0].1.max_possible_score, 2.0);
        assert_eq!(avec[0].1.final_score, 0.4);
        assert_eq!(avec[0].1.entity_boost, 0.0);
        // Plafond à 1.
        assert_eq!(classer(&[cand(1.0, 1.0)], true, 0.1, 5)[0].1.final_score, 1.0);
    }

    #[test]
    fn ac11_seuil_strict_avant_fusion() {
        let c = [cand(0.29, 0.99), cand(0.3, 0.0), cand(0.31, 0.5)];
        let r = classer(&c, true, 0.3, 5);
        // 0.29 < 0.3 est écarté malgré son BM25 ; 0.3 = seuil est gardé.
        assert_eq!(r.iter().map(|(i, _)| *i).collect::<Vec<_>>(), [2, 1]);
        assert!(r.iter().all(|(_, d)| d.threshold == 0.3));
    }

    #[test]
    fn ac13_tri_stable_puis_troncature_puis_retrait_des_vides() {
        let mut c = [cand(0.5, 0.0), cand(0.9, 0.0), cand(0.5, 0.0), cand(0.7, 0.0)];
        // Ex-aequo : l'ordre dense est gardé.
        let r = classer(&c, false, 0.0, 10);
        assert_eq!(r.iter().map(|(i, _)| *i).collect::<Vec<_>>(), [1, 3, 0, 2]);
        // Le vide est retiré APRÈS la troncature : 2 lignes rendues au lieu de 3.
        c[3].vide = true;
        let r = classer(&c, false, 0.0, 3);
        assert_eq!(r.iter().map(|(i, _)| *i).collect::<Vec<_>>(), [1, 0]);
        assert!(classer(&c, false, 0.0, 0).is_empty());
    }

    #[test]
    fn validation_500_et_filtres_501() {
        let p = |v: Value| preparer(requete(v), "moi", None).map(|_| ());
        assert_eq!(p(json!({"query":" \u{1c}\t"})), Err(Refus::Interne));
        assert_eq!(p(json!({"query":"x","threshold":1.5})), Err(Refus::Interne));
        assert_eq!(p(json!({"query":"x","threshold":-0.1})), Err(Refus::Interne));
        assert_eq!(p(json!({"query":"x","limit":-1})), Err(Refus::Interne));
        assert_eq!(p(json!({"query":"x","threshold":1.0,"limit":0})), Ok(()));
        for f in [json!({"tags":{"eq":"a"}}), json!({"tags":["a"]}), json!({"tags":"*"}), json!({"OR":[{"tags":"a"}]})] {
            assert_eq!(p(json!({"query":"x","filters":f})), Err(Refus::FiltresAvances), "{f}");
        }
        for f in [json!({"tags":1.5}), json!({"tags":null})] {
            assert_eq!(p(json!({"query":"x","filters":f})), Err(Refus::Interne), "{f}");
        }
        // La portée écrase un opérateur du client sur user_id.
        assert_eq!(p(json!({"query":"x","filters":{"user_id":{"in":["a"]}}})), Ok(()));
        let r = preparer(requete(json!({"query":"  a b  ","filters":{"agent_id":"x","run_id":3}})), "moi", Some("ag".into()))
            .unwrap();
        assert_eq!(r.query, "a b");
        assert_eq!(r.threshold, 0.1);
        assert_eq!(
            r.filtres,
            [("agent_id".to_owned(), Some("ag".to_owned())), ("run_id".to_owned(), None), ("user_id".to_owned(), Some("moi".to_owned()))]
        );
    }

    #[test]
    fn filtres_egalite_stricte() {
        let s = Souvenir {
            id: "i".into(),
            memory: "texte".into(),
            hash: "h".into(),
            tags: Some(None),
            created_at: "c".into(),
            updated_at: "u".into(),
            user_id: "moi".into(),
            agent_id: Some("ag".into()),
            run_id: None,
            role: Some("user".into()),
            attributed_to: None,
        };
        let f = |paires: &[(&str, Option<&str>)]| {
            correspond(&s, &paires.iter().map(|(k, v)| (k.to_string(), v.map(str::to_owned))).collect::<Vec<_>>())
        };
        assert!(f(&[]));
        assert!(f(&[("user_id", Some("moi")), ("agent_id", Some("ag")), ("data", Some("texte")), ("text_lemmatized", Some("texte"))]));
        assert!(!f(&[("run_id", Some("r"))]));
        assert!(!f(&[("tags", Some("a"))]));
        assert!(!f(&[("role", None)]));
        assert!(f(&[("role", Some("user"))]));
        assert!(!f(&[("memory_type", Some("x"))]));
        // Souvenir extrait (add infer=true) : clé `role` absente du payload.
        let extrait = Souvenir { role: None, ..s.clone() };
        assert!(!correspond(&extrait, &[("role".to_owned(), Some("user".to_owned()))]));
    }

    #[test]
    fn idf_de_qdrant() {
        // ln((N − n + 0.5)/(n + 0.5) + 1)
        assert!((idf(10, 1) - (9.5f64 / 1.5 + 1.0).ln()).abs() < 1e-15);
        let mut table = HashMap::new();
        table.insert(1, 2.0);
        table.insert(2, 3.0);
        let score = score_bm25(&[(1, 1.5), (2, 1.0), (3, 9.0)], &vec![(2, 0.5), (1, 2.0), (4, 7.0)], &table);
        assert!((score - (1.5 * 2.0 * 2.0 + 1.0 * 3.0 * 0.5)).abs() < 1e-12);
    }
}
