//! Ligne de commande et variables d'environnement (S-1).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::api::jetons::Jetons;
use crate::classement::recherche::{Fusion, RRF_K_PAR_DEFAUT, Reglage};
use crate::entretien::reve;
use crate::exploitation::sauvegarde::{Distante, Politique};

pub const USAGE: &str = "usage : memory-rs [--host <adresse>] [--port <port>]
        memory-rs import --history-db <chemin> [--qdrant-url <url>] [--collection <nom>] [--dry-run] [--json]
        memory-rs banc [--corpus <fichier>] [--embedder local|openai] [--k <k,…>] [--seuil <x>] [--repetitions <n>] [--json]";

/// Adresse d'écoute demandée en ligne de commande.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ecoute {
    pub host: String,
    pub port: u16,
}

/// `memory-rs [--host <adresse>] [--port <port>]`. `Err(())` = usage (code 2).
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

/// Arguments de `memory-rs import` (S-1 de memory-rs-migration).
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
    /// Base du chat (rêve, add infer=true) : `OMLX_CHAT_BASE_URL`, défaut
    /// `OMLX_BASE_URL` ; `None` = chat coupé (`off`).
    pub chat_base_url: Option<String>,
    /// Secret : jamais imprimé. `OMLX_CHAT_API_TOKEN`, défaut `OMLX_API_TOKEN`.
    pub chat_api_token: String,
    pub embedding_dims: usize,
    pub db_path: PathBuf,
    /// Secrets : jamais imprimés. `MEMORY_HTTP_TOKEN` (total) et les jetons à portées
    /// (`MEMORY_HTTP_TOKENS`, `MEMORY_HTTP_TOKENS_FILE`) ; aucun = aucun contrôle.
    pub jetons: Jetons,
    pub installation_token: String,
    /// Instantanés périodiques de la base (`MEMORY_BACKUP_INTERVAL_HOURS`, `MEMORY_BACKUP_KEEP`).
    pub sauvegarde: Politique,
    /// Copie hors machine de chaque instantané (`MEMORY_BACKUP_REMOTE_CMD`,
    /// `MEMORY_BACKUP_REMOTE_TIMEOUT_SECONDS`) ; la commande peut porter un secret : jamais imprimée.
    pub sauvegarde_distante: Option<Distante>,
    /// Le journal JSON (`MEMORY_LOG_DIR`, défaut `logs/` à côté de la base ; `MEMORY_LOG_RETENTION_DAYS`).
    pub journal_dossier: PathBuf,
    pub journal_retention_jours: u64,
    /// Fusion de la recherche hybride (`MEMORY_SEARCH_FUSION`, `MEMORY_RRF_K`).
    pub recherche: Reglage,
    /// Rêve de fond (`MEMORY_DREAM_INTERVAL_MINUTES`, `MEMORY_DREAM_QUIET_MINUTES`,
    /// `MEMORY_DREAM_PAIRS`, `MEMORY_DREAM_FORGET_DAYS`).
    pub reve: reve::Reglage,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("base_url", &self.base_url)
            .field("embed_model", &self.embed_model)
            .field("llm_model", &self.llm_model)
            .field("chat_base_url", &self.chat_base_url)
            .field("embedding_dims", &self.embedding_dims)
            .field("db_path", &self.db_path)
            .field("sauvegarde", &self.sauvegarde)
            .field("sauvegarde_distante", &self.sauvegarde_distante.is_some())
            .field("journal_dossier", &self.journal_dossier)
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

/// Valeur brute d'une variable renommée : celle de `nom` si elle n'est pas blanche (au sens de
/// `strip_python`), sinon celle de `ancien` si elle n'est pas blanche, sinon rien. L'ancien nom
/// n'est lu que pendant la version de transition.
fn lire_renomme(lire: &impl Fn(&str) -> Option<String>, nom: &str, ancien: &str) -> Option<String> {
    [nom, ancien].into_iter().find_map(|n| lire(n).filter(|v| !strip_python(v).is_empty()))
}

/// `_env` de l'ancien service Python : absente ou blanche → défaut ; sinon trimée.
fn env_ou(lire: &impl Fn(&str) -> Option<String>, nom: &str, defaut: &str) -> String {
    match lire(nom) {
        Some(v) if !strip_python(&v).is_empty() => strip_python(&v).to_owned(),
        _ => defaut.to_owned(),
    }
}

/// `env_ou` d'une variable renommée : `nom`, sinon `ancien`, sinon `defaut`.
fn env_renomme_ou(lire: &impl Fn(&str) -> Option<String>, nom: &str, ancien: &str, defaut: &str) -> String {
    lire_renomme(lire, nom, ancien).map_or_else(|| defaut.to_owned(), |v| strip_python(&v).to_owned())
}

/// Entier décimal sans signe d'une variable renommée (défaut si absente ou blanche) ;
/// `Err(message)` sinon, ou s'il est sous `min`. Le message nomme le nouveau nom.
fn entier_env(
    lire: &impl Fn(&str) -> Option<String>,
    nom: &str,
    ancien: &str,
    defaut: &str,
    min: u64,
) -> Result<u64, String> {
    let brut = env_renomme_ou(lire, nom, ancien, defaut);
    brut.parse::<u64>()
        .ok()
        .filter(|&v| v >= min && brut.bytes().all(|b| b.is_ascii_digit()))
        .ok_or_else(|| {
            let attendu = if min == 0 { "un entier positif ou nul" } else { "un entier positif" };
            format!("{nom} doit être {attendu} (reçu « {brut} »)")
        })
}

/// Nom de la base par défaut, et de la base de la version qui l'a précédé.
const BASE_PAR_DEFAUT: &str = "memory-rs.db";
const ANCIENNE_BASE: &str = "mem0-rs.db";

/// Chemin de la base (S-13). `P` : `MEMORY_DB_PATH` (repli `MEM0_DB_PATH`), sinon
/// `$HOME/.memory/memory-rs.db`. Si `P` n'existe pas et se nomme `memory-rs.db`, l'ancienne base
/// du même dossier (`mem0-rs.db`) la remplace quand elle existe ; sinon, si `P` vient du défaut
/// et n'existe pas, `$HOME/.mem0/mem0-rs.db` la remplace quand elle existe ; sinon `P`.
fn chemin_base(lire: &impl Fn(&str) -> Option<String>, existe: &impl Fn(&Path) -> bool) -> Result<PathBuf, String> {
    // `home` n'est posé que si `P` vient du défaut.
    let (p, home) = match lire_renomme(lire, "MEMORY_DB_PATH", "MEM0_DB_PATH") {
        Some(v) => (PathBuf::from(strip_python(&v)), None),
        None => {
            let home = lire("HOME")
                .filter(|h| !h.is_empty())
                .ok_or_else(|| "MEMORY_DB_PATH absente et HOME non défini : impossible de placer la base".to_owned())?;
            (PathBuf::from(&home).join(".memory").join(BASE_PAR_DEFAUT), Some(home))
        }
    };
    if existe(&p) {
        return Ok(p);
    }
    if p.file_name().is_some_and(|n| n == BASE_PAR_DEFAUT) {
        let ancienne = p.with_file_name(ANCIENNE_BASE);
        if existe(&ancienne) {
            return Ok(ancienne);
        }
    }
    if let Some(home) = home {
        let ancienne = PathBuf::from(home).join(".mem0").join(ANCIENNE_BASE);
        if existe(&ancienne) {
            return Ok(ancienne);
        }
    }
    Ok(p)
}

/// Valeur d'`OMLX_CHAT_BASE_URL` qui coupe le chat.
pub const CHAT_COUPE: &str = "off";

/// Lit la configuration ; `Err(message)` = erreur fatale (code 1).
pub fn lire_env(lire: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
    lire_env_avec(lire, &Path::exists)
}

/// [`lire_env`] avec la preuve d'existence d'un chemin injectée (la résolution de la base).
fn lire_env_avec(lire: impl Fn(&str) -> Option<String>, existe: &impl Fn(&Path) -> bool) -> Result<Config, String> {
    let dims_brut = env_ou(&lire, "EMBEDDING_DIMS", "1024");
    let embedding_dims = dims_brut
        .parse::<usize>()
        .ok()
        .filter(|&d| d > 0)
        .ok_or_else(|| format!("EMBEDDING_DIMS doit être un entier positif (reçu « {dims_brut} »)"))?;
    let db_path = chemin_base(&lire, existe)?;
    let heures = entier_env(&lire, "MEMORY_BACKUP_INTERVAL_HOURS", "MEM0_BACKUP_INTERVAL_HOURS", "24", 0)?;
    let garder = entier_env(&lire, "MEMORY_BACKUP_KEEP", "MEM0_BACKUP_KEEP", "7", 1)?;
    let sauvegarde = Politique {
        intervalle: Duration::from_secs(heures.saturating_mul(3600)),
        garder: usize::try_from(garder).unwrap_or(usize::MAX),
    };
    let commande_distante = env_renomme_ou(&lire, "MEMORY_BACKUP_REMOTE_CMD", "MEM0_BACKUP_REMOTE_CMD", "");
    let delai_distant = entier_env(
        &lire,
        "MEMORY_BACKUP_REMOTE_TIMEOUT_SECONDS",
        "MEM0_BACKUP_REMOTE_TIMEOUT_SECONDS",
        "600",
        1,
    )?;
    let sauvegarde_distante = (!commande_distante.is_empty())
        .then(|| Distante { commande: commande_distante, delai: Duration::from_secs(delai_distant) });
    let journal_dossier = match lire_renomme(&lire, "MEMORY_LOG_DIR", "MEM0_LOG_DIR") {
        Some(v) => PathBuf::from(strip_python(&v)),
        None => crate::exploitation::journal::dossier_par_defaut(&db_path),
    };
    let journal_retention_jours =
        entier_env(&lire, "MEMORY_LOG_RETENTION_DAYS", "MEM0_LOG_RETENTION_DAYS", "14", 1)?;
    let fusion_brute = env_renomme_ou(&lire, "MEMORY_SEARCH_FUSION", "MEM0_SEARCH_FUSION", "additive");
    let fusion = Fusion::lire(&fusion_brute)
        .ok_or_else(|| format!("MEMORY_SEARCH_FUSION doit valoir additive, rrf ou graphe (reçu « {fusion_brute} »)"))?;
    let rrf_k = entier_env(&lire, "MEMORY_RRF_K", "MEM0_RRF_K", &RRF_K_PAR_DEFAUT.to_string(), 1)?;
    let rrf_k = u32::try_from(rrf_k)
        .map_err(|_| format!("MEMORY_RRF_K doit être un entier positif d'au plus {} (reçu « {rrf_k} »)", u32::MAX))?;
    let minutes = |nom: &str, ancien: &str, defaut: &str, min: u64| -> Result<std::time::Duration, String> {
        Ok(Duration::from_secs(entier_env(&lire, nom, ancien, defaut, min)?.saturating_mul(60)))
    };
    let reve = reve::Reglage {
        intervalle: minutes("MEMORY_DREAM_INTERVAL_MINUTES", "MEM0_DREAM_INTERVAL_MINUTES", "60", 0)?,
        calme: minutes("MEMORY_DREAM_QUIET_MINUTES", "MEM0_DREAM_QUIET_MINUTES", "10", 0)?,
        paires: usize::try_from(entier_env(&lire, "MEMORY_DREAM_PAIRS", "MEM0_DREAM_PAIRS", "20", 0)?)
            .unwrap_or(usize::MAX),
        oubli_jours: entier_env(&lire, "MEMORY_DREAM_FORGET_DAYS", "MEM0_DREAM_FORGET_DAYS", "180", 0)?,
    };
    let base_url = env_ou(&lire, "OMLX_BASE_URL", "http://host.containers.internal:8000/v1");
    let api_token = env_ou(&lire, "OMLX_API_TOKEN", "not-needed");
    let chat_base_url = env_ou(&lire, "OMLX_CHAT_BASE_URL", &base_url);
    let fichier = match lire_renomme(&lire, "MEMORY_HTTP_TOKENS_FILE", "MEM0_HTTP_TOKENS_FILE")
        .map(|v| strip_python(&v).to_owned())
    {
        Some(chemin) => {
            let contenu = std::fs::read_to_string(&chemin)
                .map_err(|e| format!("MEMORY_HTTP_TOKENS_FILE={chemin} illisible : {e}"))?;
            Some((chemin, contenu))
        }
        None => None,
    };
    let liste = lire_renomme(&lire, "MEMORY_HTTP_TOKENS", "MEM0_HTTP_TOKENS");
    let jetons = Jetons::lire(
        lire_renomme(&lire, "MEMORY_HTTP_TOKEN", "MEM0_HTTP_TOKEN").unwrap_or_default(),
        liste.as_deref(),
        fichier.as_ref().map(|(chemin, contenu)| (chemin.as_str(), contenu.as_str())),
    )
    .map_err(|e| format!("jetons de l'API : {e}"))?;
    Ok(Config {
        chat_base_url: (!chat_base_url.eq_ignore_ascii_case(CHAT_COUPE)).then_some(chat_base_url),
        chat_api_token: env_ou(&lire, "OMLX_CHAT_API_TOKEN", &api_token),
        base_url,
        embed_model: env_ou(&lire, "OMLX_EMBED_MODEL", "bge-m3"),
        api_token,
        llm_model: env_ou(&lire, "OMLX_LLM_MODEL", "qwen3-8b"),
        embedding_dims,
        db_path,
        jetons,
        installation_token: lire("OMP_INSTALLATION_TOKEN").unwrap_or_default(),
        sauvegarde,
        sauvegarde_distante,
        journal_dossier,
        journal_retention_jours,
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
                "usage : memory-rs [--host <adresse>] [--port <port>]",
                "        memory-rs import --history-db <chemin> [--qdrant-url <url>] [--collection <nom>] [--dry-run] [--json]",
                "        memory-rs banc [--corpus <fichier>] [--embedder local|openai] [--k <k,…>] [--seuil <x>] [--repetitions <n>] [--json]",
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
        assert_eq!(c.db_path, PathBuf::from("/h/.memory/memory-rs.db"));
        assert!(!c.jetons.exige());
        let c = lire_env(env(&[("HOME", "/h"), ("MEMORY_HTTP_TOKEN", " t ")])).unwrap();
        assert_eq!(c.jetons.identifier(Some(b" t ")), Some(crate::api::jetons::Acces::Total));
    }

    #[test]
    fn chat_herite_de_la_base_ou_coupe() {
        let c = lire_env(env(&[("HOME", "/h"), ("OMLX_BASE_URL", "http://e/v1"), ("OMLX_API_TOKEN", "k")])).unwrap();
        assert_eq!((c.chat_base_url.as_deref(), c.chat_api_token.as_str()), (Some("http://e/v1"), "k"));
        let c = lire_env(env(&[("HOME", "/h")])).unwrap();
        assert_eq!((c.chat_base_url.as_deref(), c.chat_api_token.as_str()), (Some("http://host.containers.internal:8000/v1"), "not-needed"));
        let c = lire_env(env(&[
            ("HOME", "/h"),
            ("OMLX_BASE_URL", "http://e/v1"),
            ("OMLX_CHAT_BASE_URL", " http://c/v1 "),
            ("OMLX_CHAT_API_TOKEN", "kc"),
        ]))
        .unwrap();
        assert_eq!((c.base_url.as_str(), c.api_token.as_str()), ("http://e/v1", "not-needed"));
        assert_eq!((c.chat_base_url.as_deref(), c.chat_api_token.as_str()), (Some("http://c/v1"), "kc"));
        for coupe in ["off", " OFF "] {
            let c = lire_env(env(&[("HOME", "/h"), ("OMLX_CHAT_BASE_URL", coupe)])).unwrap();
            assert_eq!(c.chat_base_url, None, "{coupe:?}");
        }
        let c = lire_env(env(&[("HOME", "/h"), ("OMLX_CHAT_BASE_URL", "   ")])).unwrap();
        assert_eq!(c.chat_base_url.as_deref(), Some("http://host.containers.internal:8000/v1"), "blanche : héritée");
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
        let c = lire_env(env(&[("HOME", "/h"), ("MEMORY_BACKUP_INTERVAL_HOURS", " 0 "), ("MEMORY_BACKUP_KEEP", "3")])).unwrap();
        assert_eq!(c.sauvegarde, Politique { intervalle: Duration::ZERO, garder: 3 });
        for (nom, v, attendu) in [
            ("MEMORY_BACKUP_INTERVAL_HOURS", "-1", "un entier positif ou nul"),
            ("MEMORY_BACKUP_INTERVAL_HOURS", "1.5", "un entier positif ou nul"),
            ("MEMORY_BACKUP_INTERVAL_HOURS", "+2", "un entier positif ou nul"),
            ("MEMORY_BACKUP_KEEP", "0", "un entier positif"),
            ("MEMORY_BACKUP_KEEP", "sept", "un entier positif"),
        ] {
            let e = lire_env(env(&[("HOME", "/h"), (nom, v)])).unwrap_err();
            assert_eq!(e, format!("{nom} doit être {attendu} (reçu « {v} »)"));
        }
    }

    #[test]
    fn copie_distante_et_journal() {
        let c = lire_env(env(&[("HOME", "/h")])).unwrap();
        assert_eq!(c.sauvegarde_distante, None);
        assert_eq!(c.journal_dossier, PathBuf::from("/h/.memory/logs"));
        assert_eq!(c.journal_retention_jours, 14);
        let c = lire_env(env(&[
            ("MEMORY_DB_PATH", "/d/memory.db"),
            ("MEMORY_BACKUP_REMOTE_CMD", " restic backup \"$1\" "),
            ("MEMORY_LOG_DIR", "/var/log/memory"),
            ("MEMORY_LOG_RETENTION_DAYS", "3"),
        ]))
        .unwrap();
        assert_eq!(
            c.sauvegarde_distante,
            Some(Distante { commande: "restic backup \"$1\"".into(), delai: Duration::from_secs(600) })
        );
        assert_eq!((c.journal_dossier.clone(), c.journal_retention_jours), (PathBuf::from("/var/log/memory"), 3));
        assert!(!format!("{c:?}").contains("restic"), "la commande n'est pas imprimée");
        let e = lire_env(env(&[("HOME", "/h"), ("MEMORY_LOG_RETENTION_DAYS", "0")])).unwrap_err();
        assert!(e.starts_with("MEMORY_LOG_RETENTION_DAYS"), "{e}");
    }

    #[test]
    fn fusion_de_recherche_defauts_et_refus() {
        let c = lire_env(env(&[("HOME", "/h")])).unwrap();
        assert_eq!(c.recherche, Reglage { fusion: Fusion::Additive, rrf_k: 60 });
        let c = lire_env(env(&[("HOME", "/h"), ("MEMORY_SEARCH_FUSION", " rrf "), ("MEMORY_RRF_K", "10")])).unwrap();
        assert_eq!(c.recherche, Reglage { fusion: Fusion::Rrf, rrf_k: 10 });
        let c = lire_env(env(&[("HOME", "/h"), ("MEMORY_SEARCH_FUSION", "  "), ("MEMORY_RRF_K", "")])).unwrap();
        assert_eq!(c.recherche, Reglage::default());
        for v in ["RRF", "reciprocal", "additive,rrf"] {
            let e = lire_env(env(&[("HOME", "/h"), ("MEMORY_SEARCH_FUSION", v)])).unwrap_err();
            assert_eq!(e, format!("MEMORY_SEARCH_FUSION doit valoir additive, rrf ou graphe (reçu « {v} »)"));
        }
        for v in ["0", "-1", "6.5", "soixante"] {
            let e = lire_env(env(&[("HOME", "/h"), ("MEMORY_RRF_K", v)])).unwrap_err();
            assert_eq!(e, format!("MEMORY_RRF_K doit être un entier positif (reçu « {v} »)"));
        }
        let e = lire_env(env(&[("HOME", "/h"), ("MEMORY_RRF_K", "4294967296")])).unwrap_err();
        assert_eq!(e, "MEMORY_RRF_K doit être un entier positif d'au plus 4294967295 (reçu « 4294967296 »)");
    }

    #[test]
    fn reve_defauts_coupure_et_refus() {
        let c = lire_env(env(&[("HOME", "/h")])).unwrap();
        assert_eq!(c.reve, reve::Reglage::default());
        let c = lire_env(env(&[("HOME", "/h"), ("MEMORY_SEARCH_FUSION", "graphe")])).unwrap();
        assert_eq!(c.recherche.fusion, Fusion::Graphe);
        let c = lire_env(env(&[
            ("HOME", "/h"),
            ("MEMORY_DREAM_INTERVAL_MINUTES", "0"),
            ("MEMORY_DREAM_QUIET_MINUTES", "2"),
            ("MEMORY_DREAM_PAIRS", "0"),
            ("MEMORY_DREAM_FORGET_DAYS", "0"),
        ]))
        .unwrap();
        assert_eq!(
            c.reve,
            reve::Reglage { intervalle: Duration::ZERO, calme: Duration::from_secs(120), paires: 0, oubli_jours: 0 }
        );
        for nom in ["MEMORY_DREAM_INTERVAL_MINUTES", "MEMORY_DREAM_QUIET_MINUTES", "MEMORY_DREAM_PAIRS", "MEMORY_DREAM_FORGET_DAYS"] {
            let e = lire_env(env(&[("HOME", "/h"), (nom, "-1")])).unwrap_err();
            assert_eq!(e, format!("{nom} doit être un entier positif ou nul (reçu « -1 »)"));
        }
    }

    #[test]
    fn strip_comme_python() {
        assert_eq!(strip_python("\u{1c} a b\u{a0}\u{3000}"), "a b");
    }

    #[test]
    fn lire_renomme_nouveau_puis_ancien() {
        let n = "MEMORY_X";
        let a = "MEM0_X";
        assert_eq!(lire_renomme(&env(&[(a, "vieux")]), n, a).as_deref(), Some("vieux"));
        assert_eq!(lire_renomme(&env(&[(n, "neuf")]), n, a).as_deref(), Some("neuf"));
        assert_eq!(lire_renomme(&env(&[(n, "neuf"), (a, "vieux")]), n, a).as_deref(), Some("neuf"));
        assert_eq!(lire_renomme(&env(&[(n, ""), (a, "vieux")]), n, a).as_deref(), Some("vieux"));
        assert_eq!(lire_renomme(&env(&[(n, " \t"), (a, "vieux")]), n, a).as_deref(), Some("vieux"));
        assert_eq!(lire_renomme(&env(&[(n, ""), (a, "")]), n, a), None);
        assert_eq!(lire_renomme(&env(&[(a, "  ")]), n, a), None);
        assert_eq!(lire_renomme(&env(&[]), n, a), None);
        assert_eq!(lire_renomme(&env(&[(n, " t ")]), n, a).as_deref(), Some(" t "), "valeur brute");
    }

    /// S-6 : `MEMORY_HTTP_TOKEN` lu sous le nouveau nom, sinon sous l'ancien.
    #[test]
    fn jeton_total_nouveau_ancien_les_deux_et_nouveau_vide() {
        use crate::api::jetons::Acces;
        let jeton = |paires: &[(&str, &str)]| {
            let mut tout = vec![("HOME", "/h")];
            tout.extend_from_slice(paires);
            lire_env(env(&tout)).unwrap().jetons
        };
        let j = jeton(&[("MEM0_HTTP_TOKEN", "ancien")]);
        assert_eq!(j.identifier(Some(b"ancien")), Some(Acces::Total));
        assert_eq!(j.identifier(Some(b"autre")), None);
        let j = jeton(&[("MEMORY_HTTP_TOKEN", "nouveau")]);
        assert_eq!(j.identifier(Some(b"nouveau")), Some(Acces::Total));
        assert_eq!(j.identifier(Some(b"ancien")), None);
        let j = jeton(&[("MEMORY_HTTP_TOKEN", "nouveau"), ("MEM0_HTTP_TOKEN", "ancien")]);
        assert_eq!(j.identifier(Some(b"nouveau")), Some(Acces::Total));
        assert_eq!(j.identifier(Some(b"ancien")), None, "le nouveau l'emporte");
        let j = jeton(&[("MEMORY_HTTP_TOKEN", ""), ("MEM0_HTTP_TOKEN", "ancien")]);
        assert_eq!(j.identifier(Some(b"ancien")), Some(Acces::Total));
        assert_eq!(j.identifier(Some(b"")), None);
        let j = jeton(&[("MEMORY_HTTP_TOKEN", ""), ("MEM0_HTTP_TOKEN", "")]);
        assert!(!j.exige(), "les deux vides : aucun contrôle");
    }

    /// S-6 : jetons à portées, liste et fichier, sous l'un ou l'autre nom.
    #[test]
    fn jetons_a_portees_sous_l_ancien_nom() {
        let secret = "0123456789abcdefghij";
        let liste = format!("client:{secret}:p1,p2");
        let liste = liste.as_str();
        let c = lire_env(env(&[("HOME", "/h"), ("MEM0_HTTP_TOKENS", liste)])).unwrap();
        assert_eq!(c.jetons.limites(), 1);
        let c = lire_env(env(&[("HOME", "/h"), ("MEMORY_HTTP_TOKENS", liste)])).unwrap();
        assert_eq!(c.jetons.limites(), 1);
        let c = lire_env(env(&[("HOME", "/h"), ("MEMORY_HTTP_TOKENS", ""), ("MEM0_HTTP_TOKENS", liste)])).unwrap();
        assert_eq!(c.jetons.limites(), 1);
        let d = Dossier::new();
        let fichier = d.fichier("jetons.txt");
        std::fs::write(&fichier, format!("# commentaire\nautre:{secret}:p3\n")).unwrap();
        let chemin = fichier.to_str().unwrap();
        let c = lire_env(env(&[("HOME", "/h"), ("MEM0_HTTP_TOKENS_FILE", chemin)])).unwrap();
        assert_eq!(c.jetons.limites(), 1);
        let c = lire_env(env(&[("HOME", "/h"), ("MEMORY_HTTP_TOKENS_FILE", chemin)])).unwrap();
        assert_eq!(c.jetons.limites(), 1);
        let e = lire_env(env(&[("HOME", "/h"), ("MEMORY_HTTP_TOKENS_FILE", "/absent/jetons")])).unwrap_err();
        assert!(e.starts_with("MEMORY_HTTP_TOKENS_FILE=/absent/jetons illisible"), "{e}");
    }

    /// S-6 : `MEMORY_SEARCH_FUSION` lu sous le nouveau nom, sinon sous l'ancien.
    #[test]
    fn fusion_nouveau_ancien_les_deux_et_nouveau_vide() {
        let fusion = |paires: &[(&str, &str)]| {
            let mut tout = vec![("HOME", "/h")];
            tout.extend_from_slice(paires);
            lire_env(env(&tout)).unwrap().recherche.fusion
        };
        assert_eq!(fusion(&[("MEM0_SEARCH_FUSION", "rrf")]), Fusion::Rrf);
        assert_eq!(fusion(&[("MEMORY_SEARCH_FUSION", "graphe")]), Fusion::Graphe);
        assert_eq!(fusion(&[("MEMORY_SEARCH_FUSION", "graphe"), ("MEM0_SEARCH_FUSION", "rrf")]), Fusion::Graphe);
        assert_eq!(fusion(&[("MEMORY_SEARCH_FUSION", ""), ("MEM0_SEARCH_FUSION", "rrf")]), Fusion::Rrf);
        assert_eq!(fusion(&[("MEMORY_SEARCH_FUSION", " "), ("MEM0_SEARCH_FUSION", " ")]), Fusion::Additive);
        let e = lire_env(env(&[("HOME", "/h"), ("MEM0_SEARCH_FUSION", "RRF")])).unwrap_err();
        assert_eq!(e, "MEMORY_SEARCH_FUSION doit valoir additive, rrf ou graphe (reçu « RRF »)");
    }

    /// S-6 : chaque autre variable de la classe V du service, sous l'ancien nom seul, puis les deux.
    #[test]
    fn autres_variables_sous_l_ancien_nom() {
        let c = lire_env(env(&[
            ("HOME", "/h"),
            ("MEM0_BACKUP_INTERVAL_HOURS", "5"),
            ("MEM0_BACKUP_KEEP", "2"),
            ("MEM0_BACKUP_REMOTE_CMD", "cp \"$1\" /x"),
            ("MEM0_BACKUP_REMOTE_TIMEOUT_SECONDS", "9"),
            ("MEM0_LOG_DIR", "/var/log/ancien"),
            ("MEM0_LOG_RETENTION_DAYS", "3"),
            ("MEM0_RRF_K", "10"),
            ("MEM0_DREAM_INTERVAL_MINUTES", "1"),
            ("MEM0_DREAM_QUIET_MINUTES", "2"),
            ("MEM0_DREAM_PAIRS", "3"),
            ("MEM0_DREAM_FORGET_DAYS", "4"),
        ]))
        .unwrap();
        assert_eq!(c.sauvegarde, Politique { intervalle: Duration::from_secs(5 * 3600), garder: 2 });
        assert_eq!(
            c.sauvegarde_distante,
            Some(Distante { commande: "cp \"$1\" /x".into(), delai: Duration::from_secs(9) })
        );
        assert_eq!((c.journal_dossier.clone(), c.journal_retention_jours), (PathBuf::from("/var/log/ancien"), 3));
        assert_eq!(c.recherche.rrf_k, 10);
        assert_eq!(
            c.reve,
            reve::Reglage {
                intervalle: Duration::from_secs(60),
                calme: Duration::from_secs(120),
                paires: 3,
                oubli_jours: 4
            }
        );
        let c = lire_env(env(&[
            ("HOME", "/h"),
            ("MEMORY_BACKUP_KEEP", "8"),
            ("MEM0_BACKUP_KEEP", "2"),
            ("MEMORY_DREAM_PAIRS", "7"),
            ("MEM0_DREAM_PAIRS", "3"),
            ("MEMORY_LOG_DIR", "/var/log/nouveau"),
            ("MEM0_LOG_DIR", "/var/log/ancien"),
        ]))
        .unwrap();
        assert_eq!((c.sauvegarde.garder, c.reve.paires), (8, 7));
        assert_eq!(c.journal_dossier, PathBuf::from("/var/log/nouveau"));
        let e = lire_env(env(&[("HOME", "/h"), ("MEM0_DREAM_PAIRS", "-1")])).unwrap_err();
        assert_eq!(e, "MEMORY_DREAM_PAIRS doit être un entier positif ou nul (reçu « -1 »)");
        let c = lire_env(env(&[("HOME", "/h"), ("MEMORY_BACKUP_KEEP", ""), ("MEM0_BACKUP_KEEP", "4")])).unwrap();
        assert_eq!(c.sauvegarde.garder, 4, "nouveau vide : l'ancien");
    }

    /// S-6 : `MEMORY_DB_PATH` lu sous le nouveau nom, sinon sous l'ancien.
    #[test]
    fn chemin_explicite_nouveau_ancien_les_deux_et_nouveau_vide() {
        let chemin = |paires: &[(&str, &str)]| lire_env(env(paires)).unwrap().db_path;
        assert_eq!(chemin(&[("MEM0_DB_PATH", "/d/ancien.db")]), PathBuf::from("/d/ancien.db"));
        assert_eq!(chemin(&[("MEMORY_DB_PATH", "/d/nouveau.db")]), PathBuf::from("/d/nouveau.db"));
        assert_eq!(
            chemin(&[("MEMORY_DB_PATH", "/d/nouveau.db"), ("MEM0_DB_PATH", "/d/ancien.db")]),
            PathBuf::from("/d/nouveau.db")
        );
        assert_eq!(
            chemin(&[("MEMORY_DB_PATH", ""), ("MEM0_DB_PATH", " /d/ancien.db ")]),
            PathBuf::from("/d/ancien.db")
        );
        let e = lire_env(env(&[("MEMORY_DB_PATH", " "), ("MEM0_DB_PATH", "")])).unwrap_err();
        assert_eq!(e, "MEMORY_DB_PATH absente et HOME non défini : impossible de placer la base");
    }

    /// Dossier temporaire unique, supprimé à la fin du test.
    struct Dossier(PathBuf);

    impl Dossier {
        fn new() -> Self {
            Dossier(std::env::temp_dir().join(format!("memory-rs-config-{}", uuid::Uuid::new_v4())))
        }

        /// Crée le fichier `rel` (et ses dossiers) sous ce dossier ; rend son chemin.
        fn fichier(&self, rel: &str) -> PathBuf {
            let chemin = self.0.join(rel);
            std::fs::create_dir_all(chemin.parent().unwrap()).unwrap();
            std::fs::write(&chemin, b"").unwrap();
            chemin
        }

        fn home(&self) -> String {
            self.0.to_str().unwrap().to_owned()
        }
    }

    impl Drop for Dossier {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// S-13 : les quatre règles, sur de vrais dossiers.
    #[test]
    fn base_par_defaut_et_repli_sur_l_ancienne() {
        // Rien n'existe : la base par défaut, journal à côté.
        let d = Dossier::new();
        let home = d.home();
        let c = lire_env(env(&[("HOME", home.as_str())])).unwrap();
        assert_eq!(c.db_path, d.0.join(".memory/memory-rs.db"));
        assert_eq!(c.journal_dossier, d.0.join(".memory/logs"));

        // Seul `~/.mem0/mem0-rs.db` existe : c'est lui, et le journal le suit.
        let d = Dossier::new();
        let home = d.home();
        let ancienne = d.fichier(".mem0/mem0-rs.db");
        let c = lire_env(env(&[("HOME", home.as_str())])).unwrap();
        assert_eq!(c.db_path, ancienne);
        assert_eq!(c.journal_dossier, d.0.join(".mem0/logs"));
        assert!(!d.0.join(".memory").exists(), "rien n'est créé ni déplacé");

        // Les deux existent : la nouvelle l'emporte.
        let nouvelle = d.fichier(".memory/memory-rs.db");
        let c = lire_env(env(&[("HOME", home.as_str())])).unwrap();
        assert_eq!(c.db_path, nouvelle);
        assert_eq!(c.journal_dossier, d.0.join(".memory/logs"));

        // `~/.memory/mem0-rs.db` (même dossier que le défaut) : prise avant `~/.mem0/`.
        let d = Dossier::new();
        let home = d.home();
        d.fichier(".mem0/mem0-rs.db");
        let voisine = d.fichier(".memory/mem0-rs.db");
        let c = lire_env(env(&[("HOME", home.as_str())])).unwrap();
        assert_eq!(c.db_path, voisine);
        assert_eq!(c.journal_dossier, d.0.join(".memory/logs"));
    }

    /// S-13 : `MEMORY_DB_PATH` nommé `memory-rs.db` retombe sur `mem0-rs.db` de son dossier,
    /// jamais sur `~/.mem0/` ; un autre nom n'a pas de repli.
    #[test]
    fn base_explicite_repli_dans_son_dossier() {
        let d = Dossier::new();
        let home = d.home();
        let home = home.as_str();
        d.fichier(".mem0/mem0-rs.db");
        let voisine = d.fichier("data/mem0-rs.db");
        let demandee = d.0.join("data/memory-rs.db");
        let c = lire_env(env(&[("HOME", home), ("MEMORY_DB_PATH", demandee.to_str().unwrap())])).unwrap();
        assert_eq!(c.db_path, voisine);
        assert_eq!(c.journal_dossier, d.0.join("data/logs"));
        let c = lire_env(env(&[("HOME", home), ("MEM0_DB_PATH", demandee.to_str().unwrap())])).unwrap();
        assert_eq!(c.db_path, voisine, "le repli vaut aussi sous l'ancien nom de la variable");

        // La demandée existe : elle l'emporte.
        let demandee = d.fichier("data/memory-rs.db");
        let c = lire_env(env(&[("HOME", home), ("MEMORY_DB_PATH", demandee.to_str().unwrap())])).unwrap();
        assert_eq!(c.db_path, demandee);

        // Ni la demandée ni sa voisine : `~/.mem0/mem0-rs.db` n'est pas consulté (P ne vient pas du défaut).
        let autre = d.0.join("ailleurs/memory-rs.db");
        let c = lire_env(env(&[("HOME", home), ("MEMORY_DB_PATH", autre.to_str().unwrap())])).unwrap();
        assert_eq!(c.db_path, autre);

        // Un autre nom de fichier n'a pas de repli, même si une `mem0-rs.db` est à côté.
        let nommee = d.0.join("data/souvenirs.db");
        let c = lire_env(env(&[("HOME", home), ("MEMORY_DB_PATH", nommee.to_str().unwrap())])).unwrap();
        assert_eq!(c.db_path, nommee);
        assert_eq!(c.journal_dossier, d.0.join("data/logs"));
    }

    /// S-13, existence injectée : ordre des règles, sans toucher au disque.
    #[test]
    fn chemin_base_existence_injectee() {
        let present = |ps: &'static [&'static str]| move |p: &Path| ps.iter().any(|q| p == Path::new(q));
        let lire = env(&[("HOME", "/h")]);
        assert_eq!(chemin_base(&lire, &present(&[])).unwrap(), PathBuf::from("/h/.memory/memory-rs.db"));
        assert_eq!(
            chemin_base(&lire, &present(&["/h/.mem0/mem0-rs.db"])).unwrap(),
            PathBuf::from("/h/.mem0/mem0-rs.db")
        );
        assert_eq!(
            chemin_base(&lire, &present(&["/h/.mem0/mem0-rs.db", "/h/.memory/mem0-rs.db"])).unwrap(),
            PathBuf::from("/h/.memory/mem0-rs.db")
        );
        assert_eq!(
            chemin_base(&lire, &present(&["/h/.mem0/mem0-rs.db", "/h/.memory/memory-rs.db"])).unwrap(),
            PathBuf::from("/h/.memory/memory-rs.db")
        );
        let lire = env(&[("HOME", "/h"), ("MEMORY_DB_PATH", "/d/memory-rs.db")]);
        assert_eq!(
            chemin_base(&lire, &present(&["/h/.mem0/mem0-rs.db"])).unwrap(),
            PathBuf::from("/d/memory-rs.db")
        );
        assert_eq!(chemin_base(&lire, &present(&["/d/mem0-rs.db"])).unwrap(), PathBuf::from("/d/mem0-rs.db"));
    }
}
