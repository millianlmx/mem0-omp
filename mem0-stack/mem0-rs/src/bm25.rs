//! Encodeur BM25 creux (S-6) : reproduction de fastembed 0.8.1, modèle
//! `Qdrant/bm25`, tel que mem0ai 2.2.1 l'appelle (`embed()` pour les souvenirs
//! ET pour la requête ; D-2).
//!
//! Pipeline : `\w` au sens de Python, minuscules, découpe ; jetons écartés
//! (`_` seul, mots vides anglais, plus de 40 points de code) ; racine Snowball
//! anglaise (`rust-stemmers` 1.2.0, celle de py_rust_stemmers 0.1.8, D-3) ;
//! poids TF BM25 (k=1.2, b=0.75, avg_len=256) ; indice = |murmur3_x86_32| (D-4).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use rust_stemmers::{Algorithm, Stemmer};
use unicode_general_category::{GeneralCategory, get_general_category};

/// Vecteur creux : (indice, poids), dans l'ordre de première apparition.
pub type VecteurCreux = Vec<(u32, f32)>;

const K: f64 = 1.2;
const B: f64 = 0.75;
const LONGUEUR_MOYENNE: f64 = 256.0;
/// Au-delà, le jeton est ignoré (en points de code).
const LONGUEUR_MAX: usize = 40;

/// `english.txt` du dépôt HF `Qdrant/bm25`, révision 22b8d2af (D-2), lu comme
/// `splitlines`.
static MOTS_VIDES: LazyLock<HashSet<&'static str>> =
    LazyLock::new(|| include_str!("stopwords_english.txt").lines().collect());

static RACINISEUR: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::English));

/// `\w` de Python : `_`, ou `str.isalnum()` (lettres et nombres Unicode).
fn est_mot(c: char) -> bool {
    use GeneralCategory::*;
    c == '_'
        || matches!(
            get_general_category(c),
            UppercaseLetter
                | LowercaseLetter
                | TitlecaseLetter
                | ModifierLetter
                | OtherLetter
                | DecimalNumber
                | LetterNumber
                | OtherNumber
        )
}

/// Catégorie Unicode `P*`.
fn est_ponctuation(c: char) -> bool {
    use GeneralCategory::*;
    matches!(
        get_general_category(c),
        ConnectorPunctuation
            | DashPunctuation
            | OpenPunctuation
            | ClosePunctuation
            | InitialPunctuation
            | FinalPunctuation
            | OtherPunctuation
    )
}

/// Jetons de fastembed (`SimpleTokenizer` après `remove_non_alphanumeric`) :
/// tout ce qui n'est pas `\w` sépare, puis minuscules, puis nouvelle découpe
/// (la minuscule d'une lettre peut porter une marque combinante, hors `\w`).
fn jetons(texte: &str) -> Vec<String> {
    let mots: String = texte.chars().map(|c| if est_mot(c) { c } else { ' ' }).collect();
    mots.to_lowercase().split(|c: char| !est_mot(c)).filter(|j| !j.is_empty()).map(str::to_owned).collect()
}

/// Les racines gardées de `texte`, dans l'ordre.
fn racines(texte: &str) -> Vec<String> {
    jetons(texte)
        .into_iter()
        .filter(|j| {
            let mut cars = j.chars();
            let seul_ponctuation = matches!((cars.next(), cars.next()), (Some(c), None) if est_ponctuation(c));
            !seul_ponctuation && !MOTS_VIDES.contains(j.as_str()) && j.chars().count() <= LONGUEUR_MAX
        })
        .map(|j| RACINISEUR.stem(&j).into_owned())
        .filter(|r| !r.is_empty())
        .collect()
}

/// MurmurHash3_x86_32 (smhasher), sur `octets` avec la graine `graine`.
pub fn murmur3_x86_32(octets: &[u8], graine: u32) -> u32 {
    const C1: u32 = 0xcc9e_2d51;
    const C2: u32 = 0x1b87_3593;
    let melanger = |k: u32| k.wrapping_mul(C1).rotate_left(15).wrapping_mul(C2);
    let mut h = graine;
    let (blocs, reste) = octets.as_chunks::<4>();
    for bloc in blocs {
        h ^= melanger(u32::from_le_bytes(*bloc));
        h = h.rotate_left(13).wrapping_mul(5).wrapping_add(0xe654_6b64);
    }
    if !reste.is_empty() {
        let k = reste.iter().enumerate().fold(0u32, |k, (i, &o)| k ^ (u32::from(o) << (8 * i)));
        h ^= melanger(k);
    }
    // La longueur est prise modulo 2^32, comme `int len` du C.
    h ^= octets.len() as u32;
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^ (h >> 16)
}

/// Indice creux d'une racine : `abs(mmh3.hash(racine))` (signé, graine 0).
fn indice(racine: &str) -> u32 {
    (murmur3_x86_32(racine.as_bytes(), 0) as i32).unsigned_abs()
}

/// Vecteur creux BM25 de `texte` (fastembed `Bm25.embed`).
pub fn encoder(texte: &str) -> VecteurCreux {
    let racines = racines(texte);
    let longueur = racines.len() as f64;
    // Compte par racine distincte, dans l'ordre de première apparition (Counter).
    let mut comptes: Vec<(&str, u32)> = Vec::new();
    let mut position: HashMap<&str, usize> = HashMap::new();
    for r in &racines {
        match position.get(r.as_str()) {
            Some(&p) => comptes[p].1 += 1,
            None => {
                position.insert(r, comptes.len());
                comptes.push((r, 1));
            }
        }
    }
    // `tf_map[indice] = poids` : une collision garde la place de la première
    // racine et le poids de la dernière.
    let mut vecteur: VecteurCreux = Vec::with_capacity(comptes.len());
    let mut places: HashMap<u32, usize> = HashMap::new();
    for (racine, n) in comptes {
        let n = f64::from(n);
        let poids = n * (K + 1.0) / (n + K * (1.0 - B + B * longueur / LONGUEUR_MOYENNE));
        let i = indice(racine);
        match places.get(&i) {
            Some(&p) => vecteur[p].1 = poids as f32,
            None => {
                places.insert(i, vecteur.len());
                vecteur.push((i, poids as f32));
            }
        }
    }
    vecteur
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proche(obtenu: &VecteurCreux, attendu: &[(u32, f64)]) {
        assert_eq!(obtenu.len(), attendu.len(), "{obtenu:?}");
        for ((i, p), (ia, pa)) in obtenu.iter().zip(attendu) {
            assert_eq!(i, ia, "{obtenu:?}");
            assert!((f64::from(*p) - pa).abs() <= 1e-6, "{i} : {p} ≠ {pa}");
        }
    }

    #[test]
    fn ac13_vecteurs_dores_fastembed() {
        proche(
            &encoder("Constante EMBEDDING_DIMS du serveur"),
            &[(1322743076, 1.674197), (1977954053, 1.674197), (640334390, 1.674197), (1084072007, 1.674197)],
        );
        proche(&encoder("The runners are running: run, RUN!"), &[(946033505, 1.674197), (243905464, 1.991513)]);
        proche(
            &encoder("Les vecteurs du serveur ont une taille fixe"),
            &[
                (323807359, 1.656471),
                (1949969174, 1.656471),
                (640334390, 1.656471),
                (1084072007, 1.656471),
                (1995274175, 1.656471),
                (808015403, 1.656471),
                (1361100604, 1.656471),
                (761976698, 1.656471),
            ],
        );
    }

    #[test]
    fn ac13_hachages_mmh3() {
        for (texte, attendu) in [
            ("hello", 613153351),
            ("embedding_dims", 272971720),
            ("serveur", 1084072007),
            ("é", 269551495),
            ("", 0),
            ("run", -243905464),
            ("dims", -1487884295),
            ("test", -1167338989),
        ] {
            assert_eq!(murmur3_x86_32(texte.as_bytes(), 0) as i32, attendu, "mmh3.hash({texte:?})");
        }
        assert_eq!(indice("run"), 243905464);
    }

    #[test]
    fn ac13_racines_py_rust_stemmers() {
        for (mot, racine) in [
            ("running", "run"),
            ("vecteurs", "vecteur"),
            ("serveurs", "serveur"),
            ("taille", "taill"),
            ("embedding_dims", "embedding_dim"),
            ("constante", "constant"),
            ("easily", "easili"),
            ("préparer", "préparer"),
        ] {
            assert_eq!(RACINISEUR.stem(mot), racine, "{mot}");
        }
    }

    #[test]
    fn ac13_mots_vides_english_txt() {
        assert_eq!(include_str!("stopwords_english.txt").lines().count(), 179);
        assert_eq!(MOTS_VIDES.len(), 179);
        assert!(["the", "are", "a", "of"].iter().all(|m| MOTS_VIDES.contains(m)));
        // Mots vides seuls : aucun terme.
        assert!(encoder("The are OF a").is_empty());
    }

    #[test]
    fn ac13_filtres_de_jetons() {
        // `_` seul est de la ponctuation ; `__` est gardé.
        assert_eq!(racines("_ __ a_b"), ["__", "a_b"]);
        // 40 points de code passent, 41 non (accents comptés une fois).
        let quarante = "é".repeat(40);
        assert_eq!(racines(&format!("{quarante} {quarante}é")), std::slice::from_ref(&quarante));
        // Ponctuation, chiffres, majuscules.
        assert_eq!(jetons("Zéphyr-42, l'ÉTÉ!"), ["zéphyr", "42", "l", "été"]);
        // Une racine répétée : un seul indice, n = 3.
        let v = encoder("zéphyr zéphyr zéphyr");
        assert_eq!(v.len(), 1);
        let attendu = 3.0 * 2.2 / (3.0 + 1.2 * (0.25 + 0.75 * 3.0 / 256.0));
        assert!((f64::from(v[0].1) - attendu).abs() <= 1e-6);
        assert!(encoder("").is_empty());
    }
}
