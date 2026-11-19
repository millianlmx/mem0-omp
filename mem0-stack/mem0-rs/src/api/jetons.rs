//! Les jetons de l'API (`X-Mem0-Token`).
//!
//! - `MEM0_HTTP_TOKEN` : le jeton TOTAL historique, toutes portées, toutes routes ;
//! - `MEM0_HTTP_TOKENS` (`nom:jeton:scope1,scope2;nom2:jeton2:scope3`) et
//!   `MEM0_HTTP_TOKENS_FILE` (le même format, une entrée par ligne, `#` en tête de ligne
//!   pour un commentaire) : des jetons LIMITÉS à leurs portées (`agent_id`).
//!
//! Aucun jeton déclaré : aucun contrôle (comme avant). Un jeton limité n'ouvre que les
//! requêtes qui nomment une de ses portées, ou qui visent un souvenir de l'une d'elles ;
//! tout ce qui traverse les portées (sans `agent_id`, le graphe, le rêve de toutes les
//! portées) lui est refusé en 403.

use std::collections::HashSet;

use crate::config::{blanc_python, strip_python};

/// Un jeton limité : son nom (dans les refus et les journaux, jamais le secret) et ses portées.
#[derive(Clone)]
struct Limite {
    nom: String,
    secret: String,
    portees: Vec<String>,
}

/// Les jetons acceptés par le serveur.
#[derive(Clone, Default)]
pub struct Jetons {
    total: String,
    limites: Vec<Limite>,
}

/// Ce qu'ouvre le jeton d'une requête.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Acces<'a> {
    /// Le jeton total (ou aucun contrôle) : tout.
    Total,
    /// Un jeton limité : ses seules portées.
    Limite { nom: &'a str, portees: &'a [String] },
}

impl Acces<'_> {
    /// La portée `portee` (un `agent_id` contrôlé ; `None` : toutes les portées) est-elle ouverte ?
    pub fn permet(&self, portee: Option<&str>) -> bool {
        match self {
            Acces::Total => true,
            Acces::Limite { portees, .. } => portee.is_some_and(|p| portees.iter().any(|q| q == p)),
        }
    }

    /// Le corps du refus (403) d'une portée hors du jeton.
    pub fn refus(&self, portee: Option<&str>) -> String {
        match (self, portee) {
            (Acces::Limite { nom, .. }, Some(p)) => format!("jeton « {nom} » : la portée « {p} » est hors de ses scopes"),
            (Acces::Limite { nom, .. }, None) => {
                format!("jeton « {nom} » : requête hors portée (toutes portées, ou souvenir d'une autre portée)")
            }
            (Acces::Total, _) => String::new(),
        }
    }
}

/// Égalité d'octets dont la durée ne dépend pas de la position du premier écart :
/// `==` s'arrête au premier octet différent, ce qui laisse deviner le jeton octet
/// par octet en mesurant les réponses. Seule la longueur se lit au chronomètre.
fn egal_temps_constant(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let ecart = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(ecart) == 0
}

fn nom_valide(nom: &str) -> bool {
    (1..=64).contains(&nom.len()) && nom.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn secret_valide(secret: &str) -> bool {
    (16..=512).contains(&secret.len()) && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b"._~+/=-".contains(&b))
}

impl Jetons {
    /// Les jetons de la configuration. `liste` : la valeur de `MEM0_HTTP_TOKENS` ;
    /// `fichier` : le contenu de `MEM0_HTTP_TOKENS_FILE` et son chemin (pour les erreurs).
    /// `Err(message)` au premier défaut : nom ou secret illisible, doublon, portée vide.
    pub fn lire(total: String, liste: Option<&str>, fichier: Option<(&str, &str)>) -> Result<Jetons, String> {
        let mut entrees: Vec<(String, &str)> = Vec::new();
        if let Some(liste) = liste {
            for brut in liste.split(';').map(strip_python).filter(|e| !e.is_empty()) {
                entrees.push(("MEM0_HTTP_TOKENS".to_owned(), brut));
            }
        }
        if let Some((chemin, contenu)) = fichier {
            for (n, brut) in contenu.lines().enumerate() {
                let brut = strip_python(brut);
                if !brut.is_empty() && !brut.starts_with('#') {
                    entrees.push((format!("{chemin}:{}", n + 1), brut));
                }
            }
        }
        let mut limites = Vec::with_capacity(entrees.len());
        let mut noms = HashSet::new();
        let mut secrets = HashSet::new();
        for (ou, brut) in entrees {
            let mut champs = brut.splitn(3, ':');
            let (Some(nom), Some(secret), Some(portees)) = (champs.next(), champs.next(), champs.next()) else {
                return Err(format!("{ou} : « nom:jeton:scope1,scope2 » attendu"));
            };
            if !nom_valide(nom) {
                return Err(format!("{ou} : nom de jeton invalide (lettres, chiffres, . _ -, 64 au plus)"));
            }
            if !secret_valide(secret) {
                return Err(format!(
                    "{ou} : le jeton « {nom} » doit compter 16 à 512 caractères parmi A-Z a-z 0-9 . _ ~ + / = -"
                ));
            }
            let portees: Vec<String> = portees.split(',').map(|p| strip_python(p).to_owned()).collect();
            if portees.iter().any(|p| p.is_empty() || p.chars().any(blanc_python)) {
                return Err(format!("{ou} : le jeton « {nom} » a une portée vide ou qui contient un blanc"));
            }
            if !noms.insert(nom.to_owned()) {
                return Err(format!("{ou} : jeton « {nom} » déclaré deux fois"));
            }
            if secret == total || !secrets.insert(secret.to_owned()) {
                return Err(format!("{ou} : le secret du jeton « {nom} » est déjà celui d'un autre jeton"));
            }
            limites.push(Limite { nom: nom.to_owned(), secret: secret.to_owned(), portees });
        }
        Ok(Jetons { total, limites })
    }

    /// Un jeton est-il exigé ?
    pub fn exige(&self) -> bool {
        !self.total.is_empty() || !self.limites.is_empty()
    }

    /// Le nombre de jetons limités (pour le journal de démarrage).
    pub fn limites(&self) -> usize {
        self.limites.len()
    }

    /// Ce qu'ouvre le jeton présenté, ou `None` (401). Chaque jeton déclaré est comparé
    /// en entier, sans s'arrêter au premier qui correspond.
    pub fn identifier(&self, presente: Option<&[u8]>) -> Option<Acces<'_>> {
        if !self.exige() {
            return Some(Acces::Total);
        }
        let presente = presente?;
        let mut trouve = None;
        if !self.total.is_empty() && egal_temps_constant(presente, self.total.as_bytes()) {
            trouve = Some(Acces::Total);
        }
        for l in &self.limites {
            if egal_temps_constant(presente, l.secret.as_bytes()) && trouve.is_none() {
                trouve = Some(Acces::Limite { nom: &l.nom, portees: &l.portees });
            }
        }
        trouve
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbb";

    #[test]
    fn sans_jeton_tout_est_ouvert() {
        let j = Jetons::lire(String::new(), None, None).unwrap();
        assert!(!j.exige());
        assert_eq!(j.identifier(None), Some(Acces::Total));
    }

    #[test]
    fn jeton_compare_en_temps_constant() {
        assert!(egal_temps_constant(b"", b""));
        assert!(egal_temps_constant(b"s3cret", b"s3cret"));
        assert!(!egal_temps_constant(b"s3cret", b"s3creT"));
        assert!(!egal_temps_constant(b"Xs3cret", b"s3cret"));
        assert!(!egal_temps_constant(b"s3cre", b"s3cret"));
        assert!(!egal_temps_constant(b"", b"s"));
    }

    #[test]
    fn jeton_total_et_jetons_limites() {
        let liste = format!("corpo:{A}:corpo-api, corpo-web ; perso:{B}:perso");
        let j = Jetons::lire("total-total-total".into(), Some(&liste), None).unwrap();
        assert_eq!(j.identifier(Some(b"total-total-total")), Some(Acces::Total));
        let corpo = j.identifier(Some(A.as_bytes())).unwrap();
        assert!(corpo.permet(Some("corpo-api")) && corpo.permet(Some("corpo-web")));
        assert!(!corpo.permet(Some("perso")) && !corpo.permet(None));
        assert!(j.identifier(Some(b"inconnu-inconnu!")).is_none());
        assert!(j.identifier(None).is_none());
    }

    #[test]
    fn fichier_avec_commentaires() {
        let contenu = format!("# les jetons\n\ncorpo:{A}:corpo\n");
        let j = Jetons::lire(String::new(), None, Some(("/etc/t", &contenu))).unwrap();
        assert!(j.exige(), "un jeton limité seul exige un jeton");
        assert!(j.identifier(Some(A.as_bytes())).unwrap().permet(Some("corpo")));
    }

    #[test]
    fn defauts_refuses() {
        for (liste, attendu) in [
            ("corpo:court:x".to_owned(), "16 à 512"),
            (format!("corpo:{A}"), "attendu"),
            (format!("co rpo:{A}:x"), "nom de jeton"),
            (format!("corpo:{A}:x,"), "portée vide"),
            (format!("corpo:{A}:x;corpo:{B}:y"), "deux fois"),
            (format!("a:{A}:x;b:{A}:y"), "déjà celui"),
            (format!("a:{A}:x"), "déjà celui"),
        ] {
            let total = if attendu == "déjà celui" && !liste.contains(';') { A.to_owned() } else { String::new() };
            let err = Jetons::lire(total, Some(&liste), None).err().unwrap_or_default();
            assert!(err.contains(attendu), "{liste} : {err}");
        }
    }
}
