//! Masquage des secrets avant écriture (`add`, `add_procedure`, `PUT`) : les
//! familles de `redact` du plugin (omp-mem0-memory/write.ts), dans le même ordre,
//! avec le même jeton `[REDACTED]`. Le plugin masque déjà ce qu'il envoie ; le
//! serveur couvre les clients qui écrivent sans lui (oracle du harness, apps
//! OMP Console). Best-effort, pas une garantie : un secret hors motif passe.
//!
//! Pas de crate d'expressions régulières (dépendances de S-8) : chaque motif est
//! une petite séquence de pièces, essayée à chaque position avec retour arrière,
//! ce qui reproduit la recherche de `String.prototype.replace` avec un motif `/g`.
//! Les répétitions comptent en unités UTF-16, comme JavaScript : un emoji vaut 2.
//! `tests/redaction-cas.json` est jugé ici et par test/memoire/redaction.test.ts.

/// Une pièce de motif.
enum Piece {
    /// Littéral, casse exacte.
    Lit(&'static str),
    /// Littéral, casse ASCII ignorée (drapeau `i` de JavaScript sans `u`).
    LitI(&'static str),
    /// Caractère de la classe, répété entre `min` et `max` unités UTF-16 ;
    /// gourmand, ou paresseux (`*?`).
    Rep { classe: fn(char) -> bool, min: usize, max: usize, paresseux: bool },
    /// Séquence facultative (`(?:…)?`), essayée d'abord.
    Opt(&'static [Piece]),
    /// Alternative (`(?:a|b)`), dans l'ordre.
    Alt(&'static [&'static [Piece]]),
}

const SANS_BORNE: usize = usize::MAX;

const fn rep(classe: fn(char) -> bool, min: usize) -> Piece {
    Piece::Rep { classe, min, max: SANS_BORNE, paresseux: false }
}

/// `\s` de JavaScript : WhiteSpace et LineTerminator d'ECMAScript.
fn blanc_js(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn alnum(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

fn majuscule_ou_chiffre(c: char) -> bool {
    c.is_ascii_uppercase() || c.is_ascii_digit()
}

/// `[A-Za-z0-9_-]`
fn mot_tiret(c: char) -> bool {
    alnum(c) || c == '_' || c == '-'
}

/// `[A-Za-z0-9_]`
fn mot(c: char) -> bool {
    alnum(c) || c == '_'
}

/// `[A-Za-z0-9-]`
fn alnum_tiret(c: char) -> bool {
    alnum(c) || c == '-'
}

/// `[a-zA-Z0-9._-]`
fn porteur(c: char) -> bool {
    mot_tiret(c) || c == '.'
}

/// `[^\s"']`
fn valeur(c: char) -> bool {
    !blanc_js(c) && c != '"' && c != '\''
}

/// `[ A-Z0-9_-]`
fn entete_pem(c: char) -> bool {
    majuscule_ou_chiffre(c) || c == ' ' || c == '_' || c == '-'
}

fn tout(_: char) -> bool {
    true
}

/// `[a-z0-9+.-]` sous le drapeau `i`.
fn schema(c: char) -> bool {
    alnum(c) || matches!(c, '+' | '.' | '-')
}

/// `[^/\s:@]`
fn userinfo(c: char) -> bool {
    !blanc_js(c) && !matches!(c, '/' | ':' | '@')
}

fn guillemet(c: char) -> bool {
    c == '"' || c == '\''
}

fn deux_points_ou_egal(c: char) -> bool {
    c == ':' || c == '='
}

fn souligne_ou_tiret(c: char) -> bool {
    c == '_' || c == '-'
}

const fn un(classe: fn(char) -> bool) -> Piece {
    Piece::Rep { classe, min: 1, max: 1, paresseux: false }
}

const fn facultatif(classe: fn(char) -> bool) -> Piece {
    Piece::Rep { classe, min: 0, max: 1, paresseux: false }
}

const fn blancs(min: usize) -> Piece {
    rep(blanc_js, min)
}

const PEM_FIN: &[Piece] = &[Piece::Lit(" BLOCK")];

/// Les motifs de `SECRET_PATTERNS` (write.ts), dans l'ordre.
const MOTIFS: &[&[Piece]] = &[
    // sk-[a-zA-Z0-9]{16,}
    &[Piece::Lit("sk-"), rep(alnum, 16)],
    // ghp_[a-zA-Z0-9]{20,}
    &[Piece::Lit("ghp_"), rep(alnum, 20)],
    // AKIA[0-9A-Z]{12,}
    &[Piece::Lit("AKIA"), rep(majuscule_ou_chiffre, 12)],
    // eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}
    &[
        Piece::Lit("eyJ"),
        rep(mot_tiret, 10),
        Piece::Lit("."),
        rep(mot_tiret, 10),
        Piece::Lit("."),
        rep(mot_tiret, 10),
    ],
    // /Bearer\s+[a-zA-Z0-9._-]{16,}/i
    &[Piece::LitI("Bearer"), blancs(1), rep(porteur, 16)],
    // /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/i
    &[
        Piece::Alt(&[
            &[Piece::LitI("api"), facultatif(souligne_ou_tiret), Piece::LitI("key")],
            &[Piece::LitI("secret")],
            &[Piece::LitI("token")],
            &[Piece::LitI("password")],
            &[Piece::LitI("passwd")],
        ]),
        blancs(0),
        un(deux_points_ou_egal),
        blancs(0),
        facultatif(guillemet),
        rep(valeur, 8),
    ],
    // sk-ant-api03-[A-Za-z0-9_-]{16,}
    &[Piece::Lit("sk-ant-api03-"), rep(mot_tiret, 16)],
    // sk-proj-[A-Za-z0-9_-]{16,}
    &[Piece::Lit("sk-proj-"), rep(mot_tiret, 16)],
    // github_pat_[A-Za-z0-9_]{16,}
    &[Piece::Lit("github_pat_"), rep(mot, 16)],
    // xox[abep]-[A-Za-z0-9-]{10,}
    &[Piece::Lit("xox"), un(|c| matches!(c, 'a' | 'b' | 'e' | 'p')), Piece::Lit("-"), rep(alnum_tiret, 10)],
    // -----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----
    &[
        Piece::Lit("-----BEGIN"),
        Piece::Rep { classe: entete_pem, min: 0, max: 100, paresseux: false },
        Piece::Lit("PRIVATE KEY"),
        Piece::Opt(PEM_FIN),
        Piece::Lit("-----"),
        Piece::Rep { classe: tout, min: 0, max: SANS_BORNE, paresseux: true },
        Piece::Lit("-----END"),
        Piece::Rep { classe: entete_pem, min: 0, max: 100, paresseux: false },
        Piece::Lit("PRIVATE KEY"),
        Piece::Opt(PEM_FIN),
        Piece::Lit("-----"),
    ],
    // [rs]k_(?:live|test|prod)_[A-Za-z0-9]{10,}
    &[
        un(|c| c == 'r' || c == 's'),
        Piece::Lit("k_"),
        Piece::Alt(&[&[Piece::Lit("live")], &[Piece::Lit("test")], &[Piece::Lit("prod")]]),
        Piece::Lit("_"),
        rep(alnum, 10),
    ],
    // glpat-[A-Za-z0-9_-]{20,}
    &[Piece::Lit("glpat-"), rep(mot_tiret, 20)],
    // hf_[A-Za-z0-9]{30,}
    &[Piece::Lit("hf_"), rep(alnum, 30)],
    // npm_[A-Za-z0-9]{36,}
    &[Piece::Lit("npm_"), rep(alnum, 36)],
    // AIza[A-Za-z0-9_-]{35,}
    &[Piece::Lit("AIza"), rep(mot_tiret, 35)],
];

/// `([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]*):([^/\s:@]+)@` sous `gi` (URL_CREDS_PATTERN).
const URL_IDENTIFIANTS: &[Piece] = &[
    un(|c| c.is_ascii_alphabetic()),
    rep(schema, 0),
    Piece::Lit("://"),
    rep(userinfo, 0),
    Piece::Lit(":"),
    rep(userinfo, 1),
    Piece::Lit("@"),
];

const JETON: &str = "[REDACTED]";

/// Une passe d'un motif sur un texte, avec ses caches. Le retour arrière naïf est
/// quadratique sur un long mot (« eyJeyJeyJ… » sans point, un Mio de lettres sans
/// `://`) : chaque départ rebalayait la même plage. Ici la fin d'une plage d'une
/// classe et la prochaine occurrence d'un littéral sont calculées une fois.
struct Passe<'t> {
    t: &'t [char],
    /// `unites[k]` : unités UTF-16 de `t[..k]`.
    unites: Vec<usize>,
    /// Par classe : dernière plage calculée `[début, fin)` de caractères de la classe.
    plages: Vec<(usize, usize, usize)>,
    /// Par littéral : `(depuis, trouvé)`, aucune occurrence dans `[depuis, trouvé)`.
    occurrences: Vec<(&'static str, usize, Option<usize>)>,
}

impl<'t> Passe<'t> {
    fn new(t: &'t [char]) -> Self {
        let mut unites = Vec::with_capacity(t.len() + 1);
        unites.push(0);
        for c in t {
            unites.push(unites[unites.len() - 1] + c.len_utf16());
        }
        Passe { t, unites, plages: Vec::new(), occurrences: Vec::new() }
    }

    /// Fin de la plage maximale de caractères de `classe` qui part de `j`.
    fn fin_de_plage(&mut self, classe: fn(char) -> bool, j: usize) -> usize {
        let cle = classe as usize;
        if let Some(&(_, debut, fin)) = self.plages.iter().find(|p| p.0 == cle)
            && debut <= j
            && j <= fin
        {
            return fin;
        }
        let fin = j + self.t[j..].iter().take_while(|&&c| classe(c)).count();
        match self.plages.iter_mut().find(|p| p.0 == cle) {
            Some(p) => *p = (cle, j, fin),
            None => self.plages.push((cle, j, fin)),
        }
        fin
    }

    /// Le littéral commence-t-il en `j` ?
    fn litteral_en(&self, s: &str, casse: bool, j: usize) -> Option<usize> {
        let mut k = j;
        for attendu in s.chars() {
            let c = *self.t.get(k)?;
            if !(if casse { c == attendu } else { c.eq_ignore_ascii_case(&attendu) }) {
                return None;
            }
            k += 1;
        }
        Some(k)
    }

    /// Première occurrence de `s` (casse exacte) à partir de `j`.
    fn prochaine_occurrence(&mut self, s: &'static str, j: usize) -> Option<usize> {
        if let Some(&(_, depuis, trouve)) = self.occurrences.iter().find(|o| o.0 == s)
            && depuis <= j
            && trouve.is_none_or(|t| j <= t)
        {
            return trouve;
        }
        let trouve = (j..self.t.len()).find(|&k| self.litteral_en(s, true, k).is_some());
        match self.occurrences.iter_mut().find(|o| o.0 == s) {
            Some(o) => *o = (s, j, trouve),
            None => self.occurrences.push((s, j, trouve)),
        }
        trouve
    }
}

/// La pièce qui suit `queue` épuisée : la tête de la prochaine séquence non vide de `suite`.
fn prochaine<'a>(queue: &'a [Piece], suite: &[&'a [Piece]]) -> Option<&'a Piece> {
    queue.first().or_else(|| suite.iter().rev().find_map(|s| s.first()))
}

/// Fin de la correspondance de `seq` (puis des séquences de `suite`, de la
/// dernière empilée à la première) à partir de `i`, ou `None`.
fn filtrer<'a>(seq: &'a [Piece], suite: &mut Vec<&'a [Piece]>, p: &mut Passe<'_>, i: usize) -> Option<usize> {
    let Some((tete, queue)) = seq.split_first() else {
        let Some(suivante) = suite.pop() else {
            return Some(i);
        };
        let fin = filtrer(suivante, suite, p, i);
        suite.push(suivante);
        return fin;
    };
    match tete {
        Piece::Lit(s) | Piece::LitI(s) => {
            let j = p.litteral_en(s, matches!(tete, Piece::Lit(_)), i)?;
            filtrer(queue, suite, p, j)
        }
        Piece::Rep { classe, min, max, paresseux } => {
            let (classe, min, max) = (*classe, *min, *max);
            if max != SANS_BORNE {
                // Borné (au plus 100) : énumération directe des fins admises, qui
                // forment un intervalle `[premiere, j]`.
                let (mut j, mut unites, mut premiere) = (i, 0usize, (min == 0).then_some(i));
                while let Some(&c) = p.t.get(j) {
                    if !classe(c) || unites + c.len_utf16() > max {
                        break;
                    }
                    unites += c.len_utf16();
                    j += 1;
                    if unites >= min && premiere.is_none() {
                        premiere = Some(j);
                    }
                }
                let premiere = premiere?;
                return if *paresseux {
                    (premiere..=j).find_map(|k| filtrer(queue, suite, p, k))
                } else {
                    (premiere..=j).rev().find_map(|k| filtrer(queue, suite, p, k))
                };
            }
            let fin = p.fin_de_plage(classe, i);
            // Première fin admise : celle où la répétition atteint `min` unités
            // (recherche dichotomique, les unités cumulées sont croissantes).
            let cible = p.unites[i] + min;
            let premiere = i + p.unites[i..=fin].partition_point(|&u| u < cible);
            if premiere > fin {
                return None;
            }
            let suivant = prochaine(queue, suite);
            if *paresseux {
                // Paresseux suivi d'un littéral : seules ses occurrences sont des fins possibles.
                if let Some(Piece::Lit(s)) = suivant {
                    let mut k = premiere;
                    while let Some(o) = p.prochaine_occurrence(s, k).filter(|&o| o <= fin) {
                        if let Some(r) = filtrer(queue, suite, p, o) {
                            return Some(r);
                        }
                        k = o + 1;
                    }
                    return None;
                }
                return (premiere..=fin).find_map(|k| filtrer(queue, suite, p, k));
            }
            // Gourmand suivi d'un littéral dont le premier caractère est hors de la
            // classe : seule la fin de la plage peut convenir.
            if let Some(Piece::Lit(s) | Piece::LitI(s)) = suivant
                && let Some(c) = s.chars().next()
                && !classe(c.to_ascii_lowercase())
                && !classe(c.to_ascii_uppercase())
            {
                return filtrer(queue, suite, p, fin);
            }
            (premiere..=fin).rev().find_map(|k| filtrer(queue, suite, p, k))
        }
        Piece::Opt(facultative) => {
            suite.push(queue);
            let fin = filtrer(facultative, suite, p, i);
            suite.pop();
            fin.or_else(|| filtrer(queue, suite, p, i))
        }
        Piece::Alt(branches) => {
            suite.push(queue);
            let fin = branches.iter().find_map(|b| filtrer(b, suite, p, i));
            suite.pop();
            fin
        }
    }
}

/// Remplace chaque correspondance de `motif`, de gauche à droite et sans
/// chevauchement, par ce que `remplacer` rend des caractères trouvés.
fn remplacer_tout(texte: &str, motif: &[Piece], remplacer: impl Fn(&[char]) -> String) -> String {
    let t: Vec<char> = texte.chars().collect();
    let mut passe = Passe::new(&t);
    let mut sortie = String::with_capacity(texte.len());
    let mut suite = Vec::new();
    // Premier caractère d'un motif qui commence par un littéral : les positions
    // qui ne le portent pas sont écartées sans lancer la correspondance.
    let premier = match motif.first() {
        Some(Piece::Lit(s)) => s.chars().next().map(|c| (c, true)),
        Some(Piece::LitI(s)) => s.chars().next().map(|c| (c, false)),
        _ => None,
    };
    let mut i = 0;
    while i < t.len() {
        let candidat =
            premier.is_none_or(|(c, casse)| if casse { t[i] == c } else { t[i].eq_ignore_ascii_case(&c) });
        match candidat.then(|| filtrer(motif, &mut suite, &mut passe, i)).flatten() {
            Some(fin) if fin > i => {
                sortie.push_str(&remplacer(&t[i..fin]));
                i = fin;
            }
            _ => {
                sortie.push(t[i]);
                i += 1;
            }
        }
    }
    sortie
}

/// Le texte, secrets masqués : chaque motif à son tour, puis les identifiants
/// d'URL (le schéma et `://` sont conservés).
pub fn masquer(texte: &str) -> String {
    let mut sortie = texte.to_owned();
    for motif in MOTIFS {
        sortie = remplacer_tout(&sortie, motif, |_| JETON.to_owned());
    }
    remplacer_tout(&sortie, URL_IDENTIFIANTS, |trouve| {
        // Le schéma n'a pas de `:` : le premier `://` le termine.
        let fin_schema = trouve.windows(3).position(|w| w == [':', '/', '/']).map_or(0, |p| p + 3);
        let mut s: String = trouve[..fin_schema].iter().collect();
        s.push_str(JETON);
        s.push('@');
        s
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Les cas partagés avec le plugin : même entrée, même sortie que `redact`.
    #[test]
    fn redaction_cas_partages_avec_le_plugin() {
        let cas: Value = serde_json::from_str(include_str!("../tests/redaction-cas.json")).unwrap();
        let cas = cas["cas"].as_array().unwrap();
        assert!(cas.len() >= 40, "cas partagés : {}", cas.len());
        for c in cas {
            let entree: String = c["entree"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();
            assert_eq!(masquer(&entree), c["attendu"].as_str().unwrap(), "cas « {} »", c["nom"]);
        }
    }

    #[test]
    fn idempotent_et_jeton_stable() {
        let cas: Value = serde_json::from_str(include_str!("../tests/redaction-cas.json")).unwrap();
        let tout: String = cas["cas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["entree"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        let une = masquer(&tout);
        assert_eq!(masquer(&une), une);
        assert_eq!(masquer(JETON), JETON);
    }

    /// Un long mot ne coûte pas un temps quadratique : sans les caches de `Passe`,
    /// un Mio de `a` (motif d'URL) ou de `eyJ` répété (JWT sans point) bloquait un
    /// fil du serveur pendant des minutes. À 256 Kio, le quadratique se compterait
    /// en dizaines de milliards de pas ; le linéaire tient en quelques secondes,
    /// même sans optimisations.
    #[test]
    fn long_mot_masque_en_temps_lineaire() {
        let n = 256 * 1024;
        let entrees = [
            "a".repeat(n),
            "eyJ".repeat(n / 3),
            "-----BEGIN PRIVATE KEY-----".repeat(n / 27),
            "Bearer ".repeat(n / 7),
            "a://b".repeat(n / 5),
            format!("{}{}", "sk-", "a".repeat(n)),
        ];
        let debut = std::time::Instant::now();
        for e in &entrees {
            let sortie = masquer(e);
            assert!(sortie.len() <= e.len());
        }
        let duree = debut.elapsed();
        assert!(duree < std::time::Duration::from_secs(30), "{duree:?}");
    }
}
