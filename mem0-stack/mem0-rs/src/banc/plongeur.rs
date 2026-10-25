//! Plongeur local du banc : un embedding DÉTERMINISTE, sans réseau, qui porte un
//! peu de signal « sémantique » pour que les mesures hors ligne (CI) veuillent
//! dire quelque chose.
//!
//! Chaque texte devient un sac de traits hachés (signe et composante par
//! murmur3), normalisé en L2 :
//!
//! - les mots (minuscules, accents repliés, mots vides FR/EN retirés, `s` final
//!   retiré), poids 1 ;
//! - les trigrammes de caractères de chaque mot bordé (`<mot>`), poids 0,25 :
//!   proximité morphologique (`serveur`/`server`, `relance`/`relancer`) ;
//! - les concepts d'un petit lexique de développement bilingue (environ 70
//!   classes : stockage, verrou, sauvegarde, paiement…), poids 1,5 : un pont
//!   grossier entre synonymes et entre le français et l'anglais.
//!
//! Limites : ce n'est PAS un modèle de langue. Il ne comprend ni l'ordre des
//! mots, ni la négation, ni une paraphrase hors de son lexique ; les mots d'un
//! identifiant (`EMBEDDING_DIMS` → `embedding`, `dims`) y sont découpés comme le
//! ferait un tokenizer, ce qui le rend plus lexical qu'un vrai embedder. Le
//! lexique a été écrit en même temps que le corpus du banc : ses chiffres servent
//! à comparer les stratégies entre elles et à détecter une régression, pas à
//! prédire la qualité avec bge-m3 (`--embedder openai`).

use std::collections::HashMap;
use std::sync::LazyLock;

use crate::bm25::murmur3_x86_32;

const POIDS_MOT: f32 = 1.0;
const POIDS_TRIGRAMME: f32 = 0.25;
const POIDS_CONCEPT: f32 = 1.5;
const GRAINE_INDICE: u32 = 0x6d65_6d30;
const GRAINE_SIGNE: u32 = 0x6261_6e63;

/// Mots vides français et anglais (déjà repliés).
const MOTS_VIDES: &[&str] = &[
    "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "en", "au", "aux", "est", "sont", "pour", "par",
    "sur", "dans", "avec", "sans", "ce", "ces", "cet", "cette", "qui", "que", "quoi", "qu", "il", "ils", "elle", "on",
    "ne", "pas", "plus", "se", "sa", "son", "ses", "leur", "lui", "etre", "fait", "faire", "comme", "mais", "donc",
    "car", "si", "tout", "tous", "toute", "avant", "apres", "the", "an", "of", "to", "in", "for", "with", "and", "or",
    "is", "are", "be", "by", "it", "this", "that", "as", "at", "from", "not", "no", "do", "does", "how", "what",
    "which", "who", "when", "where", "why", "can", "should", "my", "we", "our", "you", "your", "its", "has", "have",
    "into", "after", "before", "then", "than", "only", "also", "toujours", "jamais", "chaque", "entre", "quand",
    "comment", "pourquoi", "ont", "mon", "ma", "mes", "notre", "nos", "votre",
];

/// Lexique de concepts : (nom, mots séparés par des espaces). Les mots passent
/// par la même normalisation que les textes.
const LEXIQUE: &[(&str, &str)] = &[
    (
        "stockage",
        "base donnees database db sqlite sql postgresql postgres stockage storage store duckdb bigquery table",
    ),
    ("verrou", "verrou lock flock mutex exclusif exclusive exclusivite concurrent concurrence simultane parallele"),
    ("serveur", "serveur server service instance processus process daemon"),
    ("ecriture", "ecrire ecrit ecrivaient ecriture write writing written"),
    ("sauvegarde", "sauvegarde backup instantane snapshot copie copy vacuum"),
    ("restauration", "restaurer restauration restore bring recuperer rollback older ancienne"),
    ("erreur", "erreur error bug panne crash plantage echec echoue failure fail exception panic mistake"),
    ("refus", "refuse refus rejete rejected reject invalide invalid signature"),
    ("performance", "lent lenteur slow latence latency performance perf rapide fast vitesse profiler flamegraph"),
    ("demarrage", "demarrer demarrage start startup lancer lancement boot"),
    ("arret", "arret arreter stop shutdown sigterm sigint kill"),
    ("configuration", "configuration config reglage parametre setting option environnement environment variable env"),
    ("secret", "secret jeton token cle key password credential identifiant redacted"),
    ("masquage", "masquage masquer masque redact redaction mask masking"),
    ("version", "version release bump publier publication semver patch mineure majeure minor major number"),
    ("decision", "decision decide decider choix choose retenu chosen"),
    ("conteneur", "conteneur container docker podman image compose engine rootless"),
    ("recherche", "recherche search chercher query requete retrieval meilisearch"),
    ("rappel", "rappel recall injecte injecter contexte context"),
    ("souvenir", "souvenir memoire memory mem0 memorise memoriser remember"),
    ("vecteur", "vecteur vector embedding plongement dense cosinus cosine similarite semantique semantic"),
    ("lexical", "bm25 lexical lexicalement keyword mot terme sparse creux idf fts5"),
    ("fusion", "fusion combinaison combination combine additionne hybride hybrid rerank reranking score"),
    ("seuil", "seuil threshold plancher floor pertinence relevance pertinent"),
    (
        "doublon",
        "doublon duplicate double repete repetee dedoublonne dedoublonnage dedup identique idempotence idempotent",
    ),
    ("suppression", "supprimer suppression delete effacer remove purge forget perime"),
    ("git", "git commit branche branch merge rebase worktree stash diff"),
    ("ci", "ci pipeline workflow github action runner"),
    ("tache", "job tache task traitement planifie cron backfill worker asset orchestration"),
    ("ligne", "ligne row enregistrement record"),
    ("lint", "lint linter biome formatage formate format clippy ruff flake8 black style"),
    ("typage", "typescript typage typecheck tsc type"),
    ("rust", "rust cargo crate rustc borrow emprunt"),
    ("javascript", "node npm javascript js bun promise"),
    ("python", "python pandas polars pip uv pandera dagster"),
    ("journal", "log journal trace stderr stdout imprime printed alerte alerting slack"),
    (
        "reseau",
        "reseau network proxy http https port url dns socket connexion connection reach joindre injoignable unreachable invisible ecoute ecouter listen",
    ),
    ("fichier", "fichier file dossier folder chemin path repertoire directory bucket"),
    ("utilisateur", "utilisateur user client"),
    ("langue", "francais francaise french anglais english langue language traduction translation multilingue"),
    ("temps", "date heure timestamp horodatage utc fuseau timezone isoformat paris"),
    ("mac", "macos mac apple swift xcode ios laptop machine macbook poste"),
    ("veille", "veille sleep sommeil hibernation reveil"),
    ("perte", "perdre perdait perdu lost lose perte"),
    ("limite", "limite limit plafond quota budget cap max maximum mio"),
    ("documentation", "documentation doc readme docs"),
    ("preference", "prefere prefer preference aime like deteste hate veut want"),
    ("reponse", "reponse repondre answer reply reponde resume"),
    ("delai", "timeout delai expiration attente wait froid chaud cold warm"),
    ("cache", "cache invalidation revalidate revalidatetag"),
    ("extraction", "extraction extraire extract llm prompt invite chat modele model qwen3 omlx"),
    ("migration", "import importer migration migrer migrate qdrant"),
    ("graphe", "graphe graph arete edge voisin neighbour neighbor noeud"),
    ("paiement", "paiement payment stripe checkout facture commande order"),
    ("notification", "webhook notification callback evenement event e-mail email mail"),
    ("argent", "prix montant price amount centime euro tva arrondi rounding flottant virgule float decimal"),
    ("test", "test essai spec assertion unitaire integration fixture flaky instable playwright regression"),
    ("web", "navigateur browser html hydration rendu render page nextjs react"),
    (
        "correspondance",
        "mismatch correspondent correspondre divergence diverge divergeait ecart contredit contredire contradiction disagree contradict",
    ),
    ("memoire_vive", "ram oom out-of-memory streaming lazy"),
    ("cloud", "cloud gcp aws s3 gcs vercel cdn"),
    ("shell", "shell bash zsh script terminal"),
    ("donnees_metier", "vente sale magasin produit product stock panier cart"),
    ("depot", "depot repository repo codebase"),
    ("autorite", "autorite authority win gagne prevaut prevail"),
    ("commentaire", "commentaire comments"),
    ("critere", "critere acceptation acceptance slug titre title ac"),
];

/// Lexique normalisé : mot → concept.
static CONCEPTS: LazyLock<HashMap<String, &'static str>> = LazyLock::new(|| {
    let mut table = HashMap::new();
    for (concept, mots) in LEXIQUE {
        for mot in mots.split(' ') {
            for jeton in jetons(mot) {
                table.entry(jeton).or_insert(*concept);
            }
        }
    }
    table
});

/// Repli des accents latins courants.
fn replier(c: char) -> char {
    match c {
        'à' | 'â' | 'ä' | 'á' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'î' | 'ï' | 'í' => 'i',
        'ô' | 'ö' | 'ó' => 'o',
        'ù' | 'û' | 'ü' | 'ú' => 'u',
        'ç' => 'c',
        'ÿ' => 'y',
        'ñ' => 'n',
        autre => autre,
    }
}

/// Mots normalisés de `texte` : minuscules, accents repliés, découpe sur tout ce
/// qui n'est pas alphanumérique (`_`, `.`, `-` compris), mots vides et lettres
/// isolées retirés, `s` final retiré au-delà de 3 lettres (sauf `ss`).
pub fn jetons(texte: &str) -> Vec<String> {
    let replie: String = texte.to_lowercase().replace('œ', "oe").replace('æ', "ae").chars().map(replier).collect();
    replie
        .split(|c: char| !c.is_alphanumeric())
        .filter(|m| m.chars().count() > 1 && !MOTS_VIDES.contains(m))
        .map(|m| {
            if m.len() > 3 && m.ends_with('s') && !m.ends_with("ss") {
                m[..m.len() - 1].to_owned()
            } else {
                m.to_owned()
            }
        })
        .collect()
}

fn ajouter(vecteur: &mut [f32], trait_: &str, poids: f32) {
    let octets = trait_.as_bytes();
    let indice = murmur3_x86_32(octets, GRAINE_INDICE) as usize % vecteur.len();
    let signe = if murmur3_x86_32(octets, GRAINE_SIGNE) & 1 == 0 { 1.0 } else { -1.0 };
    vecteur[indice] += signe * poids;
}

/// Vecteur de `texte` en `dims` dimensions, normalisé en L2 ; sans trait, e0.
pub fn plonger(texte: &str, dims: usize) -> Vec<f32> {
    let mut vecteur = vec![0.0f32; dims];
    for mot in jetons(texte) {
        ajouter(&mut vecteur, &format!("m:{mot}"), POIDS_MOT);
        let borde: Vec<char> = format!("<{mot}>").chars().collect();
        for tri in borde.windows(3) {
            ajouter(&mut vecteur, &format!("t:{}", tri.iter().collect::<String>()), POIDS_TRIGRAMME);
        }
        if let Some(concept) = CONCEPTS.get(&mot) {
            ajouter(&mut vecteur, &format!("c:{concept}"), POIDS_CONCEPT);
        }
    }
    let norme = vecteur.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norme == 0.0 {
        vecteur[0] = 1.0;
        return vecteur;
    }
    vecteur.iter().map(|x| x / norme).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cosinus(a: &str, b: &str) -> f32 {
        plonger(a, 1024).iter().zip(plonger(b, 1024)).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn jetons_replies_et_filtres() {
        assert_eq!(jetons("L'ÉTÉ des Serveurs, EMBEDDING_DIMS!"), ["ete", "serveur", "embedding", "dim"]);
        assert_eq!(jetons("the process is"), ["process"]);
        assert!(jetons("").is_empty());
    }

    #[test]
    fn deterministe_normalise_et_porteur_de_sens() {
        let v = plonger("verrou exclusif du serveur", 64);
        assert_eq!(v, plonger("verrou exclusif du serveur", 64));
        assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-5);
        let vide = plonger("le la les", 8);
        assert_eq!(vide[0], 1.0);
        // Un synonyme du lexique rapproche plus qu'un mot sans rapport.
        assert!(cosinus("database lock", "verrou de la base") > cosinus("database lock", "prix en centimes"));
        // Trigrammes : la flexion rapproche.
        assert!(cosinus("relancer le job", "relance du job") > 0.5);
    }
}
