//! Instantanés périodiques de la base : `VACUUM INTO` dans `backups/`, à côté de
//! `MEM0_DB_PATH`, en gardant les `MEM0_BACKUP_KEEP` plus récents.
//!
//! La base est un seul fichier : une écriture ratée, un `rm` ou un disque qui
//! lâche emportaient toute la mémoire, sans retour possible. `VACUUM INTO` écrit
//! une copie cohérente et compacte, lisible par `mem0-rs` tel quel (les tables
//! virtuelles `vec0` et FTS5 sont recopiées avec leurs tables d'ombre).
//!
//! Le rythme survit aux redémarrages : le serveur vérifie toutes les
//! `min(intervalle, 1 h)` si l'instantané le plus récent du dossier a plus d'un
//! intervalle, et n'en prend un que dans ce cas. Le premier contrôle a lieu une
//! période après le démarrage, jamais au démarrage lui-même.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use rusqlite::Connection;

/// Période maximale entre deux contrôles.
const CONTROLE_MAX: Duration = Duration::from_secs(3600);

/// Réglage lu dans l'environnement (config.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Politique {
    /// Écart visé entre deux instantanés ; zéro = instantanés coupés.
    pub intervalle: Duration,
    /// Nombre d'instantanés gardés (au moins 1).
    pub garder: usize,
}

/// Le dossier des instantanés : `backups/` à côté de la base.
pub fn dossier(base: &Path) -> PathBuf {
    base.parent().unwrap_or_else(|| Path::new(".")).join("backups")
}

/// Préfixe des instantanés d'une base : `<nom sans extension>-`.
fn prefixe(base: &Path) -> String {
    format!("{}-", base.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "mem0-rs".into()))
}

/// `<prefixe>AAAAMMJJTHHMMSSZ.db`, horodatage UTC : l'ordre des noms est l'ordre
/// chronologique.
fn nom(base: &Path, instant: time::OffsetDateTime) -> String {
    format!(
        "{}{:04}{:02}{:02}T{:02}{:02}{:02}Z.db",
        prefixe(base),
        instant.year(),
        u8::from(instant.month()),
        instant.day(),
        instant.hour(),
        instant.minute(),
        instant.second()
    )
}

/// Un nom produit par [`nom`] pour cette base.
fn est_instantane(base: &Path, nom: &str) -> bool {
    let Some(horodatage) = nom.strip_prefix(&prefixe(base)).and_then(|r| r.strip_suffix(".db")) else {
        return false;
    };
    let o = horodatage.as_bytes();
    o.len() == 16
        && o[8] == b'T'
        && o[15] == b'Z'
        && o[..8].iter().chain(&o[9..15]).all(u8::is_ascii_digit)
}

/// Les instantanés de la base, du plus ancien au plus récent.
pub fn instantanes(base: &Path) -> Vec<PathBuf> {
    let Ok(entrees) = std::fs::read_dir(dossier(base)) else {
        return Vec::new();
    };
    let mut noms: Vec<String> = entrees
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| est_instantane(base, n))
        .collect();
    noms.sort();
    noms.into_iter().map(|n| dossier(base).join(n)).collect()
}

/// Un instantané est-il dû ? Oui sans instantané, ou quand le plus récent a au
/// moins `intervalle` (ou une date dans le futur : horloge reculée).
pub fn du(maintenant: SystemTime, plus_recent: Option<SystemTime>, intervalle: Duration) -> bool {
    match plus_recent {
        None => true,
        Some(t) => maintenant.duration_since(t).map_or(true, |age| age >= intervalle),
    }
}

/// Écrit un instantané de `conn` (la base `base`), puis ne garde que les `garder`
/// plus récents. Écrit d'abord un `.tmp`, renommé une fois complet : un instantané
/// interrompu n'est jamais compté.
pub fn prendre(conn: &Connection, base: &Path, garder: usize) -> Result<PathBuf, String> {
    let dossier = dossier(base);
    std::fs::create_dir_all(&dossier).map_err(|e| format!("{} : {e}", dossier.display()))?;
    let cible = dossier.join(nom(base, time::OffsetDateTime::now_utc()));
    let tmp = cible.with_extension("db.tmp");
    let _ = std::fs::remove_file(&tmp);
    let chemin = tmp.to_str().ok_or_else(|| format!("{} : chemin non UTF-8", tmp.display()))?;
    conn.execute("VACUUM INTO ?1", [chemin]).map_err(|e| format!("VACUUM INTO {chemin} : {e}"))?;
    std::fs::rename(&tmp, &cible).map_err(|e| format!("{} : {e}", cible.display()))?;
    let tous = instantanes(base);
    for ancien in &tous[..tous.len().saturating_sub(garder.max(1))] {
        if let Err(e) = std::fs::remove_file(ancien) {
            eprintln!("mem0-rs : instantané {} non supprimé : {e}", ancien.display());
        }
    }
    Ok(cible)
}

/// Boucle des instantanés, lancée par `main` quand l'intervalle n'est pas nul.
pub async fn boucle(db: Arc<Mutex<Connection>>, base: PathBuf, politique: Politique) {
    let periode = politique.intervalle.min(CONTROLE_MAX);
    loop {
        tokio::time::sleep(periode).await;
        let plus_recent = instantanes(&base).last().and_then(|p| std::fs::metadata(p).ok()?.modified().ok());
        if !du(SystemTime::now(), plus_recent, politique.intervalle) {
            continue;
        }
        let (db, base) = (Arc::clone(&db), base.clone());
        let resultat = tokio::task::spawn_blocking(move || {
            let conn = db.lock().map_err(|_| "verrou de la base empoisonné".to_owned())?;
            prendre(&conn, &base, politique.garder)
        })
        .await;
        match resultat {
            Ok(Ok(chemin)) => eprintln!("mem0-rs : instantané {}", chemin.display()),
            Ok(Err(e)) => eprintln!("mem0-rs : instantané impossible : {e}"),
            Err(e) => eprintln!("mem0-rs : instantané impossible : {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dossier(PathBuf);

    impl Dossier {
        fn nouveau(nom: &str) -> Dossier {
            let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
            let d = std::env::temp_dir().join(format!("mem0-rs-sauvegarde-{nom}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&d).unwrap();
            Dossier(d)
        }
    }

    impl Drop for Dossier {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn noms_et_dossier() {
        let base = Path::new("/d/mem0-rs.db");
        assert_eq!(dossier(base), Path::new("/d/backups"));
        let t = time::PrimitiveDateTime::new(
            time::Date::from_calendar_date(2026, time::Month::October, 24).unwrap(),
            time::Time::from_hms(7, 5, 9).unwrap(),
        )
        .assume_utc();
        assert_eq!(nom(base, t), "mem0-rs-20261024T070509Z.db");
        assert!(est_instantane(base, "mem0-rs-20261024T070509Z.db"));
        for autre in ["mem0-rs-20261024T070509Z.db.tmp", "autre-20261024T070509Z.db", "mem0-rs-2026.db", "notes.txt"] {
            assert!(!est_instantane(base, autre), "{autre}");
        }
    }

    #[test]
    fn du_selon_l_age_du_plus_recent() {
        let h = Duration::from_secs(3600);
        let maintenant = SystemTime::UNIX_EPOCH + 100 * h;
        assert!(du(maintenant, None, 24 * h));
        assert!(!du(maintenant, Some(maintenant - 23 * h), 24 * h));
        assert!(du(maintenant, Some(maintenant - 24 * h), 24 * h));
        assert!(du(maintenant, Some(maintenant + h), 24 * h), "horloge reculée : dû");
    }

    /// Un instantané se rouvre comme une base mem0-rs, souvenirs et recherche
    /// vectorielle compris ; au-delà de `garder`, les plus anciens partent, et rien
    /// d'autre du dossier n'est touché.
    #[test]
    fn instantane_rouvrable_et_rotation() {
        let d = Dossier::nouveau("rotation");
        let base = d.0.join("mem0-rs.db");
        let mut conn = crate::db::ouvrir(&base, 4).unwrap();
        let instant = crate::horodatage::maintenant();
        crate::db::ajouter(
            &mut conn,
            &crate::db::NouveauSouvenir {
                id: "id-1",
                memory: "Le timeout de recherche est de 20 s",
                hash: "h",
                user_id: "moi",
                agent_id: Some("proj"),
                run_id: None,
                role: Some("user"),
                attributed_to: None,
                tags: None,
                instant: &instant,
            },
            &[1.0, 0.0, 0.0, 0.0],
        )
        .unwrap();

        let premier = prendre(&conn, &base, 2).unwrap();
        let copie = crate::db::ouvrir(&premier, 4).unwrap();
        let souvenirs = crate::db::tous(&copie, "moi", Some("proj")).unwrap();
        assert_eq!(souvenirs.len(), 1);
        assert_eq!(souvenirs[0].memory, "Le timeout de recherche est de 20 s");
        let voisins = crate::db::voisins(&copie, "moi", Some("proj"), None, &[1.0, 0.0, 0.0, 0.0], 5).unwrap();
        assert_eq!(voisins.len(), 1, "la table vec0 est recopiée");
        drop(copie);

        // Rotation : trois instantanés aux noms distincts, deux gardés.
        std::fs::write(dossier(&base).join("notes.txt"), "à garder").unwrap();
        for ancien in ["mem0-rs-20200101T000000Z.db", "mem0-rs-20210101T000000Z.db"] {
            std::fs::copy(&premier, dossier(&base).join(ancien)).unwrap();
        }
        let dernier = prendre(&conn, &base, 2).unwrap();
        let restants = instantanes(&base);
        assert_eq!(restants.len(), 2, "{restants:?}");
        assert_eq!(restants.last(), Some(&dernier));
        assert!(!dossier(&base).join("mem0-rs-20200101T000000Z.db").exists());
        assert!(dossier(&base).join("notes.txt").exists(), "un fichier étranger n'est pas touché");
    }
}
