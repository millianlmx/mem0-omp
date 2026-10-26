//! Recherche hybride (S-5) : reproduction de `Memory._search_vector_store`
//! (mem0/memory/main.py:3330-3431) et de `mem0/utils/scoring.py` de mem0ai
//! 2.2.1 (D-1). entity_boost y est inactif (spaCy absent) : il vaut toujours 0.
//!
//! Deux fusions des classements sémantique et BM25 : l'additive de mem0 (défaut,
//! parité de `scripts/mem0-http-contrat/rang.json`) et la Reciprocal Rank Fusion
//! ([`classer_rrf`]), choisie par `MEM0_SEARCH_FUSION` ou par le champ `fusion`
//! d'une requête. Le banc de mesure ([`crate::banc`]) éprouve aussi les deux
//! classements seuls ([`Strategie::Semantique`], [`Strategie::Bm25`]).
//!
//! La fusion `graphe` (memoire-liee) ajoute un troisième classement à la RRF :
//! les souvenirs atteints depuis les meilleurs candidats par le graphe de la
//! mémoire ([`crate::liens`]) — entités partagées, voisins sémantiques, liens
//! typés —, que ni l'embedding ni le BM25 ne trouvent ([`bras_graphe`]).

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use crate::bm25::{self, VecteurCreux};
use crate::config::{blanc_python, strip_python};
use crate::db::{self, Souvenir};
use crate::entites;
use crate::liens::{self, SEMANTIQUE};
use crate::validation::SearchRequest;

/// `threshold=None` de mem0 (main.py:3331-3332).
const SEUIL_PAR_DEFAUT: f64 = 0.1;
/// Plancher du sur-échantillonnage `max(limit*4, 60)`.
const CANDIDATS_MIN: usize = 60;

/// `k` de la RRF par défaut (Cormack, Clarke et Büttcher, SIGIR 2009).
pub const RRF_K_PAR_DEFAUT: u32 = 60;

/// Fusion demandée au serveur (`MEM0_SEARCH_FUSION`) ou par une requête (`fusion`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fusion {
    /// mem0 2.2.1 : `min((cosinus + BM25 sigmoïde)/max_possible, 1)` sur les
    /// candidats sémantiques. Défaut.
    Additive,
    /// Reciprocal Rank Fusion : `Σ 1/(k + rang)` sur l'union des candidats
    /// sémantiques et BM25.
    Rrf,
    /// RRF sur trois classements : sémantique, BM25 et graphe ([`bras_graphe`]).
    Graphe,
}

impl Fusion {
    pub fn lire(nom: &str) -> Option<Fusion> {
        match nom {
            "additive" => Some(Fusion::Additive),
            "rrf" => Some(Fusion::Rrf),
            "graphe" => Some(Fusion::Graphe),
            _ => None,
        }
    }
}

/// Réglage de la recherche lu dans l'environnement : la fusion par défaut et le
/// `k` de la RRF (qu'une requête `"fusion":"rrf"` reprend aussi).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reglage {
    pub fusion: Fusion,
    pub rrf_k: u32,
}

impl Default for Reglage {
    fn default() -> Self {
        Reglage { fusion: Fusion::Additive, rrf_k: RRF_K_PAR_DEFAUT }
    }
}

impl Reglage {
    /// La stratégie d'une requête : son champ `fusion` s'il est donné, sinon le défaut.
    pub fn strategie(self, demandee: Option<Fusion>) -> Strategie {
        match demandee.unwrap_or(self.fusion) {
            Fusion::Additive => Strategie::Additive,
            Fusion::Rrf => Strategie::Rrf { k: self.rrf_k },
            Fusion::Graphe => Strategie::Graphe { k: self.rrf_k },
        }
    }
}

/// Le classement appliqué aux candidats. HTTP n'expose que les deux fusions ; les
/// deux classements seuls servent de témoins au banc de mesure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategie {
    /// Cosinus seul, ordre dense.
    Semantique,
    /// BM25 seul : les hits, score brut décroissant.
    Bm25,
    /// Fusion additive de mem0.
    Additive,
    /// Reciprocal Rank Fusion de constante `k`.
    Rrf { k: u32 },
    /// RRF de constante `k` sur les classements sémantique, BM25 et graphe.
    Graphe { k: u32 },
}

impl std::fmt::Display for Strategie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Strategie::Semantique => f.write_str("semantique"),
            Strategie::Bm25 => f.write_str("bm25"),
            Strategie::Additive => f.write_str("additive"),
            Strategie::Rrf { k } => write!(f, "rrf-k{k}"),
            Strategie::Graphe { k } => write!(f, "graphe-k{k}"),
        }
    }
}

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
    /// Le classement : champ `fusion` de la requête, sinon le défaut du serveur.
    pub strategie: Strategie,
}

/// Validation et fusion des filtres (S-5, étapes 1-2). `agent_id` est déjà
/// passé par le contrôle des identifiants de portée (S-2) ; `reglage` donne la
/// fusion quand la requête n'en demande pas.
pub fn preparer(
    req: SearchRequest,
    user_id: &str,
    agent_id: Option<String>,
    reglage: Reglage,
) -> Result<Requete, Refus> {
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
        strategie: reglage.strategie(req.fusion),
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

/// Contribution RRF d'un rang (1 = premier) : `1/(k + rang)`.
pub fn rrf(k: u32, rang: usize) -> f64 {
    1.0 / (f64::from(k) + rang as f64)
}

/// Un candidat de la RRF. Les candidats sont donnés dans l'ordre dense complet
/// (cosinus décroissant, puis id croissant), qui sert aussi à départager les
/// ex-aequo.
#[derive(Debug, Clone, Copy)]
pub struct CandidatRrf {
    pub cosinus: f64,
    /// Parmi les `max(limit*4, 60)` premiers du classement sémantique.
    pub dense: bool,
    /// Position dans le classement BM25 (0 = premier hit) et score normalisé ;
    /// `None` hors des hits BM25 retenus.
    pub bm25: Option<(usize, f64)>,
    /// `memory` vide : retiré après la troncature.
    pub vide: bool,
}

/// Reciprocal Rank Fusion : (indice du candidat, détails), au plus `limit`.
///
/// 1. Le seuil s'applique au cosinus brut AVANT la fusion, comme pour
///    l'additive : un candidat sous `threshold` sort des DEUX classements, et les
///    rangs se comptent parmi les candidats gardés.
/// 2. Score brut `Σ 1/(k + rang)`, sur le rang sémantique (candidats `dense`,
///    dans l'ordre donné) et sur le rang BM25 (position BM25 croissante) ; un
///    classement où le candidat n'est pas ne contribue pas. Rangs ordinaux à
///    partir de 1 : deux cosinus égaux ont deux rangs distincts, départagés par
///    l'id comme l'ordre dense.
/// 3. Tri stable décroissant : à score égal, l'ordre dense (cosinus le plus
///    haut, puis id croissant). Troncature à `limit`, puis retrait des vides.
///
/// `score_details` garde ses 7 clés : `raw_score` est la somme RRF,
/// `max_possible_score` celle d'un candidat premier partout (`1/(k+1)`, doublé
/// dès qu'un hit BM25 existe, même hors seuil, comme l'additive), et
/// `final_score` = `raw_score/max_possible_score`, dans [0, 1].
pub fn classer_rrf(
    candidats: &[CandidatRrf],
    bm25_actif: bool,
    k: u32,
    threshold: f64,
    limit: usize,
) -> Vec<(usize, Details)> {
    let gardes: Vec<usize> = (0..candidats.len()).filter(|&i| candidats[i].cosinus >= threshold).collect();
    let mut brut = vec![0.0f64; candidats.len()];
    for (rang, &i) in gardes.iter().filter(|&&i| candidats[i].dense).enumerate() {
        brut[i] += rrf(k, rang + 1);
    }
    let mut lexicaux: Vec<(usize, usize)> =
        gardes.iter().filter_map(|&i| Some((candidats[i].bm25?.0, i))).collect();
    lexicaux.sort_unstable();
    for (rang, &(_, i)) in lexicaux.iter().enumerate() {
        brut[i] += rrf(k, rang + 1);
    }
    let max_possible = rrf(k, 1) * if bm25_actif { 2.0 } else { 1.0 };
    let mut classes: Vec<(usize, Details)> = gardes
        .into_iter()
        .map(|i| {
            let c = &candidats[i];
            let details = Details {
                semantic_score: c.cosinus,
                bm25_score: c.bm25.map_or(0.0, |(_, s)| s),
                entity_boost: 0.0,
                raw_score: brut[i],
                max_possible_score: max_possible,
                final_score: (brut[i] / max_possible).min(1.0),
                threshold,
            };
            (i, details)
        })
        .collect();
    classes.sort_by(|a, b| b.1.final_score.total_cmp(&a.1.final_score));
    classes.truncate(limit);
    classes.retain(|(i, _)| !candidats[*i].vide);
    classes
}

/// Un candidat de la fusion `graphe`, avec son rang (à partir de 1) dans chacun
/// des trois classements où il figure. Les candidats sont donnés dans l'ordre
/// dense complet, qui départage les ex-aequo.
#[derive(Debug, Clone, Copy)]
pub struct CandidatGraphe {
    pub cosinus: f64,
    pub rang_dense: Option<usize>,
    /// Rang BM25 et score normalisé.
    pub bm25: Option<(usize, f64)>,
    /// Rang dans le classement du graphe et score de graphe.
    pub graphe: Option<(usize, f64)>,
    pub vide: bool,
}

/// RRF à trois classements : (indice du candidat, détails), au plus `limit`.
///
/// Les rangs arrivent déjà calculés : le seuil a écarté du sémantique et du BM25
/// les candidats sous `threshold` (comme la RRF), mais pas du graphe — un
/// souvenir relié à un bon candidat entre même si son cosinus avec la requête est
/// faible, c'est l'objet du bras. Un candidat sans aucun rang ne sort pas.
///
/// `score_details` garde ses 7 clés : `entity_boost` porte le score de graphe,
/// `raw_score` la somme RRF, `max_possible_score` celle d'un candidat premier
/// partout (`1/(k+1)` par classement actif : le sémantique toujours, le BM25 dès
/// qu'il a un hit, le graphe dès qu'il atteint un souvenir), `final_score` le
/// rapport des deux, dans [0, 1].
pub fn classer_graphe(
    candidats: &[CandidatGraphe],
    bm25_actif: bool,
    graphe_actif: bool,
    k: u32,
    threshold: f64,
    limit: usize,
) -> Vec<(usize, Details)> {
    let actifs = 1.0 + f64::from(u8::from(bm25_actif)) + f64::from(u8::from(graphe_actif));
    let max_possible = rrf(k, 1) * actifs;
    let mut classes: Vec<(usize, Details)> = candidats
        .iter()
        .enumerate()
        .filter(|(_, c)| c.rang_dense.is_some() || c.bm25.is_some() || c.graphe.is_some())
        .map(|(i, c)| {
            let brut = c.rang_dense.map_or(0.0, |r| rrf(k, r))
                + c.bm25.map_or(0.0, |(r, _)| rrf(k, r))
                + c.graphe.map_or(0.0, |(r, _)| rrf(k, r));
            let details = Details {
                semantic_score: c.cosinus,
                bm25_score: c.bm25.map_or(0.0, |(_, s)| s),
                entity_boost: c.graphe.map_or(0.0, |(_, s)| s),
                raw_score: brut,
                max_possible_score: max_possible,
                final_score: (brut / max_possible).min(1.0),
                threshold,
            };
            (i, details)
        })
        .collect();
    classes.sort_by(|a, b| b.1.final_score.total_cmp(&a.1.final_score));
    classes.truncate(limit);
    classes.retain(|(i, _)| !candidats[*i].vide);
    classes
}

/// Meilleurs candidats d'où part le bras graphe, par classement (sémantique et BM25).
pub const SEMENCES: usize = 10;
/// Longueur du classement du graphe : chacun de ses souvenirs reçoit une voix de
/// la RRF, un classement plus long ajouterait des voix au bruit.
pub const GRAPHE_MAX: usize = 10;
/// Score de graphe minimal pour entrer dans le classement du graphe. Sans
/// cross-encoder derrière la fusion (Hindsight en a un), une voix donnée à un
/// voisin faible déclasse les bons candidats que seul le sémantique trouve :
/// mesuré au banc, un plancher de 0.7 ne garde que les connexions fortes (lien
/// typé ou voisin très proche de la meilleure semence, deux entités de la
/// requête) et laisse intacts les classements lexical, mixte et paraphrase.
pub const GRAPHE_PLANCHER: f64 = 0.7;

/// Une entité portée par plus de `max(ENTITE_FREQUENTE_MIN, n/4)` souvenirs de la
/// portée ne relie rien (le nom du projet, `mem0`) : elle est ignorée.
const ENTITE_FREQUENTE_MIN: usize = 3;

/// Score de graphe des souvenirs atteints depuis `semences` (ids dans l'ordre
/// de leur meilleur rang, avec ce rang, dans la portée de `r`) et depuis les
/// entités de la requête. L'activation d'une semence décroît avec son rang
/// (`1/rang`) et se propage d'un saut ; pour un souvenir `m` :
///
/// `tanh(0.5·q) + max_semence [ 1/rang · (sém + typé + 0.5·tanh(0.5·s)) ]`
///
/// - `q` : entités de la requête que `m` porte ;
/// - `sém` : poids du lien `semantique` entre `m` et la semence ;
/// - `typé` : poids du lien typé (cause, remplace, contredit, precise, voir,
///   preuve) entre `m` et la semence, borné à 1 ;
/// - `s` : entités que `m` partage avec la semence.
///
/// Les signaux d'une même semence s'ajoutent (des preuves convergentes classent
/// plus haut) et `tanh` sature les comptes d'entités, comme le score de graphe de
/// Hindsight. `dans_portee` dit si un id est candidat (portée et filtres).
pub fn bras_graphe(
    conn: &Connection,
    r: &Requete,
    semences: &[(&str, usize)],
    dans_portee: &dyn Fn(&str) -> bool,
    taille_portee: usize,
) -> rusqlite::Result<HashMap<String, f64>> {
    let ids: Vec<&str> = semences.iter().map(|&(id, _)| id).collect();
    let activation: HashMap<&str, f64> = semences.iter().map(|&(id, rang)| (id, 1.0 / rang.max(1) as f64)).collect();
    // (m, semence) → (sém, typé, entités partagées)
    let mut signaux: HashMap<(String, &str), (f64, f64, usize)> = HashMap::new();
    for l in liens::liens_touchant(conn, &ids)? {
        for (semence, m) in [(&l.source, &l.target), (&l.target, &l.source)] {
            let Some((&semence, _)) = activation.get_key_value(semence.as_str()) else { continue };
            if m == semence || !dans_portee(m) {
                continue;
            }
            let poids = l.weight.clamp(0.0, 1.0);
            let v = signaux.entry((m.clone(), semence)).or_default();
            if l.type_ == SEMANTIQUE {
                v.0 = v.0.max(poids);
            } else {
                v.1 = v.1.max(poids);
            }
        }
    }
    let frequente = ENTITE_FREQUENTE_MIN.max(taille_portee / 4);
    let requete: HashSet<String> = entites::extraire(&r.query).into_iter().map(|e| e.cle).collect();
    let des_semences = liens::entites_de(conn, &ids)?;
    let toutes: HashSet<String> = requete.iter().cloned().chain(des_semences.values().flatten().cloned()).collect();
    let porteurs = liens::porteurs_entites(conn, &r.user_id, r.agent_id.as_deref(), &toutes)?;
    let utile = |cle: &String| porteurs.get(cle).is_some_and(|p| p.len() <= frequente);
    let mut q: HashMap<String, usize> = HashMap::new();
    for cle in requete.iter().filter(|c| utile(c)) {
        for m in &porteurs[cle] {
            if dans_portee(m) {
                *q.entry(m.clone()).or_default() += 1;
            }
        }
    }
    for (semence, cles) in &des_semences {
        let Some((&semence, _)) = activation.get_key_value(semence.as_str()) else { continue };
        for cle in cles.iter().filter(|c| utile(c)) {
            for m in &porteurs[cle] {
                if m != semence && dans_portee(m) {
                    signaux.entry((m.clone(), semence)).or_default().2 += 1;
                }
            }
        }
    }
    let mut scores: HashMap<String, f64> =
        q.iter().map(|(m, &n)| (m.clone(), (0.5 * n as f64).tanh())).collect();
    let mut propage: HashMap<String, f64> = HashMap::new();
    for ((m, semence), (sem, type_, partages)) in signaux {
        let v = activation[semence] * (sem + type_ + 0.5 * (0.5 * partages as f64).tanh());
        let meilleur = propage.entry(m).or_insert(0.0);
        *meilleur = meilleur.max(v);
    }
    for (m, v) in propage {
        *scores.entry(m).or_insert(0.0) += v;
    }
    scores.retain(|_, s| *s > 0.0);
    Ok(scores)
}

/// Une ligne de résultat.
#[derive(Debug)]
pub struct Resultat {
    pub souvenir: Souvenir,
    pub details: Details,
}

/// Hits BM25 du scope (S-5, étape 4) : score brut > 0 décroissant, puis id
/// croissant, les `interne` premiers, avec leur score normalisé par la sigmoïde.
fn hits_bm25(conn: &Connection, r: &Requete, interne: usize) -> rusqlite::Result<Vec<(String, f64)>> {
    let creux = bm25::encoder(&r.query);
    let indices: Vec<u32> = creux.iter().map(|&(i, _)| i).collect();
    if indices.is_empty() {
        return Ok(Vec::new());
    }
    let (total, documents) = db::statistiques_idf(conn, &indices)?;
    let idf: HashMap<u32, f64> = documents.into_iter().map(|(i, n)| (i, idf(total, n))).collect();
    let mut hits: Vec<(String, f64)> = db::porteurs(conn, &r.user_id, r.agent_id.as_deref(), &indices)?
        .into_iter()
        .filter(|(s, _)| correspond(s, &r.filtres))
        .map(|(s, document)| (s.id, score_bm25(&creux, &document, &idf)))
        .filter(|(_, brut)| *brut > 0.0)
        .collect();
    hits.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    hits.truncate(interne);
    let mots = r.query.split(blanc_python).filter(|m| !m.is_empty()).count();
    let (milieu, pente) = parametres_bm25(mots);
    Ok(hits.into_iter().map(|(id, brut)| (id, normaliser_bm25(brut, milieu, pente))).collect())
}

/// Étapes 4-8 de S-5, sur l'embedding `vecteur` de la requête, avec la
/// stratégie de la requête.
///
/// Candidats : l'additive (parité mem0) et le sémantique seul ne classent que
/// les `max(limit*4, 60)` premiers du classement sémantique. La RRF classe
/// l'UNION de ces candidats et des hits BM25 retenus : un souvenir que seul le
/// BM25 trouve (identifiant, nom de fichier) entre dans le classement avec son
/// vrai cosinus, que le seuil juge comme les autres. Le BM25 seul classe ses hits.
pub fn executer(conn: &Connection, r: &Requete, vecteur: &[f32]) -> rusqlite::Result<Vec<Resultat>> {
    let interne = r.limit.saturating_mul(4).max(CANDIDATS_MIN);

    // Classement sémantique complet du scope : cosinus décroissant, puis id croissant.
    let mut denses: Vec<(Souvenir, f64)> = db::cosinus(conn, &r.user_id, r.agent_id.as_deref(), vecteur)?
        .into_iter()
        .filter(|(s, _)| correspond(s, &r.filtres))
        .collect();
    denses.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.id.cmp(&b.0.id)));
    let hits = hits_bm25(conn, r, interne)?;
    let tete = interne.min(denses.len());
    // Position de chaque id dans le classement sémantique complet (RRF et BM25 seul).
    let positions = || -> HashMap<&str, usize> { denses.iter().enumerate().map(|(p, (s, _))| (s.id.as_str(), p)).collect() };

    // (position dans `denses`, détails), dans l'ordre rendu.
    let classes: Vec<(usize, Details)> = match r.strategie {
        Strategie::Additive | Strategie::Semantique => {
            let bm25_actif = r.strategie == Strategie::Additive && !hits.is_empty();
            let scores: HashMap<&str, f64> =
                if bm25_actif { hits.iter().map(|(id, s)| (id.as_str(), *s)).collect() } else { HashMap::new() };
            let candidats: Vec<Candidat> = denses[..tete]
                .iter()
                .map(|(s, cos)| Candidat {
                    cosinus: *cos,
                    bm25: scores.get(s.id.as_str()).copied().unwrap_or(0.0),
                    vide: s.memory.is_empty(),
                })
                .collect();
            classer(&candidats, bm25_actif, r.threshold, r.limit)
        }
        Strategie::Rrf { k } => {
            let position = positions();
            let rang_bm25: HashMap<usize, (usize, f64)> = hits
                .iter()
                .enumerate()
                .filter_map(|(rang, (id, s))| Some((*position.get(id.as_str())?, (rang, *s))))
                .collect();
            let mut retenues: Vec<usize> = (0..tete).chain(rang_bm25.keys().copied().filter(|&p| p >= tete)).collect();
            retenues.sort_unstable();
            let candidats: Vec<CandidatRrf> = retenues
                .iter()
                .map(|&p| CandidatRrf {
                    cosinus: denses[p].1,
                    dense: p < tete,
                    bm25: rang_bm25.get(&p).copied(),
                    vide: denses[p].0.memory.is_empty(),
                })
                .collect();
            classer_rrf(&candidats, !hits.is_empty(), k, r.threshold, r.limit)
                .into_iter()
                .map(|(i, d)| (retenues[i], d))
                .collect()
        }
        Strategie::Graphe { k } => {
            let position = positions();
            let gardes = |p: usize| denses[p].1 >= r.threshold;
            // Semences : les meilleurs du sémantique et du BM25, au-dessus du seuil,
            // chacune avec son meilleur rang dans les deux classements.
            let mut semences: Vec<(&str, usize)> = Vec::new();
            let denses_gardes = (0..tete).filter(|&p| gardes(p)).take(SEMENCES).map(|p| denses[p].0.id.as_str());
            let hits_gardes = hits
                .iter()
                .filter(|(id, _)| position.get(id.as_str()).is_some_and(|&p| gardes(p)))
                .take(SEMENCES)
                .map(|(id, _)| id.as_str());
            for (rang, id) in denses_gardes.enumerate().chain(hits_gardes.enumerate()) {
                match semences.iter_mut().find(|(s, _)| *s == id) {
                    Some(s) => s.1 = s.1.min(rang + 1),
                    None => semences.push((id, rang + 1)),
                }
            }
            let dans_portee = |id: &str| position.contains_key(id);
            let scores = bras_graphe(conn, r, &semences, &dans_portee, denses.len())?;
            let mut graphe: Vec<(usize, f64)> =
                scores.iter().filter_map(|(id, s)| Some((*position.get(id.as_str())?, *s))).collect();
            graphe.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            graphe.retain(|&(_, score)| score >= GRAPHE_PLANCHER);
            graphe.truncate(GRAPHE_MAX);
            let rang_graphe: HashMap<usize, (usize, f64)> =
                graphe.iter().enumerate().map(|(rang, &(p, s))| (p, (rang + 1, s))).collect();
            let rang_dense: HashMap<usize, usize> =
                (0..tete).filter(|&p| gardes(p)).enumerate().map(|(rang, p)| (p, rang + 1)).collect();
            let rang_bm25: HashMap<usize, (usize, f64)> = hits
                .iter()
                .filter_map(|(id, s)| Some((*position.get(id.as_str())?, *s)))
                .filter(|&(p, _)| gardes(p))
                .enumerate()
                .map(|(rang, (p, s))| (p, (rang + 1, s)))
                .collect();
            let mut retenues: Vec<usize> =
                rang_dense.keys().chain(rang_bm25.keys()).chain(rang_graphe.keys()).copied().collect();
            retenues.sort_unstable();
            retenues.dedup();
            let candidats: Vec<CandidatGraphe> = retenues
                .iter()
                .map(|&p| CandidatGraphe {
                    cosinus: denses[p].1,
                    rang_dense: rang_dense.get(&p).copied(),
                    bm25: rang_bm25.get(&p).copied(),
                    graphe: rang_graphe.get(&p).copied(),
                    vide: denses[p].0.memory.is_empty(),
                })
                .collect();
            classer_graphe(&candidats, !hits.is_empty(), !graphe.is_empty(), k, r.threshold, r.limit)
                .into_iter()
                .map(|(i, d)| (retenues[i], d))
                .collect()
        }
        Strategie::Bm25 => {
            let position = positions();
            let mut classes: Vec<(usize, Details)> = hits
                .iter()
                .filter_map(|(id, s)| {
                    let p = *position.get(id.as_str())?;
                    let cosinus = denses[p].1;
                    (cosinus >= r.threshold).then_some((
                        p,
                        Details {
                            semantic_score: cosinus,
                            bm25_score: *s,
                            entity_boost: 0.0,
                            raw_score: *s,
                            max_possible_score: 1.0,
                            final_score: *s,
                            threshold: r.threshold,
                        },
                    ))
                })
                .collect();
            classes.truncate(r.limit);
            classes.retain(|(p, _)| !denses[*p].0.memory.is_empty());
            classes
        }
    };
    let mut denses: Vec<Option<Souvenir>> = denses.into_iter().map(|(s, _)| Some(s)).collect();
    Ok(classes
        .into_iter()
        .filter_map(|(p, details)| Some(Resultat { souvenir: denses[p].take()?, details }))
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
            fusion: o.get("fusion").and_then(Value::as_str).and_then(Fusion::lire),
            liens: false,
        }
    }

    fn cand(cosinus: f64, bm25: f64) -> Candidat {
        Candidat { cosinus, bm25, vide: false }
    }

    /// Candidat RRF : `bm25` = position BM25 (0 = premier hit), score normalisé 0.5.
    fn rrf_cand(cosinus: f64, dense: bool, bm25: Option<usize>) -> CandidatRrf {
        CandidatRrf { cosinus, dense, bm25: bm25.map(|p| (p, 0.5)), vide: false }
    }

    fn ordre(r: &[(usize, Details)]) -> Vec<usize> {
        r.iter().map(|(i, _)| *i).collect()
    }

    #[test]
    fn rrf_somme_des_inverses_de_rang() {
        // Ordre dense : 0, 1, 2 ; ordre BM25 : 2, 0 ; 3 est un hit BM25 hors candidats sémantiques.
        let c = [
            rrf_cand(0.9, true, Some(1)),
            rrf_cand(0.8, true, None),
            rrf_cand(0.7, true, Some(0)),
            rrf_cand(0.2, false, Some(2)),
        ];
        let r = classer_rrf(&c, true, 60, 0.0, 10);
        let brut = |i: usize| r.iter().find(|(j, _)| *j == i).unwrap().1.raw_score;
        assert_eq!(brut(0), 1.0 / 61.0 + 1.0 / 62.0);
        assert_eq!(brut(1), 1.0 / 62.0);
        assert_eq!(brut(2), 1.0 / 63.0 + 1.0 / 61.0);
        assert_eq!(brut(3), 1.0 / 63.0);
        // 0 (rangs 1 et 2) devant 2 (rangs 3 et 1) : 1/61 + 1/62 > 1/63 + 1/61.
        assert_eq!(ordre(&r), [0, 2, 1, 3]);
        for (i, d) in &r {
            assert_eq!(d.max_possible_score, 2.0 / 61.0);
            assert_eq!(d.final_score, d.raw_score / d.max_possible_score, "{i}");
            assert_eq!(d.entity_boost, 0.0);
            assert_eq!(d.threshold, 0.0);
        }
        assert_eq!(r[0].1.semantic_score, 0.9);
        assert_eq!(r[0].1.bm25_score, 0.5);
        assert_eq!(r[2].1.bm25_score, 0.0);
        // Premier des deux classements : final_score = 1.
        let seul = classer_rrf(&[rrf_cand(0.5, true, Some(0))], true, 60, 0.0, 10);
        assert_eq!(seul[0].1.final_score, 1.0);
        // Sans hit BM25, le maximum est 1/(k+1) ; k change l'échelle.
        let sans = classer_rrf(&[rrf_cand(0.5, true, None), rrf_cand(0.4, true, None)], false, 1, 0.0, 10);
        assert_eq!(sans[0].1.max_possible_score, 0.5);
        assert_eq!((sans[0].1.final_score, sans[1].1.final_score), (1.0, (1.0 / 3.0) / 0.5));
        assert_eq!(rrf(60, 1), 1.0 / 61.0);
    }

    #[test]
    fn rrf_ex_aequo_departages_par_l_ordre_dense() {
        // 0 : premier sémantique seul ; 1 : premier BM25 seul (hors candidats
        // sémantiques). Même score 1/61 : l'ordre dense (cosinus plus haut) gagne.
        let c = [rrf_cand(0.6, true, None), rrf_cand(0.1, false, Some(0))];
        let r = classer_rrf(&c, true, 60, 0.0, 10);
        assert_eq!(r[0].1.raw_score, r[1].1.raw_score);
        assert_eq!(ordre(&r), [0, 1]);
        // Rangs ordinaux : deux cosinus égaux ont deux rangs distincts (ordre donné).
        let c = [rrf_cand(0.5, true, None), rrf_cand(0.5, true, None)];
        let r = classer_rrf(&c, false, 60, 0.0, 10);
        assert_eq!((r[0].1.raw_score, r[1].1.raw_score), (1.0 / 61.0, 1.0 / 62.0));
        assert_eq!(ordre(&r), [0, 1]);
    }

    #[test]
    fn rrf_seuil_avant_fusion_et_rangs_recomptes() {
        // 0 est sous le seuil : il sort des DEUX classements, et 1 devient premier
        // sémantique, 2 premier BM25.
        let c = [rrf_cand(0.29, true, Some(0)), rrf_cand(0.6, true, None), rrf_cand(0.3, true, Some(1))];
        let r = classer_rrf(&c, true, 60, 0.3, 10);
        assert_eq!(ordre(&r), [2, 1]);
        assert_eq!(r[0].1.raw_score, 1.0 / 62.0 + 1.0 / 61.0);
        assert_eq!(r[1].1.raw_score, 1.0 / 61.0);
        // Le hit écarté compte quand même pour max_possible (BM25 actif).
        assert!(r.iter().all(|(_, d)| d.max_possible_score == 2.0 / 61.0 && d.threshold == 0.3));
    }

    #[test]
    fn rrf_troncature_puis_retrait_des_vides() {
        let mut c = [rrf_cand(0.9, true, None), rrf_cand(0.8, true, None), rrf_cand(0.7, true, None)];
        c[1].vide = true;
        assert_eq!(ordre(&classer_rrf(&c, false, 60, 0.0, 2)), [0]);
        assert!(classer_rrf(&c, false, 60, 0.0, 0).is_empty());
    }

    fn graphe_cand(cosinus: f64, dense: Option<usize>, bm25: Option<usize>, graphe: Option<(usize, f64)>) -> CandidatGraphe {
        CandidatGraphe { cosinus, rang_dense: dense, bm25: bm25.map(|r| (r, 0.5)), graphe, vide: false }
    }

    #[test]
    fn graphe_trois_classements_et_entity_boost() {
        // 0 : premier dense et premier BM25 ; 1 : deuxième dense ; 2 : atteint par
        // le graphe seul (cosinus sous le seuil : gardé quand même) ; 3 : aucun rang.
        let c = [
            graphe_cand(0.9, Some(1), Some(1), None),
            graphe_cand(0.8, Some(2), None, Some((2, 0.8))),
            graphe_cand(0.1, None, None, Some((1, 1.2))),
            graphe_cand(0.05, None, None, None),
        ];
        let r = classer_graphe(&c, true, true, 60, 0.3, 10);
        assert_eq!(ordre(&r), [0, 1, 2]);
        let max = 3.0 / 61.0;
        assert!(r.iter().all(|(_, d)| d.max_possible_score == max && d.threshold == 0.3));
        assert_eq!(r[0].1.raw_score, 2.0 / 61.0);
        assert_eq!(r[0].1.entity_boost, 0.0);
        assert_eq!(r[1].1.raw_score, 1.0 / 62.0 + 1.0 / 62.0);
        assert_eq!(r[1].1.entity_boost, 0.8);
        assert_eq!((r[2].1.raw_score, r[2].1.entity_boost, r[2].1.semantic_score), (1.0 / 61.0, 1.2, 0.1));
        // Sans BM25 ni graphe actifs, le maximum est celui du seul sémantique.
        let seul = classer_graphe(&[graphe_cand(0.5, Some(1), None, None)], false, false, 60, 0.0, 10);
        assert_eq!((seul[0].1.max_possible_score, seul[0].1.final_score), (1.0 / 61.0, 1.0));
        // Troncature puis retrait des vides.
        let mut c = [graphe_cand(0.9, Some(1), None, None), graphe_cand(0.8, Some(2), None, None)];
        c[0].vide = true;
        assert!(classer_graphe(&c, false, false, 60, 0.0, 1).is_empty());
    }

    #[test]
    fn strategie_de_la_requete_sinon_du_serveur() {
        let defaut = Reglage::default();
        assert_eq!(defaut, Reglage { fusion: Fusion::Additive, rrf_k: 60 });
        assert_eq!(defaut.strategie(None), Strategie::Additive);
        assert_eq!(defaut.strategie(Some(Fusion::Rrf)), Strategie::Rrf { k: 60 });
        let rrf = Reglage { fusion: Fusion::Rrf, rrf_k: 7 };
        assert_eq!(rrf.strategie(None), Strategie::Rrf { k: 7 });
        assert_eq!(rrf.strategie(Some(Fusion::Additive)), Strategie::Additive);
        let p = |v: Value, r: Reglage| preparer(requete(v), "moi", None, r).unwrap().strategie;
        assert_eq!(p(json!({"query":"x"}), defaut), Strategie::Additive);
        assert_eq!(p(json!({"query":"x","fusion":"rrf"}), defaut), Strategie::Rrf { k: 60 });
        assert_eq!(p(json!({"query":"x"}), rrf), Strategie::Rrf { k: 7 });
        assert_eq!(
            [Strategie::Semantique, Strategie::Bm25, Strategie::Additive, Strategie::Rrf { k: 10 }, Strategie::Graphe { k: 7 }]
                .map(|s| s.to_string()),
            ["semantique", "bm25", "additive", "rrf-k10", "graphe-k7"]
        );
        assert_eq!(defaut.strategie(Some(Fusion::Graphe)), Strategie::Graphe { k: 60 });
        assert_eq!(Fusion::lire("graphe"), Some(Fusion::Graphe));
        assert_eq!(Fusion::lire("rrf"), Some(Fusion::Rrf));
        assert_eq!(Fusion::lire("Rrf"), None);
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
        let p = |v: Value| preparer(requete(v), "moi", None, Reglage::default()).map(|_| ());
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
        let r = preparer(
            requete(json!({"query":"  a b  ","filters":{"agent_id":"x","run_id":3}})),
            "moi",
            Some("ag".into()),
            Reglage::default(),
        )
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
            metadata: None,
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
