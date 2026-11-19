//! Métriques de recherche d'information du banc : Recall@k, MRR, nDCG@k
//! (gain `2^g − 1`, remise `log2(rang + 1)`) et centiles de latence.
//!
//! `rendus` est la liste ordonnée des ids rendus par une recherche ; `pertinents`
//! associe à chaque id pertinent son grade (≥ 1). Un id absent de `pertinents`
//! vaut 0.

use std::collections::HashMap;
use std::time::Duration;

/// Part des pertinents (grade ≥ 1) présents dans les `k` premiers rendus.
pub fn rappel(rendus: &[String], pertinents: &HashMap<String, u32>, k: usize) -> f64 {
    if pertinents.is_empty() {
        return 0.0;
    }
    let trouves = rendus.iter().take(k).filter(|id| pertinents.contains_key(*id)).count();
    trouves as f64 / pertinents.len() as f64
}

/// Inverse du rang du premier pertinent parmi les `k` premiers rendus, 0 s'il n'y
/// en a aucun.
pub fn rang_reciproque(rendus: &[String], pertinents: &HashMap<String, u32>, k: usize) -> f64 {
    rendus.iter().take(k).position(|id| pertinents.contains_key(id)).map_or(0.0, |p| 1.0 / (p + 1) as f64)
}

fn dcg(grades: impl Iterator<Item = u32>) -> f64 {
    grades.enumerate().map(|(i, g)| (2f64.powi(g as i32) - 1.0) / ((i + 2) as f64).log2()).sum()
}

/// nDCG@k : DCG des `k` premiers rendus sur le DCG de l'ordre idéal des grades.
pub fn ndcg(rendus: &[String], pertinents: &HashMap<String, u32>, k: usize) -> f64 {
    let mut ideal: Vec<u32> = pertinents.values().copied().collect();
    ideal.sort_unstable_by(|a, b| b.cmp(a));
    let idcg = dcg(ideal.into_iter().take(k));
    if idcg == 0.0 {
        return 0.0;
    }
    dcg(rendus.iter().take(k).map(|id| pertinents.get(id).copied().unwrap_or(0))) / idcg
}

/// Centile `p` (0 < p ≤ 100) par la méthode du rang le plus proche, en
/// millisecondes ; 0 sur une liste vide.
pub fn centile_ms(echantillons: &[Duration], p: f64) -> f64 {
    if echantillons.is_empty() {
        return 0.0;
    }
    let mut tries = echantillons.to_vec();
    tries.sort_unstable();
    let rang = ((p / 100.0) * tries.len() as f64).ceil().max(1.0) as usize;
    tries[rang.min(tries.len()) - 1].as_secs_f64() * 1000.0
}

/// Moyenne, 0 sur une liste vide.
pub fn moyenne(valeurs: &[f64]) -> f64 {
    if valeurs.is_empty() { 0.0 } else { valeurs.iter().sum::<f64>() / valeurs.len() as f64 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    fn grades(v: &[(&str, u32)]) -> HashMap<String, u32> {
        v.iter().map(|(id, g)| ((*id).to_owned(), *g)).collect()
    }

    #[test]
    fn rappel_et_rang_reciproque() {
        let p = grades(&[("a", 2), ("b", 1)]);
        let r = ids(&["x", "a", "y", "b"]);
        assert_eq!(rappel(&r, &p, 2), 0.5);
        assert_eq!(rappel(&r, &p, 4), 1.0);
        assert_eq!(rappel(&r, &grades(&[]), 4), 0.0);
        assert_eq!(rang_reciproque(&r, &p, 10), 0.5);
        assert_eq!(rang_reciproque(&r, &p, 1), 0.0);
        assert_eq!(rang_reciproque(&ids(&[]), &p, 10), 0.0);
    }

    #[test]
    fn ndcg_gradue() {
        let p = grades(&[("a", 2), ("b", 1)]);
        // Ordre idéal : 1.
        assert!((ndcg(&ids(&["a", "b"]), &p, 10) - 1.0).abs() < 1e-12);
        // Inversé : (1 + 3/log2(3)) / (3 + 1/log2(3)).
        let attendu = (1.0 + 3.0 / 3f64.log2()) / (3.0 + 1.0 / 3f64.log2());
        assert!((ndcg(&ids(&["b", "a"]), &p, 10) - attendu).abs() < 1e-12);
        // Rien de pertinent rendu.
        assert_eq!(ndcg(&ids(&["x"]), &p, 10), 0.0);
        // La coupure s'applique aussi à l'idéal.
        assert!((ndcg(&ids(&["a"]), &p, 1) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn centiles_rang_le_plus_proche() {
        let ms = |v: &[u64]| v.iter().map(|m| Duration::from_millis(*m)).collect::<Vec<_>>();
        let e = ms(&[5, 1, 4, 2, 3]);
        assert_eq!(centile_ms(&e, 50.0), 3.0);
        assert_eq!(centile_ms(&e, 95.0), 5.0);
        assert_eq!(centile_ms(&e, 1.0), 1.0);
        assert_eq!(centile_ms(&[], 50.0), 0.0);
        assert_eq!(moyenne(&[1.0, 2.0]), 1.5);
        assert_eq!(moyenne(&[]), 0.0);
    }
}
