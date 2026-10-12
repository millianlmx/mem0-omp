//! Verrou d'exclusivité de la base (S-10, D-3) : `flock` consultatif sur le
//! fichier dédié `<base>.lock`, jamais sur la base elle-même (SQLite y pose ses
//! verrous `fcntl`). Le verrou tombe à la fermeture du fichier, donc aussi à la
//! mort du processus : il n'est jamais périmé, et le fichier n'est jamais supprimé.

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

/// Échec de [`prendre`].
#[derive(Debug)]
pub enum ErreurVerrou {
    /// Le verrou est tenu par un autre processus (ou une autre ouverture du fichier).
    Tenu,
    Io(io::Error),
}

/// `<base>.lock`.
pub fn chemin(base: &Path) -> PathBuf {
    let mut nom = base.as_os_str().to_owned();
    nom.push(".lock");
    PathBuf::from(nom)
}

/// Prend le verrou exclusif de `base` (crée le dossier parent et `<base>.lock`
/// si besoin) ; il dure tant que le `File` rendu reste ouvert.
pub fn prendre(base: &Path) -> Result<File, ErreurVerrou> {
    if let Some(parent) = base.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(ErreurVerrou::Io)?;
    }
    let fichier = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(chemin(base))
        .map_err(ErreurVerrou::Io)?;
    match fichier.try_lock() {
        Ok(()) => Ok(fichier),
        Err(TryLockError::WouldBlock) => Err(ErreurVerrou::Tenu),
        Err(TryLockError::Error(e)) => Err(ErreurVerrou::Io(e)),
    }
}

/// Le verrou de `base` est-il tenu ailleurs ? Ne crée rien : sans `<base>.lock`,
/// rend `false` ; sinon tente un verrou partagé et le relâche aussitôt.
pub fn tenu_par_autrui(base: &Path) -> io::Result<bool> {
    let fichier = match File::open(chemin(base)) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    match fichier.try_lock_shared() {
        Ok(()) => fichier.unlock().map(|()| false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dossier temporaire unique, supprimé à la fin du test.
    struct Dossier(PathBuf);

    impl Dossier {
        fn new() -> Self {
            Dossier(std::env::temp_dir().join(format!("mem0-rs-verrou-{}", uuid::Uuid::new_v4())))
        }
    }

    impl Drop for Dossier {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn chemin_ajoute_lock() {
        assert_eq!(chemin(Path::new("/a/b/mem0-rs.db")), PathBuf::from("/a/b/mem0-rs.db.lock"));
    }

    /// AC-11 (mem0-rs-migration, S-10) : `flock` vaut par ouverture du fichier,
    /// donc une seconde prise échoue même dans le même processus ; la fermeture
    /// du premier `File` libère le verrou.
    #[test]
    fn ac11_seconde_prise_refusee_puis_liberee() {
        let d = Dossier::new();
        let base = d.0.join("sous/dossier/mem0-rs.db");
        let premier = prendre(&base).unwrap();
        assert!(chemin(&base).is_file(), "le parent et le .lock sont créés");
        assert!(!base.exists(), "la base elle-même n'est pas touchée");
        assert!(matches!(prendre(&base), Err(ErreurVerrou::Tenu)));
        assert!(tenu_par_autrui(&base).unwrap());
        drop(premier);
        assert!(!tenu_par_autrui(&base).unwrap());
        let _second = prendre(&base).unwrap();
        assert!(chemin(&base).is_file(), "le .lock n'est jamais supprimé");
    }

    /// AC-11 (mem0-rs-migration, S-10) : le contrôle de l'import ne crée rien.
    #[test]
    fn ac11_controle_sans_lock_ne_cree_rien() {
        let d = Dossier::new();
        std::fs::create_dir_all(&d.0).unwrap();
        let base = d.0.join("mem0-rs.db");
        assert!(!tenu_par_autrui(&base).unwrap());
        assert_eq!(std::fs::read_dir(&d.0).unwrap().count(), 0);
        // Dossier parent absent : rien non plus.
        let absente = d.0.join("absent/mem0-rs.db");
        assert!(!tenu_par_autrui(&absente).unwrap());
        assert_eq!(std::fs::read_dir(&d.0).unwrap().count(), 0);
    }

    /// Un `.lock` présent mais libre (serveur arrêté) n'est pas un verrou tenu,
    /// et le contrôle ne le garde pas.
    #[test]
    fn controle_sur_lock_libre() {
        let d = Dossier::new();
        let base = d.0.join("mem0-rs.db");
        drop(prendre(&base).unwrap());
        assert!(!tenu_par_autrui(&base).unwrap());
        let _f = prendre(&base).unwrap();
    }
}
