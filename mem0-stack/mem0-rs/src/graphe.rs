//! Graphe de proximité (S-7) : `graph_edges` de mem0-stack/mem0-http/http_server.py
//! (l.202-251), sur les vecteurs denses de la base.

use std::collections::HashMap;

use serde::Serialize;

/// Cosinus à partir duquel un voisin est retenu (`GRAPH_THRESHOLD`).
pub const GRAPH_THRESHOLD: f64 = 0.75;
/// Voisins gardés par souvenir, les meilleurs (`GRAPH_TOP_K`).
pub const GRAPH_TOP_K: usize = 8;

/// Une arête non orientée, `source < target`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Arete {
    pub source: String,
    pub target: String,
    pub score: f64,
}

/// Les arêtes entre `points` (id, vecteur dense) : pour chaque point, ses
/// `GRAPH_TOP_K` meilleurs voisins de cosinus ≥ `GRAPH_THRESHOLD`, rangés par
/// (score décroissant, id croissant) ; une paire n'est émise qu'une fois, avec son
/// meilleur score ; tri final (score décroissant, source, target).
pub fn aretes(mut points: Vec<(String, Vec<f32>)>) -> Vec<Arete> {
    if points.len() < 2 {
        return Vec::new();
    }
    // Les indices suivent l'ordre des ids : comparer des indices, c'est comparer des ids.
    points.sort_by(|a, b| a.0.cmp(&b.0));
    // Renormalisation L2 en float64 ; une norme nulle donne le vecteur nul
    // (`norms[norms == 0] = inf`), donc un cosinus de 0.
    let unitaires: Vec<Vec<f64>> = points
        .iter()
        .map(|(_, v)| {
            let v: Vec<f64> = v.iter().map(|&x| f64::from(x)).collect();
            let norme = v.iter().map(|x| x * x).sum::<f64>().sqrt();
            if norme > 0.0 { v.iter().map(|x| x / norme).collect() } else { vec![0.0; v.len()] }
        })
        .collect();

    // Le cosinus est symétrique : chaque paire est calculée une fois.
    let mut voisins: Vec<Vec<(f64, usize)>> = vec![Vec::new(); points.len()];
    for i in 0..unitaires.len() {
        for j in i + 1..unitaires.len() {
            let score: f64 = unitaires[i].iter().zip(&unitaires[j]).map(|(a, b)| a * b).sum();
            if score >= GRAPH_THRESHOLD {
                voisins[i].push((score, j));
                voisins[j].push((score, i));
            }
        }
    }

    let mut retenues: HashMap<(usize, usize), f64> = HashMap::new();
    for (i, liste) in voisins.iter_mut().enumerate() {
        liste.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
        for &(score, j) in liste.iter().take(GRAPH_TOP_K) {
            let meilleur = retenues.entry((i.min(j), i.max(j))).or_insert(score);
            if score > *meilleur {
                *meilleur = score;
            }
        }
    }
    let mut paires: Vec<((usize, usize), f64)> = retenues.into_iter().collect();
    paires.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    paires
        .into_iter()
        .map(|((s, t), score)| Arete { source: points[s].0.clone(), target: points[t].0.clone(), score })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vecteur à `uns` composantes 1 aux positions données, sur 32 dimensions.
    fn v(positions: &[usize]) -> Vec<f32> {
        let mut v = vec![0.0; 32];
        for &p in positions {
            v[p] = 1.0;
        }
        v
    }

    #[test]
    fn ac15_noeud_central_et_9_voisins() {
        // Centre : composantes 0..20. Voisin k : 0..20 plus la composante 20+k.
        // cos(centre, voisin) = 20/√(20·21) ≈ 0.976 ; cos(voisin, voisin) = 20/21 ≈ 0.952.
        let base: Vec<usize> = (0..20).collect();
        let mut points = vec![("centre".to_owned(), v(&base))];
        for k in 0..9 {
            let mut p = base.clone();
            p.push(20 + k);
            points.push((format!("voisin{k}"), v(&p)));
        }
        let a = aretes(points);
        // Le centre n'en garde que 8 de son côté, mais chaque voisin le classe
        // premier : les voisinages réunis lui donnent ses 9 arêtes.
        let centre: Vec<&Arete> = a.iter().filter(|e| e.source == "centre" || e.target == "centre").collect();
        assert_eq!(centre.len(), 9);
        let attendu = 20.0 / (20.0f64 * 21.0).sqrt();
        assert!(centre.iter().all(|e| (e.score - attendu).abs() < 1e-12));
        assert!(a.iter().all(|e| e.source < e.target));
        // Tri : score décroissant, puis source, puis target.
        for w in a.windows(2) {
            let (x, y) = (&w[0], &w[1]);
            assert!(
                x.score > y.score || (x.score == y.score && (&x.source, &x.target) < (&y.source, &y.target)),
                "{x:?} avant {y:?}"
            );
        }
        // Entre voisins : chacun garde le centre et 7 des 8 autres voisins (id croissant).
        assert!(a.iter().any(|e| e.source == "voisin0" && e.target == "voisin7"));
    }

    #[test]
    fn ac15_seuil_norme_nulle_et_moins_de_deux_points() {
        assert!(aretes(vec![("a".into(), v(&[0]))]).is_empty());
        // Norme nulle : cosinus 0, jamais d'arête ; seuil inclusif à 0.75.
        let trois_quarts = vec![0.75f32, (1.0f32 - 0.75 * 0.75).sqrt()];
        let mut un = vec![1.0f32, 0.0];
        let a = aretes(vec![("z".into(), vec![0.0, 0.0]), ("b".into(), trois_quarts), ("a".into(), un.clone())]);
        assert_eq!(a.len(), 1);
        assert_eq!((a[0].source.as_str(), a[0].target.as_str()), ("a", "b"));
        assert!((a[0].score - 0.75).abs() < 1e-7);
        // Sous le seuil : rien.
        un[1] = 0.9;
        assert!(aretes(vec![("a".into(), un), ("b".into(), vec![0.0, 1.0])]).is_empty());
    }
}
