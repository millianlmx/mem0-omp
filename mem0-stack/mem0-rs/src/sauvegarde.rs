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
//!
//! `MEM0_BACKUP_REMOTE_CMD` copie chaque instantané hors de la machine : la commande
//! passe par `sh -c`, le chemin de l'instantané en `$1` (et `MEM0_BACKUP_FILE`) ; le
//! chiffrement est l'affaire de l'outil (restic, rclone crypt). Le dernier instantané
//! réussi et la dernière erreur (locale ou distante) se lisent dans [`Suivi`] :
//! `GET /health` et `GET /metrics` les montrent, le journal les note (`backup_failed`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use rusqlite::Connection;

use crate::journal;

/// La copie distante d'un instantané : la commande (`sh -c`) et son délai.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Distante {
    pub commande: String,
    pub delai: Duration,
}

/// L'état des sauvegardes depuis le démarrage.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EtatSauvegarde {
    /// Le dernier instantané local réussi (au démarrage : le plus récent du dossier).
    pub derniere: Option<SystemTime>,
    /// La raison du dernier échec, local ou distant ; effacée par une sauvegarde complète réussie.
    pub erreur: Option<String>,
    /// Les échecs depuis le démarrage.
    pub echecs: u64,
}

/// Le suivi des sauvegardes, partagé entre la boucle et les routes.
#[derive(Debug, Default)]
pub struct Suivi(Mutex<EtatSauvegarde>);

impl Suivi {
    /// Le suivi d'une base au démarrage : le plus récent instantané du dossier, s'il y en a un.
    pub fn depuis_disque(base: &Path) -> Suivi {
        let derniere = instantanes(base).last().and_then(|p| std::fs::metadata(p).ok()?.modified().ok());
        Suivi(Mutex::new(EtatSauvegarde { derniere, ..EtatSauvegarde::default() }))
    }

    pub fn etat(&self) -> EtatSauvegarde {
        self.0.lock().map(|e| e.clone()).unwrap_or_default()
    }

    /// Un instantané local réussi ; `erreur` : l'échec de sa copie distante.
    pub fn noter(&self, instant: SystemTime, erreur: Option<String>) {
        if let Ok(mut e) = self.0.lock() {
            e.derniere = Some(instant);
            e.echecs += u64::from(erreur.is_some());
            e.erreur = erreur;
        }
    }

    /// Un instantané local impossible.
    pub fn echec(&self, erreur: String) {
        if let Ok(mut e) = self.0.lock() {
            e.echecs += 1;
            e.erreur = Some(erreur);
        }
    }
}

/// Lance la copie distante de `chemin` : `sh -c <commande> mem0-backup <chemin>`.
pub async fn copier_ailleurs(distante: &Distante, chemin: &Path) -> Result<(), String> {
    let mut commande = tokio::process::Command::new("sh");
    commande
        .arg("-c")
        .arg(&distante.commande)
        .arg("mem0-backup")
        .arg(chemin)
        .env("MEM0_BACKUP_FILE", chemin)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let enfant = commande.spawn().map_err(|e| format!("copie distante impossible à lancer : {e}"))?;
    match tokio::time::timeout(distante.delai, enfant.wait_with_output()).await {
        Err(_) => Err(format!("copie distante : délai de {} s dépassé", distante.delai.as_secs())),
        Ok(Err(e)) => Err(format!("copie distante : {e}")),
        Ok(Ok(sortie)) if sortie.status.success() => Ok(()),
        Ok(Ok(sortie)) => {
            let texte = String::from_utf8_lossy(if sortie.stderr.is_empty() { &sortie.stdout } else { &sortie.stderr });
            let fin: String = texte.trim().chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
            Err(format!("copie distante : {} — {fin}", sortie.status))
        }
    }
}

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
            journal::alerte(&format!("instantané {} non supprimé : {e}", ancien.display()));
        }
    }
    Ok(cible)
}

/// Un instantané tout de suite, puis sa copie distante ; le résultat est noté dans `suivi`.
pub async fn sauvegarder(
    db: Arc<Mutex<Connection>>,
    base: PathBuf,
    garder: usize,
    distante: Option<&Distante>,
    suivi: &Suivi,
) -> Result<PathBuf, String> {
    let resultat = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|_| "verrou de la base empoisonné".to_owned())?;
        prendre(&conn, &base, garder)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    let chemin = match resultat {
        Ok(chemin) => chemin,
        Err(e) => {
            let e = format!("instantané impossible : {e}");
            journal::ecrire(journal::Niveau::Erreur, &e, Some("backup_failed"), None);
            suivi.echec(e.clone());
            return Err(e);
        }
    };
    journal::info(&format!("instantané {}", chemin.display()));
    let erreur = match distante {
        None => None,
        Some(d) => copier_ailleurs(d, &chemin).await.err(),
    };
    if let Some(e) = &erreur {
        journal::ecrire(journal::Niveau::Erreur, e, Some("backup_failed"), None);
    }
    suivi.noter(SystemTime::now(), erreur.clone());
    erreur.map_or(Ok(chemin), Err)
}

/// Boucle des instantanés, lancée par `main` quand l'intervalle n'est pas nul.
pub async fn boucle(
    db: Arc<Mutex<Connection>>,
    base: PathBuf,
    politique: Politique,
    distante: Option<Distante>,
    suivi: Arc<Suivi>,
) {
    let periode = politique.intervalle.min(CONTROLE_MAX);
    loop {
        tokio::time::sleep(periode).await;
        let plus_recent = instantanes(&base).last().and_then(|p| std::fs::metadata(p).ok()?.modified().ok());
        if !du(SystemTime::now(), plus_recent, politique.intervalle) {
            continue;
        }
        let _ = sauvegarder(Arc::clone(&db), base.clone(), politique.garder, distante.as_ref(), &suivi).await;
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

    /// La copie distante reçoit le chemin de l'instantané en `$1` ; son échec est noté
    /// dans le suivi (l'instantané local, lui, compte), puis effacé par une sauvegarde réussie.
    #[tokio::test]
    async fn copie_distante_et_suivi() {
        let d = Dossier::nouveau("distante");
        let base = d.0.join("mem0-rs.db");
        let db = Arc::new(Mutex::new(crate::db::ouvrir(&base, 4).unwrap()));
        let ailleurs = d.0.join("ailleurs");
        std::fs::create_dir_all(&ailleurs).unwrap();
        let suivi = Suivi::depuis_disque(&base);
        assert_eq!(suivi.etat(), EtatSauvegarde::default(), "aucun instantané sur le disque");

        let copie = Distante {
            commande: format!("cp \"$1\" '{}'/ && test \"$MEM0_BACKUP_FILE\" = \"$1\"", ailleurs.display()),
            delai: Duration::from_secs(30),
        };
        let chemin = sauvegarder(Arc::clone(&db), base.clone(), 3, Some(&copie), &suivi).await.unwrap();
        assert!(ailleurs.join(chemin.file_name().unwrap()).exists(), "copié sous son nom");
        let etat = suivi.etat();
        assert!(etat.derniere.is_some());
        assert_eq!((etat.erreur, etat.echecs), (None, 0));

        let refus = Distante { commande: "echo 'quota dépassé' >&2; exit 4".into(), delai: Duration::from_secs(30) };
        let erreur = sauvegarder(Arc::clone(&db), base.clone(), 3, Some(&refus), &suivi).await.unwrap_err();
        assert!(erreur.contains("quota dépassé"), "{erreur}");
        assert_eq!(suivi.etat().erreur.as_deref(), Some(erreur.as_str()));
        assert_eq!(suivi.etat().echecs, 1);

        let lente = Distante { commande: "sleep 5".into(), delai: Duration::from_millis(200) };
        let erreur = sauvegarder(Arc::clone(&db), base.clone(), 3, Some(&lente), &suivi).await.unwrap_err();
        assert!(erreur.contains("délai"), "{erreur}");

        sauvegarder(Arc::clone(&db), base.clone(), 3, None, &suivi).await.unwrap();
        assert_eq!(suivi.etat().erreur, None, "une sauvegarde réussie efface l'erreur");
        assert_eq!(suivi.etat().echecs, 2);
        assert!(Suivi::depuis_disque(&base).etat().derniere.is_some(), "relu sur le disque au redémarrage");
    }
}
