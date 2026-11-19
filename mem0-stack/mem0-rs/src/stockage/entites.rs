//! Entités lexicales d'un souvenir (memoire-liee) : ce qu'un souvenir de
//! développement nomme sans ambiguïté — fichiers, routes, identifiants de code,
//! constantes et codes d'erreur, noms propres en milieu de phrase.
//!
//! Extraction déterministe, sans modèle ni bibliothèque NLP : les entités d'un
//! dépôt de code ont une forme typographique (`recall.ts`, `SQLITE_BUSY`,
//! `RunnerSession`, `mem0-rs`, `/memory/search`), que l'embedding dilue dans un
//! long texte et que le BM25 découpe (`mem0-rs` → `mem0`, `rs`). La clé d'une
//! entité est sa forme normalisée : deux souvenirs qui écrivent
//! `src/recherche.rs` et `recherche.rs` partagent l'entité `recherche.rs`.

use std::collections::HashSet;

/// Nature d'une entité, d'après sa forme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Genre {
    /// Nom de fichier (avec une extension connue) ; la clé est le nom de base.
    Fichier,
    /// Route HTTP ou chemin de dossier (`/memory/search`, `omp-harness/`).
    Route,
    /// Identifiant de code : snake_case, camelCase, PascalCase à majuscule interne,
    /// kebab-case, ou texte entre accents graves.
    Identifiant,
    /// Constante, variable d'environnement ou code d'erreur (`MEM0_DB_PATH`, `E0502`).
    Code,
    /// Nom propre : mot capitalisé en milieu de phrase (`Qdrant`, `Tailscale`).
    Nom,
}

impl Genre {
    pub fn nom(self) -> &'static str {
        match self {
            Genre::Fichier => "fichier",
            Genre::Route => "route",
            Genre::Identifiant => "identifiant",
            Genre::Code => "code",
            Genre::Nom => "nom",
        }
    }
}

/// Une entité extraite : sa clé (normalisée, unique dans la base), sa première
/// forme rencontrée et son genre.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entite {
    pub cle: String,
    pub forme: String,
    pub genre: Genre,
}

/// Entités gardées au plus par souvenir : au-delà, un souvenir (une procédure,
/// un long paragraphe) relierait tout à tout.
pub const MAX_PAR_SOUVENIR: usize = 32;

/// Longueur minimale d'une clé.
const LONGUEUR_MIN: usize = 3;
/// Longueur maximale d'une forme : au-delà, c'est un hash ou une donnée, pas un nom.
const LONGUEUR_MAX: usize = 80;

/// Extensions de fichier reconnues.
const EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "mdx", "toml", "yml", "yaml", "swift", "py",
    "sh", "bash", "zsh", "sql", "txt", "lock", "html", "css", "scss", "go", "java", "kt", "kts", "c", "h", "cc", "cpp",
    "hpp", "rb", "php", "cs", "xml", "plist", "env", "conf", "ini", "nix", "dockerfile", "xcodeproj", "proto", "graphql",
    "vue", "svelte", "dart", "lua", "zig", "ex", "exs", "ml", "hs", "scala", "gradle", "service", "slice", "socket",
];

/// Mots capitalisés trop communs pour être des noms propres, même en milieu de
/// phrase (après un deux-points, dans un titre, en anglais).
const NOMS_COMMUNS: &[&str] = &[
    "the", "this", "that", "these", "those", "and", "but", "for", "not", "with", "when", "then", "also", "les", "des",
    "une", "pour", "dans", "avec", "sans", "mais", "donc", "alors", "aussi", "quand", "puis", "est", "sont", "pas",
    "non", "oui", "note", "voir", "todo", "fixme", "cause", "correctif", "symptôme", "raison", "décision", "bug",
    "fix", "feat", "chore", "docs", "test", "tests", "api", "ok",
];

/// Ponctuation retirée aux deux bouts d'un jeton.
fn ponctuation(c: char) -> bool {
    matches!(
        c,
        '.' | ',' | ';' | ':' | '!' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '«' | '»' | '“' | '”' | '‘'
            | '’' | '<' | '>' | '*' | '…'
    ) || c.is_whitespace()
}

/// Fin de phrase : le mot suivant peut être capitalisé sans être un nom propre.
fn fin_de_phrase(jeton: &str) -> bool {
    jeton.ends_with(['.', '!', '?', ':', '…', '—']) || jeton == "-" || jeton == "—" || jeton == "•"
}

/// Caractère d'un identifiant de code.
fn car_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

fn extension_connue(nom: &str) -> bool {
    match nom.rsplit_once('.') {
        Some((base, ext)) => !base.is_empty() && EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// Le genre d'un jeton nettoyé, ou `None` si ce n'est pas une entité.
/// `debut_de_phrase` : le jeton suit une fin de phrase (ou ouvre le texte).
fn genre(jeton: &str, debut_de_phrase: bool) -> Option<Genre> {
    let n = jeton.chars().count();
    if !(LONGUEUR_MIN..=LONGUEUR_MAX).contains(&n) {
        return None;
    }
    if jeton.contains("://") {
        return None;
    }
    let base = jeton.rsplit('/').next().unwrap_or(jeton);
    if extension_connue(base) && base.chars().all(|c| car_ident(c) || c == '.') {
        return Some(Genre::Fichier);
    }
    if jeton.contains('/')
        && jeton.split('/').filter(|p| !p.is_empty()).all(|p| p.chars().all(|c| car_ident(c) || c == '.' || c == '{' || c == '}'))
        && jeton.chars().any(char::is_alphabetic)
        && jeton.split('/').filter(|p| !p.is_empty()).count() >= 2
    {
        return Some(Genre::Route);
    }
    if !jeton.chars().all(car_ident) || !jeton.chars().any(char::is_alphabetic) {
        return None;
    }
    let lettres: Vec<char> = jeton.chars().filter(|c| c.is_alphabetic()).collect();
    let majuscules = lettres.iter().filter(|c| c.is_uppercase()).count();
    let premier = jeton.chars().next()?;
    // Constante ou code d'erreur : tout en majuscules, avec `_` ou un chiffre (E0502, SQLITE_BUSY).
    if majuscules == lettres.len() && (jeton.contains('_') || jeton.chars().any(|c| c.is_ascii_digit())) {
        return Some(Genre::Code);
    }
    if jeton.contains('_') && !jeton.starts_with('_') && !jeton.ends_with('_') {
        return Some(Genre::Identifiant);
    }
    // kebab-case : au moins un tiret interne, et un chiffre ou deux tirets (mem0-rs,
    // omp-mem0-memory, sqlite-vec) ; un mot composé français (peut-être, c'est-à-dire)
    // n'a ni chiffre ni minuscules seules de part et d'autre d'un trait d'union court.
    if jeton.contains('-') && !jeton.starts_with('-') && !jeton.ends_with('-') && !jeton.contains("--") {
        let parties: Vec<&str> = jeton.split('-').collect();
        if jeton.chars().any(|c| c.is_ascii_digit()) || parties.len() >= 3 || parties.iter().all(|p| p.len() >= 3 && p.is_ascii()) {
            return Some(Genre::Identifiant);
        }
        return None;
    }
    // Casse mêlée : camelCase, PascalCase à majuscule interne (RunnerSession,
    // SQLite, mem0Client) ; tout en majuscules sans chiffre (HTTP, SQL) n'en est pas,
    // un mot capitalisé (Qdrant) non plus.
    let minuscules = lettres.len() - majuscules;
    if minuscules > 0 && (majuscules >= 2 || (majuscules == 1 && !premier.is_uppercase())) {
        return Some(Genre::Identifiant);
    }
    // Nom propre : capitalisé, le reste en minuscules, en milieu de phrase.
    if !debut_de_phrase && premier.is_uppercase() && majuscules == 1 && lettres.len() >= 4 {
        let bas = jeton.to_lowercase();
        if !NOMS_COMMUNS.contains(&bas.as_str()) {
            return Some(Genre::Nom);
        }
    }
    None
}

/// La clé d'une entité : minuscules ; nom de base pour un fichier ; sans barre
/// finale pour une route.
fn cle(jeton: &str, genre: Genre) -> String {
    let bas = jeton.to_lowercase();
    match genre {
        Genre::Fichier => bas.rsplit('/').next().unwrap_or(&bas).to_owned(),
        Genre::Route => bas.trim_end_matches('/').to_owned(),
        _ => bas,
    }
}

/// Les entités de `texte`, dans l'ordre de première apparition, sans doublon de
/// clé, au plus [`MAX_PAR_SOUVENIR`]. Un texte entre accents graves est un
/// identifiant même sans forme typographique (`recall`, `infer`), s'il ne contient
/// pas de blanc.
pub fn extraire(texte: &str) -> Vec<Entite> {
    let mut vues = HashSet::new();
    let mut entites = Vec::new();
    let mut ajouter = |forme: &str, genre: Genre, entites: &mut Vec<Entite>| {
        let c = cle(forme, genre);
        if c.chars().count() >= LONGUEUR_MIN && entites.len() < MAX_PAR_SOUVENIR && vues.insert(c.clone()) {
            entites.push(Entite { cle: c, forme: forme.to_owned(), genre });
        }
    };
    // Accents graves d'abord : `…` est explicite.
    let mut reste = texte;
    while let Some(debut) = reste.find('`') {
        let apres = &reste[debut + 1..];
        let Some(fin) = apres.find('`') else { break };
        let code = apres[..fin].trim();
        if !code.is_empty() && !code.contains(char::is_whitespace) {
            let propre = code.trim_matches(|c: char| matches!(c, ',' | ';' | ':' | '"' | '\'')).trim_end_matches("()");
            if let Some(g) = genre(propre, true) {
                ajouter(propre, g, &mut entites);
            } else if propre.chars().all(|c| car_ident(c) || c == '.' || c == ':') && propre.chars().count() <= LONGUEUR_MAX {
                ajouter(propre, Genre::Identifiant, &mut entites);
            }
        }
        reste = &apres[fin + 1..];
    }
    let mut debut_de_phrase = true;
    for brut in texte.split_whitespace() {
        let jeton = brut.trim_matches(|c: char| ponctuation(c) || c == '`');
        // Une route garde sa barre initiale ; un chemin de dossier, sa barre finale.
        let jeton = jeton.trim_end_matches("()");
        if !jeton.is_empty()
            && let Some(g) = genre(jeton, debut_de_phrase)
        {
            ajouter(jeton, g, &mut entites);
        }
        debut_de_phrase = fin_de_phrase(brut) || brut.ends_with('\n');
    }
    entites
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cles(texte: &str) -> Vec<(String, Genre)> {
        extraire(texte).into_iter().map(|e| (e.cle, e.genre)).collect()
    }

    fn c(cle: &str, g: Genre) -> (String, Genre) {
        (cle.to_owned(), g)
    }

    #[test]
    fn fichiers_par_nom_de_base() {
        assert_eq!(
            cles("Le bug venait de src/recherche.rs et de omp-mem0-memory/recall.ts."),
            [c("recherche.rs", Genre::Fichier), c("recall.ts", Genre::Fichier)]
        );
        assert_eq!(cles("voir recherche.rs"), [c("recherche.rs", Genre::Fichier)]);
        // Une fin de phrase n'est pas une extension.
        assert!(cles("C'est fini. Vraiment.").is_empty());
        assert!(cles("https://exemple.org/page.html").is_empty());
    }

    #[test]
    fn codes_constantes_et_identifiants() {
        assert_eq!(
            cles("SQLITE_BUSY sous charge, E0502 au build, MEM0_DB_PATH absente"),
            [c("sqlite_busy", Genre::Code), c("e0502", Genre::Code), c("mem0_db_path", Genre::Code)]
        );
        assert_eq!(
            cles("la classe RunnerSession appelle mem0Client et ajouter_infere sur SQLite"),
            [
                c("runnersession", Genre::Identifiant),
                c("mem0client", Genre::Identifiant),
                c("ajouter_infere", Genre::Identifiant),
                c("sqlite", Genre::Identifiant),
            ]
        );
        assert_eq!(cles("on garde mem0-rs et sqlite-vec"), [c("mem0-rs", Genre::Identifiant), c("sqlite-vec", Genre::Identifiant)]);
        // Mots composés et sigles seuls : rien.
        assert!(cles("peut-être, c'est-à-dire, au-delà ; HTTP et SQL").is_empty());
    }

    #[test]
    fn routes_et_accents_graves() {
        assert_eq!(cles("POST /memory/search rend 500"), [c("/memory/search", Genre::Route)]);
        assert_eq!(
            cles("le champ `infer` et `recall()` ; `deux mots` non"),
            [c("infer", Genre::Identifiant), c("recall", Genre::Identifiant)]
        );
    }

    #[test]
    fn noms_propres_en_milieu_de_phrase_seulement() {
        assert_eq!(cles("Le serveur parle à Qdrant. Tailscale relie tout."), [c("qdrant", Genre::Nom)]);
        assert_eq!(cles("on passe par Tailscale"), [c("tailscale", Genre::Nom)]);
        assert!(cles("Voir aussi : Note importante").is_empty());
    }

    #[test]
    fn dedoublonnage_et_plafond() {
        assert_eq!(cles("recall.ts puis src/recall.ts puis RECALL.TS"), [c("recall.ts", Genre::Fichier)]);
        let long: String = (0..50).map(|i| format!("fichier{i}.rs ")).collect();
        assert_eq!(extraire(&long).len(), MAX_PAR_SOUVENIR);
        assert_eq!(extraire("recall.ts")[0].forme, "recall.ts");
    }
}
