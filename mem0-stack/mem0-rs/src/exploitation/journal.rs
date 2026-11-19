//! Journal structuré du service (contrat C1 de mem0-omp, comme le harness) : une
//! ligne JSON par événement, sur stderr et dans `<MEM0_LOG_DIR>/mem0-AAAA-MM-JJ.jsonl`
//! (jour UTC), les fichiers plus vieux que `MEM0_LOG_RETENTION_DAYS` retirés au
//! changement de jour.
//!
//! `{"ts":"<RFC 3339>","level":"info","src":"mem0","msg":"…","event"?:"…","err"?:{"message":"…"}}`
//!
//! Avant [`initialiser`] (lecture de la configuration), les lignes ne vont que sur stderr.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// Niveau d'une ligne.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Niveau {
    Info,
    Alerte,
    Erreur,
}

impl Niveau {
    fn nom(self) -> &'static str {
        match self {
            Niveau::Info => "info",
            Niveau::Alerte => "warn",
            Niveau::Erreur => "error",
        }
    }
}

/// Les fichiers du journal : leur dossier, leur rétention et le jour du dernier écrit.
struct Fichiers {
    dossier: PathBuf,
    retention_jours: u64,
    jour: Mutex<Option<String>>,
}

static FICHIERS: OnceLock<Fichiers> = OnceLock::new();

/// Le dossier par défaut : `logs/` à côté de la base.
pub fn dossier_par_defaut(base: &Path) -> PathBuf {
    base.parent().unwrap_or_else(|| Path::new(".")).join("logs")
}

/// Pose les fichiers du journal (une fois ; un second appel est ignoré).
pub fn initialiser(dossier: PathBuf, retention_jours: u64) {
    let _ = FICHIERS.set(Fichiers { dossier, retention_jours, jour: Mutex::new(None) });
}

/// La ligne JSON d'un événement, à l'instant `instant`.
pub fn ligne(instant: OffsetDateTime, niveau: Niveau, msg: &str, evenement: Option<&str>, erreur: Option<&str>) -> String {
    let mut objet = Map::new();
    objet.insert("ts".into(), json!(instant.format(&Rfc3339).unwrap_or_default()));
    objet.insert("level".into(), json!(niveau.nom()));
    objet.insert("src".into(), json!("mem0"));
    objet.insert("msg".into(), json!(msg));
    if let Some(e) = evenement {
        objet.insert("event".into(), json!(e));
    }
    if let Some(e) = erreur {
        objet.insert("err".into(), json!({ "message": e }));
    }
    Value::Object(objet).to_string()
}

/// Écrit un événement : stderr toujours, le fichier du jour une fois initialisé.
pub fn ecrire(niveau: Niveau, msg: &str, evenement: Option<&str>, erreur: Option<&str>) {
    let maintenant = OffsetDateTime::now_utc();
    let texte = ligne(maintenant, niveau, msg, evenement, erreur);
    eprintln!("{texte}");
    let Some(fichiers) = FICHIERS.get() else {
        return;
    };
    let jour = format!("{:04}-{:02}-{:02}", maintenant.year(), u8::from(maintenant.month()), maintenant.day());
    let Ok(mut dernier) = fichiers.jour.lock() else {
        return;
    };
    if dernier.as_deref() != Some(jour.as_str()) {
        if std::fs::create_dir_all(&fichiers.dossier).is_err() {
            return;
        }
        elaguer(&fichiers.dossier, fichiers.retention_jours, maintenant);
        *dernier = Some(jour.clone());
    }
    let chemin = fichiers.dossier.join(format!("mem0-{jour}.jsonl"));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(chemin) {
        let _ = writeln!(f, "{texte}");
    }
}

/// Retire les `mem0-AAAA-MM-JJ.jsonl` plus vieux que `retention_jours` ; rend leurs noms.
pub fn elaguer(dossier: &Path, retention_jours: u64, maintenant: OffsetDateTime) -> Vec<String> {
    let limite = maintenant - time::Duration::days(i64::try_from(retention_jours).unwrap_or(i64::MAX / 86_400));
    let plus_vieux =
        format!("{:04}-{:02}-{:02}", limite.year(), u8::from(limite.month()), limite.day());
    let Ok(entrees) = std::fs::read_dir(dossier) else {
        return Vec::new();
    };
    let mut retires = Vec::new();
    for nom in entrees.filter_map(|e| e.ok()?.file_name().into_string().ok()) {
        let Some(jour) = nom.strip_prefix("mem0-").and_then(|r| r.strip_suffix(".jsonl")) else {
            continue;
        };
        let forme = jour.len() == 10 && jour.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
        if forme && jour < plus_vieux.as_str() && std::fs::remove_file(dossier.join(&nom)).is_ok() {
            retires.push(nom);
        }
    }
    retires
}

pub fn info(msg: &str) {
    ecrire(Niveau::Info, msg, None, None);
}

pub fn alerte(msg: &str) {
    ecrire(Niveau::Alerte, msg, None, None);
}

pub fn erreur(msg: &str) {
    ecrire(Niveau::Erreur, msg, None, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instant(annee: i32, mois: time::Month, jour: u8, h: u8, mi: u8) -> OffsetDateTime {
        time::PrimitiveDateTime::new(
            time::Date::from_calendar_date(annee, mois, jour).unwrap(),
            time::Time::from_hms(h, mi, 0).unwrap(),
        )
        .assume_utc()
    }

    #[test]
    fn ligne_c1() {
        let t = instant(2026, time::Month::November, 7, 8, 30);
        let l: Value = serde_json::from_str(&ligne(t, Niveau::Erreur, "instantané impossible", Some("backup_failed"), Some("disque plein"))).unwrap();
        assert_eq!(
            l,
            json!({"ts":"2026-11-07T08:30:00Z","level":"error","src":"mem0","msg":"instantané impossible","event":"backup_failed","err":{"message":"disque plein"}})
        );
        let simple: Value = serde_json::from_str(&ligne(t, Niveau::Info, "à l'écoute", None, None)).unwrap();
        assert_eq!(simple.as_object().unwrap().keys().collect::<Vec<_>>(), ["ts", "level", "src", "msg"]);
    }

    #[test]
    fn elagage_selon_la_retention() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("mem0-rs-journal-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        for nom in ["mem0-2026-10-01.jsonl", "mem0-2026-11-01.jsonl", "harness-2026-10-01.jsonl", "notes.txt"] {
            std::fs::write(d.join(nom), "{}\n").unwrap();
        }
        let retires = elaguer(&d, 14, instant(2026, time::Month::November, 7, 0, 0));
        assert_eq!(retires, ["mem0-2026-10-01.jsonl"]);
        assert!(d.join("mem0-2026-11-01.jsonl").exists());
        assert!(d.join("harness-2026-10-01.jsonl").exists(), "une autre source n'est pas touchée");
        let _ = std::fs::remove_dir_all(&d);
    }
}
