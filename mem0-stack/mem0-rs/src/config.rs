//! Ligne de commande et variables d'environnement (S-1).

use std::ffi::OsString;
use std::path::PathBuf;

pub const USAGE: &str = "usage : mem0-rs [--host <adresse>] [--port <port>]";

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
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("base_url", &self.base_url)
            .field("embed_model", &self.embed_model)
            .field("llm_model", &self.llm_model)
            .field("embedding_dims", &self.embedding_dims)
            .field("db_path", &self.db_path)
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

/// `_env` de memory_config.py : absente ou blanche → défaut ; sinon trimée.
fn env_ou(lire: &impl Fn(&str) -> Option<String>, nom: &str, defaut: &str) -> String {
    match lire(nom) {
        Some(v) if !strip_python(&v).is_empty() => strip_python(&v).to_owned(),
        _ => defaut.to_owned(),
    }
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
    Ok(Config {
        base_url: env_ou(&lire, "OMLX_BASE_URL", "http://host.containers.internal:8000/v1"),
        embed_model: env_ou(&lire, "OMLX_EMBED_MODEL", "bge-m3"),
        api_token: env_ou(&lire, "OMLX_API_TOKEN", "not-needed"),
        llm_model: env_ou(&lire, "OMLX_LLM_MODEL", "qwen3-8b"),
        embedding_dims,
        db_path,
        http_token: lire("MEM0_HTTP_TOKEN").unwrap_or_default(),
        installation_token: lire("OMP_INSTALLATION_TOKEN").unwrap_or_default(),
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
    fn strip_comme_python() {
        assert_eq!(strip_python("\u{1c} a b\u{a0}\u{3000}"), "a b");
    }
}
