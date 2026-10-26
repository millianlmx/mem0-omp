//! Ligne de commande et variables d'environnement (S-1).

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use crate::recherche::{Fusion, RRF_K_PAR_DEFAUT, Reglage};
use crate::reve;
use crate::sauvegarde::Politique;

pub const USAGE: &str = "usage : mem0-rs [--host <adresse>] [--port <port>]
        mem0-rs import --history-db <chemin> [--qdrant-url <url>] [--collection <nom>] [--dry-run] [--json]
        mem0-rs banc [--corpus <fichier>] [--embedder local|openai] [--k <k,…>] [--seuil <x>] [--repetitions <n>] [--json]";

/// Adresse d'écoute demandée en ligne de commande.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ecoute {
    pub host: String,
    pub port: u16,
}

/// `mem0-rs [--host <adresse>] [--port <port>]`. `Err(())` = usage (code 2).
pub fn lire_arguments(args: impl IntoIterator<Item = OsString>) -> Result<Ecoute, ()> {
    let mut ecoute = Ecoute { host: "127.0.0.1".to_owned(), port: 8321 };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--host") => {
                ecoute.host = args.next().ok_or(())?.into_string().map_err(|_| ())?;
            }
            Some("--port") => {
                let brut = args.next().ok_or(())?.into_string().map_err(|_| ())?;
                ecoute.port = lire_port(&brut).ok_or(())?;
            }
            _ => return Err(()),
        }
    }
    Ok(ecoute)
}

/// Un entier décimal entre 1 et 65535, sans signe ni blanc.
fn lire_port(brut: &str) -> Option<u16> {
    if brut.is_empty() || !brut.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    brut.parse::<u16>().ok().filter(|&p| p != 0)
}

/// Arguments de `mem0-rs import` (S-1 de mem0-rs-migration).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArgumentsImport {
    pub history_db: PathBuf,
    /// Sans barre oblique finale.
    pub qdrant_url: String,
    pub collection: String,
    pub dry_run: bool,
    pub json: bool,
}

/// Les arguments qui suivent `import`. `Err(())` = usage (code 2) : option
/// inconnue ou répétée, valeur manquante ou vide, `--history-db` absente,
/// argument positionnel.
pub fn lire_arguments_import(args: impl IntoIterator<Item = OsString>) -> Result<ArgumentsImport, ()> {
    let mut args = args.into_iter();
    let (mut history_db, mut qdrant_url, mut collection) = (None, None, None);
    let (mut dry_run, mut json) = (false, false);
    while let Some(arg) = args.next() {
        let mut valeur = || args.next().filter(|v| !v.is_empty()).ok_or(());
        match arg.to_str() {
            Some("--history-db") if history_db.is_none() => history_db = Some(PathBuf::from(valeur()?)),
            Some("--qdrant-url") if qdrant_url.is_none() => {
                qdrant_url = Some(valeur()?.into_string().map_err(|_| ())?);
            }
            Some("--collection") if collection.is_none() => {
                collection = Some(valeur()?.into_string().map_err(|_| ())?);
            }
            Some("--dry-run") if !dry_run => dry_run = true,
            Some("--json") if !json => json = true,
            _ => return Err(()),
        }
    }
    let mut qdrant_url = qdrant_url.unwrap_or_else(|| "http://127.0.0.1:6333".to_owned());
    if qdrant_url.ends_with('/') {
        qdrant_url.pop();
    }
    Ok(ArgumentsImport {
        history_db: history_db.ok_or(())?,
        qdrant_url,
        collection: collection.unwrap_or_else(|| "omp_memory".to_owned()),
        dry_run,
        json,
    })
}

/// Configuration lue dans l'environnement.
#[derive(Clone)]
pub struct Config {
    pub base_url: String,
    pub embed_model: String,
    /// Secret : jamais imprimé.
    pub api_token: String,
    pub llm_model: String,
    pub embedding_dims: usize,
    pub db_path: PathBuf,
    /// Secret : jamais imprimé. Vide = aucun contrôle.
    pub http_token: String,
    pub installation_token: String,
    /// Instantanés périodiques de la base (`MEM0_BACKUP_INTERVAL_HOURS`, `MEM0_BACKUP_KEEP`).
    pub sauvegarde: Politique,
    /// Fusion de la recherche hybride (`MEM0_SEARCH_FUSION`, `MEM0_RRF_K`).
    pub recherche: Reglage,
    /// Rêve de fond (`MEM0_DREAM_INTERVAL_MINUTES`, `MEM0_DREAM_QUIET_MINUTES`,
    /// `MEM0_DREAM_PAIRS`, `MEM0_DREAM_FORGET_DAYS`).
    pub reve: reve::Reglage,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("base_url", &self.base_url)
            .field("embed_model", &self.embed_model)
            .field("llm_model", &self.llm_model)
            .field("embedding_dims", &self.embedding_dims)
            .field("db_path", &self.db_path)
            .field("sauvegarde", &self.sauvegarde)
            .field("recherche", &self.recherche)
            .field("reve", &self.reve)
            .finish_non_exhaustive()
    }
}

/// Blanc au sens de Python `str.isspace()` : le `White_Space` Unicode, plus
/// U+001C..U+001F que Python compte comme séparateurs.
pub fn blanc_python(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// `str.strip()` de Python.
pub fn strip_python(s: &str) -> &str {
    s.trim_matches(blanc_python)
}

/// `_env` de l'ancien mem0-http Python : absente ou blanche → défaut ; sinon trimée.
fn env_ou(lire: &impl Fn(&str) -> Option<String>, nom: &str, defaut: &str) -> String {
    match lire(nom) {
        Some(v) if !strip_python(&v).is_empty() => strip_python(&v).to_owned(),
        _ => defaut.to_owned(),
    }
}

/// Entier décimal sans signe d'une variable (défaut si absente ou blanche) ;
/// `Err(message)` sinon, ou s'il est sous `min`.
fn entier_env(lire: &impl Fn(&str) -> Option<String>, nom: &str, defaut: &str, min: u64) -> Result<u64, String> {
    let brut = env_ou(lire, nom, defaut);
    brut.parse::<u64>()
        .ok()
        .filter(|&v| v >= min && brut.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(|| {
            let attendu = if min == 0 { "un entier positif ou nul" } else { "un entier positif" };
            format!("{nom} doit être {attendu} (reçu « {brut} »)")
        })
}

/// Lit la configuration ; `Err(message)` = erreur fatale (code 1).
pub fn lire_env(lire: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
    let dims_brut = env_ou(&lire, "EMBEDDING_DIMS", "1024");
    let embedding_dims = dims_brut
        .parse::<usize>()
        .ok()
        .filter(|&d| d > 0)
        .ok_or_else(|| format!("EMBEDDING_DIMS doit être un entier positif (reçu « {dims_brut} »)"))?;
    let db_path = match lire("MEM0_DB_PATH") {
        Some(v) if !strip_python(&v).is_empty() => PathBuf::from(strip_python(&v)),
        _ => {
            let home = lire("HOME")
                .filter(|h| !h.is_empty())
                .ok_or_else(|| "MEM0_DB_PATH absente et HOME non défini : impossible de placer la base".to_owned())?;
            PathBuf::from(home).join(".mem0").join("mem0-rs.db")
        }
    };
    let heures = entier_env(&lire, "MEM0_BACKUP_INTERVAL_HOURS", "24", 0)?;
    let garder = entier_env(&lire, "MEM0_BACKUP_KEEP", "7", 1)?;
    let sauvegarde = Politique {
        intervalle: Duration::from_secs(heures.saturating_mul(3600)),
        garder: usize::try_from(garder).unwrap_or(usize::MAX),
    };
    let fusion_brute = env_ou(&lire, "MEM0_SEARCH_FUSION", "additive");
    let fusion = Fusion::lire(&fusion_brute)
        .ok_or_else(|| format!("MEM0_SEARCH_FUSION doit valoir additive, rrf ou graphe (reçu « {fusion_brute} »)"))?;
    let rrf_k = entier_env(&lire, "MEM0_RRF_K", &RRF_K_PAR_DEFAUT.to_string(), 1)?;
    let rrf_k = u32::try_from(rrf_k)
        .map_err(|_| format!("MEM0_RRF_K doit être un entier positif d'au plus {} (reçu « {rrf_k} »)", u32::MAX))?;
    let minutes = |nom: &str, defaut: &str, min: u64| -> Result<std::time::Duration, String> {
        Ok(Duration::from_secs(entier_env(&lire, nom, defaut, min)?.saturating_mul(60)))
    };
    let reve = reve::Reglage {
        intervalle: minutes("MEM0_DREAM_INTERVAL_MINUTES", "60", 0)?,
        calme: minutes("MEM0_DREAM_QUIET_MINUTES", "10", 0)?,
        paires: usize::try_from(entier_env(&lire, "MEM0_DREAM_PAIRS", "20", 0)?).unwrap_or(usize::MAX),
        oubli_jours: entier_env(&lire, "MEM0_DREAM_FORGET_DAYS", "180", 0)?,
    };
    Ok(Config {
        base_url: env_ou(&lire, "OMLX_BASE_URL", "http://host.containers.internal:8000/v1"),
        embed_model: env_ou(&lire, "OMLX_EMBED_MODEL", "bge-m3"),
        api_token: env_ou(&lire, "OMLX_API_TOKEN", "not-needed"),
        llm_model: env_ou(&lire, "OMLX_LLM_MODEL", "qwen3-8b"),
        embedding_dims,
        db_path,
        http_token: lire("MEM0_HTTP_TOKEN").unwrap_or_default(),
        installation_token: lire("OMP_INSTALLATION_TOKEN").unwrap_or_default(),
        sauvegarde,
        recherche: Reglage { fusion, rrf_k },
        reve,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn args(v: &[&str]) -> Vec<OsString> {
        v.iter().map(OsString::from).collect()
    }

    #[test]
    fn arguments() {
        assert_eq!(lire_arguments(args(&[])), Ok(Ecoute { host: "127.0.0.1".into(), port: 8321 }));
        assert_eq!(
            lire_arguments(args(&["--host", "0.0.0.0", "--port", "9000"])),
            Ok(Ecoute { host: "0.0.0.0".into(), port: 9000 })
        );
        for faux in [
            &["--port"][..],
            &["--port", "0"],
            &["--port", "65536"],
            &["--port", "abc"],
            &["--port", "+80"],
            &["--port", " 80"],
            &["--host"],
            &["--verbose"],
            &["8321"],
        ] {
            assert_eq!(lire_arguments(args(faux)), Err(()), "{faux:?}");
        }
    }

    #[test]
    fn arguments_import() {
        assert_eq!(
            lire_arguments_import(args(&["--history-db", "/h.db"])),
            Ok(ArgumentsImport {
                history_db: PathBuf::from("/h.db"),
                qdrant_url: "http://127.0.0.1:6333".into(),
                collection: "omp_memory".into(),
                dry_run: false,
                json: false,
            })
        );
        assert_eq!(
            lire_arguments_import(args(&[
                "--json", "--qdrant-url", "http://q:1/", "--dry-run", "--collection", "c", "--history-db", "h"
            ])),
            Ok(ArgumentsImport {
                history_db: PathBuf::from("h"),
                qdrant_url: "http://q:1".into(),
                collection: "c".into(),
                dry_run: true,
                json: true,
            })
        );
        for faux in [
            &[][..],
            &["--dry-run"],
            &["--history-db"],
            &["--history-db", ""],
            &["--history-db", "h", "--qdrant-url", ""],
            &["--history-db", "h", "--collection", ""],
            &["--history-db", "h", "--collection"],
            &["--history-db", "h", "--history-db", "i"],
            &["--history-db", "h", "--collection", "a", "--collection", "b"],
            &["--history-db", "h", "--qdrant-url", "u", "--qdrant-url", "u"],
            &["--history-db", "h", "--json", "--json"],
            &["--history-db", "h", "--dry-run", "--dry-run"],
            &["--history-db", "h", "--port", "80"],
            &["--history-db", "h", "en-trop"],
            &["--history-db", "h", ""],
        ] {
            assert_eq!(lire_arguments_import(args(faux)), Err(()), "{faux:?}");
        }
    }

    #[test]
    fn usage_a_trois_lignes() {
        assert_eq!(
            USAGE.lines().collect::<Vec<_>>(),
            [
                "usage : mem0-rs [--host <adresse>] [--port <port>]",
                "        mem0-rs import --history-db <chemin> [--qdrant-url <url>] [--collection <nom>] [--dry-run] [--json]",
                "        mem0-rs banc [--corpus <fichier>] [--embedder local|openai] [--k <k,…>] [--seuil <x>] [--repetitions <n>] [--json]",
            ]
        );
    }

    fn env(paires: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = paires.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn defauts_et_trim() {
        let c = lire_env(env(&[("HOME", "/h"), ("OMLX_EMBED_MODEL", "  m  "), ("OMLX_LLM_MODEL", "   ")])).unwrap();
        assert_eq!(c.base_url, "http://host.containers.internal:8000/v1");
        assert_eq!(c.embed_model, "m");
        assert_eq!(c.llm_model, "qwen3-8b");
        assert_eq!(c.api_token, "not-needed");
        assert_eq!(c.embedding_dims, 1024);
        assert_eq!(c.db_path, PathBuf::from("/h/.mem0/mem0-rs.db"));
        assert_eq!(c.http_token, "");
        let c = lire_env(env(&[("HOME", "/h"), ("MEM0_HTTP_TOKEN", " t ")])).unwrap();
        assert_eq!(c.http_token, " t ");
    }

    #[test]
    fn dims_invalides() {
        for v in ["abc", "0", "-3", "1.5", "1e3"] {
            let e = lire_env(env(&[("HOME", "/h"), ("EMBEDDING_DIMS", v)])).unwrap_err();
            assert_eq!(e, format!("EMBEDDING_DIMS doit être un entier positif (reçu « {v} »)"));
        }
        assert_eq!(lire_env(env(&[("HOME", "/h"), ("EMBEDDING_DIMS", " 8 ")])).unwrap().embedding_dims, 8);
    }

    #[test]
    fn instantanes_defauts_coupure_et_refus() {
        let jour = Duration::from_secs(24 * 3600);
        let c = lire_env(env(&[("HOME", "/h")])).unwrap();
        assert_eq!(c.sauvegarde, Politique { intervalle: jour, garder: 7 });
        let c = lire_env(env(&[("HOME", "/h"), ("MEM0_BACKUP_INTERVAL_HOURS", " 0 "), ("MEM0_BACKUP_KEEP", "3")])).unwrap();
        assert_eq!(c.sauvegarde, Politique { intervalle: Duration::ZERO, garder: 3 });
        for (nom, v, attendu) in [
            ("MEM0_BACKUP_INTERVAL_HOURS", "-1", "un entier positif ou nul"),
            ("MEM0_BACKUP_INTERVAL_HOURS", "1.5", "un entier positif ou nul"),
            ("MEM0_BACKUP_INTERVAL_HOURS", "+2", "un entier positif ou nul"),
            ("MEM0_BACKUP_KEEP", "0", "un entier positif"),
            ("MEM0_BACKUP_KEEP", "sept", "un entier positif"),
        ] {
            let e = lire_env(env(&[("HOME", "/h"), (nom, v)])).unwrap_err();
            assert_eq!(e, format!("{nom} doit être {attendu} (reçu « {v} »)"));
        }
    }

    #[test]
    fn fusion_de_recherche_defauts_et_refus() {
        let c = lire_env(env(&[("HOME", "/h")])).unwrap();
        assert_eq!(c.recherche, Reglage { fusion: Fusion::Additive, rrf_k: 60 });
        let c = lire_env(env(&[("HOME", "/h"), ("MEM0_SEARCH_FUSION", " rrf "), ("MEM0_RRF_K", "10")])).unwrap();
        assert_eq!(c.recherche, Reglage { fusion: Fusion::Rrf, rrf_k: 10 });
        let c = lire_env(env(&[("HOME", "/h"), ("MEM0_SEARCH_FUSION", "  "), ("MEM0_RRF_K", "")])).unwrap();
        assert_eq!(c.recherche, Reglage::default());
        for v in ["RRF", "reciprocal", "additive,rrf"] {
            let e = lire_env(env(&[("HOME", "/h"), ("MEM0_SEARCH_FUSION", v)])).unwrap_err();
            assert_eq!(e, format!("MEM0_SEARCH_FUSION doit valoir additive, rrf ou graphe (reçu « {v} »)"));
        }
        for v in ["0", "-1", "6.5", "soixante"] {
            let e = lire_env(env(&[("HOME", "/h"), ("MEM0_RRF_K", v)])).unwrap_err();
            assert_eq!(e, format!("MEM0_RRF_K doit être un entier positif (reçu « {v} »)"));
        }
        let e = lire_env(env(&[("HOME", "/h"), ("MEM0_RRF_K", "4294967296")])).unwrap_err();
        assert_eq!(e, "MEM0_RRF_K doit être un entier positif d'au plus 4294967295 (reçu « 4294967296 »)");
    }

    #[test]
    fn reve_defauts_coupure_et_refus() {
        let c = lire_env(env(&[("HOME", "/h")])).unwrap();
        assert_eq!(c.reve, reve::Reglage::default());
        let c = lire_env(env(&[("HOME", "/h"), ("MEM0_SEARCH_FUSION", "graphe")])).unwrap();
        assert_eq!(c.recherche.fusion, Fusion::Graphe);
        let c = lire_env(env(&[
            ("HOME", "/h"),
            ("MEM0_DREAM_INTERVAL_MINUTES", "0"),
            ("MEM0_DREAM_QUIET_MINUTES", "2"),
            ("MEM0_DREAM_PAIRS", "0"),
            ("MEM0_DREAM_FORGET_DAYS", "0"),
        ]))
        .unwrap();
        assert_eq!(
            c.reve,
            reve::Reglage { intervalle: Duration::ZERO, calme: Duration::from_secs(120), paires: 0, oubli_jours: 0 }
        );
        for nom in ["MEM0_DREAM_INTERVAL_MINUTES", "MEM0_DREAM_QUIET_MINUTES", "MEM0_DREAM_PAIRS", "MEM0_DREAM_FORGET_DAYS"] {
            let e = lire_env(env(&[("HOME", "/h"), (nom, "-1")])).unwrap_err();
            assert_eq!(e, format!("{nom} doit être un entier positif ou nul (reçu « -1 »)"));
        }
    }

    #[test]
    fn strip_comme_python() {
        assert_eq!(strip_python("\u{1c} a b\u{a0}\u{3000}"), "a b");
    }
}
