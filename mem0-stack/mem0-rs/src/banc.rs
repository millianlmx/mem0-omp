//! `mem0-rs banc` : banc de mesure de la recherche. Charge un corpus étiqueté
//! (souvenirs, requêtes, ids pertinents gradués) dans une base mem0-rs jetable,
//! joue chaque requête avec chaque stratégie de classement par le chemin de
//! `POST /memory/search` ([`recherche::executer`]), et rapporte par stratégie
//! Recall@5, Recall@10, MRR@10, nDCG@10 et la latence p50/p95 de la recherche
//! (lecture SQLite et fusion ; l'embedding de la requête, commun à toutes les
//! stratégies, est calculé une fois avant et n'est pas chronométré).
//!
//! ```text
//! mem0-rs banc [--corpus <fichier>] [--embedder local|openai] [--k <k,…>]
//!              [--seuil <x>] [--repetitions <n>] [--json]
//! ```
//!
//! - `--corpus` : défaut, le corpus intégré (`src/banc/corpus.json`).
//! - `--embedder local` (défaut) : plongeur déterministe hors ligne
//!   ([`plongeur`]) ; `openai` : l'API OpenAI-compatible des variables `OMLX_*`
//!   et `EMBEDDING_DIMS`, comme le serveur (oMLX, bge-m3).
//! - `--k` : constantes RRF mesurées (défaut `10,60`).
//! - `--seuil` : `threshold` des recherches (défaut 0 : on mesure le classement,
//!   pas le plancher).
//! - `--repetitions` : passes chronométrées par requête et stratégie (défaut 5).
//!
//! Codes : 0 succès, 1 erreur (corpus invalide, embedder, base), 2 usage.

mod metriques;
mod plongeur;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};

use crate::config;
use crate::db;
use crate::embedder::Embedder;
use crate::horodatage;
use crate::liens;
use crate::openai;
use crate::recherche::{self, Reglage, Strategie};
use crate::validation::SearchRequest;

/// Le corpus intégré au binaire.
const CORPUS_INTEGRE: &str = include_str!("banc/corpus.json");
/// Profondeur des recherches : les métriques vont jusqu'à @10.
const PROFONDEUR: usize = 10;
/// Portée des souvenirs du banc.
const AGENT: &str = "banc";
/// Dimension du plongeur local.
const DIMS_LOCAL: usize = 1024;

/// Arguments de `mem0-rs banc`.
#[derive(Debug, Clone, PartialEq)]
pub struct Arguments {
    pub corpus: Option<PathBuf>,
    pub embedder: TypeEmbedder,
    pub k: Vec<u32>,
    pub seuil: f64,
    pub repetitions: usize,
    pub json: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TypeEmbedder {
    Local,
    OpenAI,
}

/// Les arguments qui suivent `banc`. `Err(())` = usage (code 2) : option inconnue
/// ou répétée, valeur manquante ou invalide, argument positionnel.
pub fn lire_arguments(args: impl IntoIterator<Item = OsString>) -> Result<Arguments, ()> {
    let mut a = Arguments {
        corpus: None,
        embedder: TypeEmbedder::Local,
        k: vec![10, 60],
        seuil: 0.0,
        repetitions: 5,
        json: false,
    };
    let mut vus = HashSet::new();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let nom = arg.into_string().map_err(|_| ())?;
        if !vus.insert(nom.clone()) {
            return Err(());
        }
        let mut valeur = || args.next().and_then(|v| v.into_string().ok()).filter(|v| !v.is_empty()).ok_or(());
        match nom.as_str() {
            "--corpus" => a.corpus = Some(PathBuf::from(valeur()?)),
            "--embedder" => {
                a.embedder = match valeur()?.as_str() {
                    "local" => TypeEmbedder::Local,
                    "openai" => TypeEmbedder::OpenAI,
                    _ => return Err(()),
                }
            }
            "--k" => {
                let k: Vec<u32> = valeur()?
                    .split(',')
                    .map(|k| k.parse::<u32>().ok().filter(|&n| n > 0 && k.bytes().all(|o| o.is_ascii_digit())))
                    .collect::<Option<_>>()
                    .ok_or(())?;
                if k.is_empty() {
                    return Err(());
                }
                a.k = k;
            }
            "--seuil" => {
                a.seuil = valeur()?.parse::<f64>().ok().filter(|s| (0.0..=1.0).contains(s)).ok_or(())?;
            }
            "--repetitions" => {
                a.repetitions = valeur()?.parse::<usize>().ok().filter(|&n| n > 0).ok_or(())?;
            }
            "--json" => a.json = true,
            _ => return Err(()),
        }
    }
    Ok(a)
}

/// Corpus étiqueté (`src/banc/corpus.json`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Corpus {
    pub format: u32,
    /// Texte libre pour le lecteur du corpus ; le banc ne s'en sert pas.
    #[serde(default)]
    #[allow(dead_code, reason = "documentation du corpus, lue par les humains")]
    pub description: String,
    pub souvenirs: Vec<SouvenirCorpus>,
    /// Liens typés posés entre souvenirs, comme par un agent (`POST /memory/link`) :
    /// le bras graphe de la fusion `graphe` les suit.
    #[serde(default)]
    pub liens: Vec<LienCorpus>,
    pub requetes: Vec<RequeteCorpus>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LienCorpus {
    pub source: String,
    pub cible: String,
    #[serde(rename = "type")]
    pub type_: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SouvenirCorpus {
    pub id: String,
    pub texte: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequeteCorpus {
    pub id: String,
    pub categorie: String,
    pub texte: String,
    /// id du souvenir → grade (1 utile, 2 répond directement ; 3 au plus).
    pub pertinents: BTreeMap<String, u32>,
}

/// Lit et contrôle un corpus ; `Err(message)` s'il est inutilisable.
pub fn lire_corpus(texte: &str) -> Result<Corpus, String> {
    let corpus: Corpus = serde_json::from_str(texte).map_err(|e| format!("corpus illisible : {e}"))?;
    if corpus.format != 1 {
        return Err(format!("corpus : format {} inconnu (attendu 1)", corpus.format));
    }
    if corpus.souvenirs.is_empty() || corpus.requetes.is_empty() {
        return Err("corpus : souvenirs et requêtes ne peuvent pas être vides".to_owned());
    }
    let mut ids = HashSet::new();
    for s in &corpus.souvenirs {
        if s.texte.trim().is_empty() {
            return Err(format!("corpus : souvenir {} sans texte", s.id));
        }
        if !ids.insert(s.id.as_str()) {
            return Err(format!("corpus : souvenir {} en double", s.id));
        }
    }
    for l in &corpus.liens {
        if !ids.contains(l.source.as_str()) || !ids.contains(l.cible.as_str()) || l.source == l.cible {
            return Err(format!("corpus : lien {} → {} : souvenir inconnu ou boucle", l.source, l.cible));
        }
        if !liens::TYPES_AGENT.contains(&l.type_.as_str()) {
            return Err(format!("corpus : lien {} → {} : type {} inconnu", l.source, l.cible, l.type_));
        }
    }
    let mut requetes = HashSet::new();
    for q in &corpus.requetes {
        if !requetes.insert(q.id.as_str()) {
            return Err(format!("corpus : requête {} en double", q.id));
        }
        if q.texte.trim().is_empty() || q.categorie.trim().is_empty() {
            return Err(format!("corpus : requête {} sans texte ou sans catégorie", q.id));
        }
        if q.pertinents.is_empty() {
            return Err(format!("corpus : requête {} sans souvenir pertinent", q.id));
        }
        for (id, grade) in &q.pertinents {
            if !ids.contains(id.as_str()) {
                return Err(format!("corpus : requête {} : souvenir pertinent {id} inconnu", q.id));
            }
            if !(1..=3).contains(grade) {
                return Err(format!("corpus : requête {} : grade {grade} de {id} hors de 1..3", q.id));
            }
        }
    }
    Ok(corpus)
}

/// Les embeddings du banc : local déterministe ou API OpenAI-compatible.
enum Plongeur {
    Local,
    OpenAI(Embedder, usize),
}

impl Plongeur {
    fn dims(&self) -> usize {
        match self {
            Plongeur::Local => DIMS_LOCAL,
            Plongeur::OpenAI(_, dims) => *dims,
        }
    }

    fn nom(&self) -> &'static str {
        match self {
            Plongeur::Local => "local",
            Plongeur::OpenAI(..) => "openai",
        }
    }

    async fn plonger(&self, textes: &[String]) -> Result<Vec<Vec<f32>>, String> {
        match self {
            Plongeur::Local => Ok(textes.iter().map(|t| plongeur::plonger(t, DIMS_LOCAL)).collect()),
            Plongeur::OpenAI(e, _) => e.plonger_lot(textes).await.map_err(|e| e.to_string()),
        }
    }
}

/// Métriques d'un groupe de requêtes (toutes, ou une catégorie).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Mesures {
    pub requetes: usize,
    pub recall_5: f64,
    pub recall_10: f64,
    pub mrr_10: f64,
    pub ndcg_10: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Latence {
    pub p50: f64,
    pub p95: f64,
}

/// Résultat d'une stratégie.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ResultatStrategie {
    pub strategie: String,
    #[serde(flatten)]
    pub mesures: Mesures,
    pub latence_ms: Latence,
    pub categories: BTreeMap<String, Mesures>,
}

/// Le rapport complet (`--json`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Rapport {
    pub corpus: InfoCorpus,
    pub embedder: InfoEmbedder,
    pub profondeur: usize,
    pub seuil: f64,
    pub repetitions: usize,
    pub strategies: Vec<ResultatStrategie>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InfoCorpus {
    pub source: String,
    pub souvenirs: usize,
    pub requetes: usize,
    pub categories: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InfoEmbedder {
    #[serde(rename = "type")]
    pub type_: String,
    pub dims: usize,
}

/// Dossier jetable de la base du banc, supprimé à la fin.
struct Jetable(PathBuf);

impl Drop for Jetable {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Les stratégies mesurées : les deux classements seuls, l'additive, puis une
/// RRF par `k`.
pub fn strategies(k: &[u32]) -> Vec<Strategie> {
    let mut s = vec![Strategie::Semantique, Strategie::Bm25, Strategie::Additive];
    s.extend(k.iter().map(|&k| Strategie::Rrf { k }));
    s.extend(k.iter().map(|&k| Strategie::Graphe { k }));
    s
}

/// Une métrique d'une requête : ids rendus, grades des pertinents.
type Metrique = fn(&[String], &HashMap<String, u32>) -> f64;

fn mesurer(lignes: &[(&RequeteCorpus, Vec<String>)]) -> Mesures {
    let grades: Vec<HashMap<String, u32>> =
        lignes.iter().map(|(q, _)| q.pertinents.iter().map(|(id, g)| (id.clone(), *g)).collect()).collect();
    let colonne = |f: Metrique| {
        let v: Vec<f64> = lignes.iter().zip(&grades).map(|((_, rendus), p)| f(rendus, p)).collect();
        metriques::moyenne(&v)
    };
    Mesures {
        requetes: lignes.len(),
        recall_5: colonne(|r, p| metriques::rappel(r, p, 5)),
        recall_10: colonne(|r, p| metriques::rappel(r, p, 10)),
        mrr_10: colonne(|r, p| metriques::rang_reciproque(r, p, PROFONDEUR)),
        ndcg_10: colonne(|r, p| metriques::ndcg(r, p, PROFONDEUR)),
    }
}

/// Joue le banc ; `Err(message)` = code 1.
async fn jouer(a: &Arguments) -> Result<Rapport, String> {
    let (source, texte) = match &a.corpus {
        None => ("(intégré)".to_owned(), CORPUS_INTEGRE.to_owned()),
        Some(p) => (
            p.display().to_string(),
            std::fs::read_to_string(p).map_err(|e| format!("corpus {} illisible : {e}", p.display()))?,
        ),
    };
    let corpus = lire_corpus(&texte)?;
    let plongeur = match a.embedder {
        TypeEmbedder::Local => Plongeur::Local,
        TypeEmbedder::OpenAI => {
            let cfg = config::lire_env(|nom| std::env::var(nom).ok())?;
            let client = openai::client().map_err(|e| e.to_string())?;
            let e = Embedder::new(client, &cfg.base_url, &cfg.embed_model, &cfg.api_token, cfg.embedding_dims);
            Plongeur::OpenAI(e, cfg.embedding_dims)
        }
    };

    let textes: Vec<String> = corpus.souvenirs.iter().map(|s| s.texte.clone()).collect();
    let vecteurs = plongeur.plonger(&textes).await?;
    let questions: Vec<String> = corpus.requetes.iter().map(|q| q.texte.clone()).collect();
    let vecteurs_requetes = plongeur.plonger(&questions).await?;

    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let dossier = Jetable(std::env::temp_dir().join(format!("mem0-rs-banc-{}-{nanos}", std::process::id())));
    let base = dossier.0.join("banc.db");
    let mut conn = db::ouvrir(&base, plongeur.dims()).map_err(|e| e.message(&base.display().to_string()))?;
    let sqlite = |e: rusqlite::Error| format!("base du banc : {e}");
    for (s, v) in corpus.souvenirs.iter().zip(&vecteurs) {
        let hash: String = Md5::digest(s.texte.as_bytes()).iter().map(|o| format!("{o:02x}")).collect();
        let instant = horodatage::maintenant();
        let nouveau = db::NouveauSouvenir {
            id: &s.id,
            memory: &s.texte,
            hash: &hash,
            user_id: crate::http::USER,
            agent_id: Some(AGENT),
            run_id: None,
            role: Some("user"),
            attributed_to: None,
            tags: None,
            instant: &instant,
        };
        db::ajouter(&mut conn, &nouveau, v).map_err(sqlite)?;
    }
    let instant = horodatage::maintenant();
    for l in &corpus.liens {
        let lien = liens::Lien {
            source: l.source.clone(),
            target: l.cible.clone(),
            type_: l.type_.clone(),
            weight: 1.0,
            origin: "agent".to_owned(),
            reason: None,
            created_at: instant.iso.clone(),
        };
        liens::lier(&conn, &lien).map_err(sqlite)?;
    }

    let mut resultats = Vec::new();
    for strategie in strategies(&a.k) {
        let mut lignes: Vec<(&RequeteCorpus, Vec<String>)> = Vec::new();
        let mut temps: Vec<Duration> = Vec::new();
        for (q, vecteur) in corpus.requetes.iter().zip(&vecteurs_requetes) {
            let req = SearchRequest {
                query: q.texte.clone(),
                agent_id: None,
                limit: PROFONDEUR as i64,
                filters: None,
                threshold: Some(a.seuil),
                explain: true,
                fusion: None,
                liens: false,
            };
            let mut r = recherche::preparer(req, crate::http::USER, Some(AGENT.to_owned()), Reglage::default())
                .map_err(|e| format!("requête {} refusée : {e:?}", q.id))?;
            r.strategie = strategie;
            let mut rendus = Vec::new();
            for passe in 0..a.repetitions {
                let debut = Instant::now();
                let res = recherche::executer(&conn, &r, vecteur).map_err(sqlite)?;
                temps.push(debut.elapsed());
                if passe == 0 {
                    rendus = res.into_iter().map(|l| l.souvenir.id).collect();
                }
            }
            lignes.push((q, rendus));
        }
        let mut par_categorie: BTreeMap<String, Vec<(&RequeteCorpus, Vec<String>)>> = BTreeMap::new();
        for (q, rendus) in &lignes {
            par_categorie.entry(q.categorie.clone()).or_default().push((q, rendus.clone()));
        }
        resultats.push(ResultatStrategie {
            strategie: strategie.to_string(),
            mesures: mesurer(&lignes),
            latence_ms: Latence { p50: metriques::centile_ms(&temps, 50.0), p95: metriques::centile_ms(&temps, 95.0) },
            categories: par_categorie.into_iter().map(|(c, l)| (c, mesurer(&l))).collect(),
        });
    }
    drop(conn);

    let mut categories = BTreeMap::new();
    for q in &corpus.requetes {
        *categories.entry(q.categorie.clone()).or_insert(0) += 1;
    }
    Ok(Rapport {
        corpus: InfoCorpus { source, souvenirs: corpus.souvenirs.len(), requetes: corpus.requetes.len(), categories },
        embedder: InfoEmbedder { type_: plongeur.nom().to_owned(), dims: plongeur.dims() },
        profondeur: PROFONDEUR,
        seuil: a.seuil,
        repetitions: a.repetitions,
        strategies: resultats,
    })
}

/// Le rapport en texte : deux tableaux Markdown (global, nDCG@10 par catégorie).
pub fn rapport_texte(r: &Rapport) -> String {
    let categories: Vec<String> = r.corpus.categories.iter().map(|(c, n)| format!("{n} {c}")).collect();
    let mut t = format!(
        "banc mem0-rs : {} souvenirs, {} requêtes ({}), embedder {} ({} dims), seuil {}, {} répétitions\n\n",
        r.corpus.souvenirs,
        r.corpus.requetes,
        categories.join(", "),
        r.embedder.type_,
        r.embedder.dims,
        r.seuil,
        r.repetitions
    );
    t.push_str("| stratégie | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | p50 (ms) | p95 (ms) |\n");
    t.push_str("|---|---:|---:|---:|---:|---:|---:|\n");
    for s in &r.strategies {
        let m = &s.mesures;
        t.push_str(&format!(
            "| {} | {:.3} | {:.3} | {:.3} | {:.3} | {:.2} | {:.2} |\n",
            s.strategie, m.recall_5, m.recall_10, m.mrr_10, m.ndcg_10, s.latence_ms.p50, s.latence_ms.p95
        ));
    }
    let noms: Vec<&String> = r.corpus.categories.keys().collect();
    t.push_str("\nnDCG@10 par catégorie\n\n| stratégie |");
    for c in &noms {
        t.push_str(&format!(" {c} |"));
    }
    t.push_str("\n|---|");
    t.push_str(&"---:|".repeat(noms.len()));
    t.push('\n');
    for s in &r.strategies {
        t.push_str(&format!("| {} |", s.strategie));
        for c in &noms {
            t.push_str(&format!(" {:.3} |", s.categories.get(*c).map_or(0.0, |m| m.ndcg_10)));
        }
        t.push('\n');
    }
    t
}

pub async fn executer(args: impl IntoIterator<Item = OsString>) -> ExitCode {
    let Ok(a) = lire_arguments(args) else {
        eprintln!("{}", config::USAGE);
        return ExitCode::from(2);
    };
    match jouer(&a).await {
        Ok(rapport) => {
            if a.json {
                match serde_json::to_string(&rapport) {
                    Ok(json) => println!("{json}"),
                    Err(e) => {
                        eprintln!("mem0-rs banc : {e}");
                        return ExitCode::from(1);
                    }
                }
            } else {
                print!("{}", rapport_texte(&rapport));
            }
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("mem0-rs banc : {message}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<OsString> {
        v.iter().map(OsString::from).collect()
    }

    #[test]
    fn arguments_et_refus() {
        let a = lire_arguments(args(&[])).unwrap();
        assert_eq!(a.k, [10, 60]);
        assert_eq!((a.embedder, a.seuil, a.repetitions, a.json, a.corpus), (TypeEmbedder::Local, 0.0, 5, false, None));
        let a = lire_arguments(args(&[
            "--json",
            "--k",
            "1,60,200",
            "--embedder",
            "openai",
            "--seuil",
            "0.5",
            "--repetitions",
            "2",
            "--corpus",
            "c.json",
        ]))
        .unwrap();
        assert_eq!(a.k, [1, 60, 200]);
        assert_eq!((a.embedder, a.seuil, a.repetitions, a.json), (TypeEmbedder::OpenAI, 0.5, 2, true));
        assert_eq!(a.corpus, Some(PathBuf::from("c.json")));
        for faux in [
            &["--k"][..],
            &["--k", ""],
            &["--k", "0"],
            &["--k", "10,"],
            &["--k", "-1"],
            &["--k", "+5"],
            &["--embedder", "bge"],
            &["--seuil", "1.5"],
            &["--seuil", "x"],
            &["--repetitions", "0"],
            &["--json", "--json"],
            &["--corpus"],
            &["positionnel"],
        ] {
            assert_eq!(lire_arguments(args(faux)), Err(()), "{faux:?}");
        }
    }

    #[test]
    fn corpus_integre_valide() {
        let c = lire_corpus(CORPUS_INTEGRE).unwrap();
        assert!((100..=200).contains(&c.souvenirs.len()), "{} souvenirs", c.souvenirs.len());
        assert!((40..=60).contains(&c.requetes.len()), "{} requêtes", c.requetes.len());
        let categories: HashSet<&str> = c.requetes.iter().map(|q| q.categorie.as_str()).collect();
        assert_eq!(categories, HashSet::from(["lexicale", "paraphrase", "mixte", "liee"]));
        assert!(!c.liens.is_empty());
    }

    #[test]
    fn corpus_refuse() {
        let base = |souvenirs: &str, requetes: &str| {
            format!(r#"{{"format":1,"souvenirs":{souvenirs},"requetes":{requetes}}}"#)
        };
        let s = r#"[{"id":"a","texte":"x"}]"#;
        let q = |p: &str| format!(r#"[{{"id":"q","categorie":"c","texte":"t","pertinents":{p}}}]"#);
        assert!(lire_corpus(&base(s, &q(r#"{"a":2}"#))).is_ok());
        for (corpus, attendu) in [
            (base(s, &q(r#"{"b":2}"#)), "souvenir pertinent b inconnu"),
            (base(s, &q(r#"{"a":0}"#)), "grade 0"),
            (base(s, &q("{}")), "sans souvenir pertinent"),
            (base(r#"[{"id":"a","texte":"x"},{"id":"a","texte":"y"}]"#, &q(r#"{"a":1}"#)), "en double"),
            (base("[]", "[]"), "vides"),
            (r#"{"format":2,"souvenirs":[],"requetes":[]}"#.to_owned(), "format 2"),
            (
                format!(r#"{{"format":1,"souvenirs":{s},"liens":[{{"source":"a","cible":"z","type":"cause"}}],"requetes":{}}}"#, q(r#"{"a":1}"#)),
                "souvenir inconnu",
            ),
            (
                format!(
                    r#"{{"format":1,"souvenirs":[{{"id":"a","texte":"x"}},{{"id":"b","texte":"y"}}],"liens":[{{"source":"a","cible":"b","type":"semantique"}}],"requetes":{}}}"#,
                    q(r#"{"a":1}"#)
                ),
                "type semantique inconnu",
            ),
            (r#"{"format":1,"souvenirs":[],"requetes":[],"x":1}"#.to_owned(), "illisible"),
        ] {
            let e = lire_corpus(&corpus).unwrap_err();
            assert!(e.contains(attendu), "{e} ne contient pas {attendu}");
        }
    }

    #[test]
    fn strategies_mesurees() {
        let noms: Vec<String> = strategies(&[10, 60]).iter().map(ToString::to_string).collect();
        assert_eq!(noms, ["semantique", "bm25", "additive", "rrf-k10", "rrf-k60", "graphe-k10", "graphe-k60"]);
    }
}
