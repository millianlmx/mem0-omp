//! Extraction additive de mem0 2.2.1 (`add(infer=True)`), logique pure (S-2, S-3).
//!
//! L'invite reproduit `generate_additive_extraction_prompt` (mem0/configs/prompts.py)
//! et la lecture de la réponse reproduit `remove_code_blocks`, `extract_json` et
//! `json.loads(…, strict=False)` (mem0/memory/utils.py, main.py), sans `regex` :
//! les motifs sont écrits à la main.

use serde_json::ser::{CompactFormatter, Formatter, Serializer};
use serde_json::{Map, Value, json};

use crate::config::{blanc_python, strip_python};

/// Invite système : `ADDITIVE_EXTRACTION_PROMPT` de mem0 2.2.1, octet pour octet.
pub const ADDITIVE_EXTRACTION_PROMPT: &str = include_str!("prompts/additive_extraction.txt");

/// `CUSTOM_INSTRUCTIONS` de l'ancien mem0-http Python, octet pour octet.
pub const CUSTOM_INSTRUCTIONS: &str = include_str!("prompts/custom_instructions.txt");

/// Nombre de souvenirs existants montrés au LLM et vus par le dédoublonnage.
pub const VOISINS: usize = 10;

/// Longueur (en points de code) au-delà de laquelle un message de « Last k
/// Messages » est tronqué.
const TRONCATURE: usize = 300;

const BALISES: &str = "```";

/// Valeur de vérité de Python : `null`, `false`, `0`, `""`, `[]` et `{}` sont faux.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_none_or(|x| x != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Scope de session de `_build_session_scope` : `clé=valeur` triées par clé,
/// valeurs vides omises, jointes par `&` ; `%`, `&` et `=` échappés dans les valeurs.
pub fn portee_session(user_id: &str, agent_id: Option<&str>, run_id: Option<&str>) -> String {
    [("agent_id", agent_id), ("run_id", run_id), ("user_id", Some(user_id))]
        .into_iter()
        .filter_map(|(cle, valeur)| valeur.filter(|v| !v.is_empty()).map(|v| format!("{cle}={}", echapper(v))))
        .collect::<Vec<_>>()
        .join("&")
}

fn echapper(valeur: &str) -> String {
    valeur.replace('%', "%25").replace('&', "%26").replace('=', "%3D")
}

/// `_truncate_content` : au plus 300 points de code, sinon les 300 premiers suivis de `...`.
pub fn tronque_300(contenu: &str) -> String {
    match contenu.char_indices().nth(TRONCATURE) {
        Some((fin, _)) => format!("{}...", &contenu[..fin]),
        None => contenu.to_owned(),
    }
}

/// Séparateurs de `json.dumps` sans `indent` : `", "` et `": "`.
struct FormatPython;

impl Formatter for FormatPython {
    fn begin_array_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        if first { Ok(()) } else { w.write_all(b", ") }
    }

    fn begin_object_key<W: ?Sized + std::io::Write>(&mut self, w: &mut W, first: bool) -> std::io::Result<()> {
        if first { Ok(()) } else { w.write_all(b", ") }
    }

    fn begin_object_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
        CompactFormatter.begin_object_value(w)?;
        w.write_all(b" ")
    }
}

/// `json.dumps(v, ensure_ascii=False)` : l'échappement de serde_json est le même
/// (D-5, D-7), seuls les séparateurs diffèrent.
pub fn json_python(v: &Value) -> String {
    let mut octets = Vec::new();
    let mut ser = Serializer::with_formatter(&mut octets, FormatPython);
    serde::Serialize::serialize(v, &mut ser).expect("sérialisation d'une Value en mémoire");
    String::from_utf8(octets).expect("serde_json écrit de l'UTF-8")
}

/// Invite utilisateur de `generate_additive_extraction_prompt` (S-2, étape 5).
/// `derniers` : `(role, content)` du plus ancien au plus récent ; `existants` :
/// textes des souvenirs par cosinus décroissant ; `date` : `AAAA-MM-JJ` UTC.
pub fn invite_utilisateur(derniers: &[(String, String)], existants: &[String], texte: &str, date: &str) -> String {
    let mut historique = String::new();
    for (role, contenu) in derniers.iter().filter(|(r, c)| !r.is_empty() && !c.is_empty()) {
        historique.push_str(&format!("{role}: {}\n", tronque_300(contenu)));
    }
    let existants: Vec<Value> =
        existants.iter().enumerate().map(|(i, t)| json!({ "id": i.to_string(), "text": t })).collect();
    format!(
        "## Summary\n\n\n## Last k Messages\n{historique}\n\n## Recently Extracted Memories\n[]\n\n## Existing Memories\n{}\n\n## New Messages\nuser: {texte}\n\n\n## Observation Date\n{date}\n\n## Current Date\n{date}\n\n## Custom Instructions\n{CUSTOM_INSTRUCTIONS}\n\n# Output:",
        json_python(&Value::Array(existants))
    )
}

/// Contenu lu dans `choices[0].message.content` (S-1) : une chaîne telle quelle,
/// un tableau concaténé (chaînes et `text` chaîne des objets), sinon `""`.
pub fn contenu_reponse(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocs) => blocs
            .iter()
            .filter_map(|b| match b {
                Value::String(s) => Some(s.as_str()),
                Value::Object(o) => o.get("text").and_then(Value::as_str),
                _ => None,
            })
            .collect(),
        _ => String::new(),
    }
}

/// `remove_code_blocks` : bloc ```…``` englobant retiré, puis `<think>…</think>`.
pub fn retirer_blocs(contenu: &str) -> String {
    let s = strip_python(contenu);
    let g = bloc_englobant(s).map_or(s, strip_python);
    strip_python(&sans_think(g)).to_owned()
}

/// `re.match(r"^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$", s)` sur `s` déjà strippé.
fn bloc_englobant(s: &str) -> Option<&str> {
    const FIN: &str = "\n```";
    let corps = s.strip_prefix(BALISES)?.trim_start_matches(|c: char| c.is_ascii_alphanumeric()).strip_prefix('\n')?;
    let debut = s.len() - corps.len();
    let fin = s.len() - FIN.len();
    (s.ends_with(FIN) && debut <= fin).then(|| &s[debut..fin])
}

/// `re.sub(r"<think>.*?</think>", "", s, flags=re.DOTALL)`.
fn sans_think(s: &str) -> String {
    const OUVRE: &str = "<think>";
    const FERME: &str = "</think>";
    let mut sortie = String::with_capacity(s.len());
    let mut reste = s;
    while let Some(i) = reste.find(OUVRE) {
        let Some(j) = reste[i + OUVRE.len()..].find(FERME) else { break };
        sortie.push_str(&reste[..i]);
        reste = &reste[i + OUVRE.len() + j + FERME.len()..];
    }
    sortie.push_str(reste);
    sortie
}

/// `extract_json` : le premier bloc ```` ```(json)? … ``` ````, sinon du premier
/// `{` au dernier `}`, sinon le texte (strippé).
pub fn extraire_json(texte: &str) -> String {
    let t = strip_python(texte);
    if let Some(groupe) = bloc_interne(t) {
        return groupe.to_owned();
    }
    match (t.find('{'), t.rfind('}')) {
        (Some(debut), Some(fin)) if fin > debut => t[debut..=fin].to_owned(),
        _ => t.to_owned(),
    }
}

/// `re.search(r"```(?:json)?\s*(.*?)\s*```", t, re.DOTALL).group(1)`.
///
/// Seule la première occurrence de ```` ``` ```` peut ouvrir : si aucune balise
/// ne la suit, aucune ne suit les suivantes. Le groupe paresseux s'arrête au
/// premier ```` ``` ```` suivant, blancs qui le précèdent exclus.
fn bloc_interne(t: &str) -> Option<&str> {
    let ouverture = t.find(BALISES)? + BALISES.len();
    let apres = &t[ouverture..];
    let apres = apres.strip_prefix("json").filter(|r| r.contains(BALISES)).unwrap_or(apres);
    let corps = apres.trim_start_matches(blanc_python);
    let fermeture = corps.find(BALISES)?;
    Some(corps[..fermeture].trim_end_matches(blanc_python))
}

/// `json.loads(s, strict=False)` : les caractères U+0000..U+001F bruts dans une
/// chaîne sont admis et gardés ; une donnée après la valeur est un échec.
pub fn lire_json_tolerant(s: &str) -> Option<Value> {
    let mut echappe = String::with_capacity(s.len());
    let (mut dans_chaine, mut apres_barre) = (false, false);
    for c in s.chars() {
        if dans_chaine {
            if apres_barre {
                apres_barre = false;
            } else if c == '\\' {
                apres_barre = true;
            } else if c == '"' {
                dans_chaine = false;
            } else if c < '\u{20}' {
                echappe.push_str(&format!("\\u{:04x}", u32::from(c)));
                continue;
            }
        } else if c == '"' {
            dans_chaine = true;
        }
        echappe.push(c);
    }
    serde_json::from_str(&echappe).ok()
}

/// Verdict de la lecture d'une réponse LLM (S-3).
#[derive(Debug, PartialEq)]
pub enum Lecture {
    /// Liste falsy : 200 `{"results":[]}`, message sauvé.
    Vide,
    /// Réponse illisible (JSON invalide ou non objet) : traitée comme [`Lecture::Vide`],
    /// avec la raison à journaliser (`logger.error` de mem0).
    Illisible(&'static str),
    /// `memory` truthy qui n'est pas une liste d'objets : 500, rien d'écrit.
    Invalide,
    /// Les éléments (objets) de `memory`, dans l'ordre.
    Elements(Vec<Map<String, Value>>),
}

/// Lit le contenu `contenu` d'une réponse chat (S-3).
pub fn lire_faits(contenu: &str) -> Lecture {
    let r = retirer_blocs(contenu);
    if r.is_empty() {
        return Lecture::Vide;
    }
    let Some(p) = lire_json_tolerant(&r).or_else(|| lire_json_tolerant(&extraire_json(&r))) else {
        return Lecture::Illisible("réponse LLM non JSON");
    };
    let Value::Object(mut p) = p else {
        return Lecture::Illisible("réponse LLM JSON qui n'est pas un objet");
    };
    let memoire = p.remove("memory").unwrap_or(Value::Null);
    if !truthy(&memoire) {
        return Lecture::Vide;
    }
    let Value::Array(elements) = memoire else {
        return Lecture::Invalide;
    };
    elements
        .into_iter()
        .map(|e| match e {
            Value::Object(o) => Some(o),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .map_or(Lecture::Invalide, Lecture::Elements)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn sha256(s: &str) -> String {
        Sha256::digest(s.as_bytes()).iter().map(|o| format!("{o:02x}")).collect()
    }

    fn elements(v: Value) -> Lecture {
        Lecture::Elements(v.as_array().unwrap().iter().map(|e| e.as_object().unwrap().clone()).collect())
    }

    #[test]
    fn ac2_invites_copiees_octet_pour_octet() {
        assert_eq!(sha256(ADDITIVE_EXTRACTION_PROMPT), "ad19187a37813ef77ee156e714c0650e6ec749e0264bdc07d499bc9b24115155");
        assert_eq!(ADDITIVE_EXTRACTION_PROMPT.len(), 33_831);
        assert_eq!(sha256(CUSTOM_INSTRUCTIONS), "ac517ad66970a8c737a07d8751eea46e8de0f32f59e271ab37f2254f6903d8d5");
        assert_eq!(CUSTOM_INSTRUCTIONS.chars().count(), 541);
        assert!(CUSTOM_INSTRUCTIONS.starts_with("Contexte : session de développement logiciel, pas conversation personnelle."));
    }

    #[test]
    fn ac2_portee_session() {
        assert_eq!(portee_session("moi", Some("ag-a"), None), "agent_id=ag-a&user_id=moi");
        assert_eq!(portee_session("moi", Some("a&b=c%"), None), "agent_id=a%26b%3Dc%25&user_id=moi");
        assert_eq!(portee_session("moi", None, None), "user_id=moi");
        assert_eq!(portee_session("moi", Some("a"), Some("r")), "agent_id=a&run_id=r&user_id=moi");
        assert_eq!(portee_session("moi", Some(""), Some("r")), "run_id=r&user_id=moi");
    }

    #[test]
    fn ac5_troncature_en_points_de_code() {
        assert_eq!(tronque_300(""), "");
        let juste = "é".repeat(300);
        assert_eq!(tronque_300(&juste), juste);
        assert_eq!(tronque_300(&format!("{juste}x")), format!("{juste}..."));
    }

    #[test]
    fn ac2_json_python() {
        assert_eq!(json_python(&json!([])), "[]");
        assert_eq!(
            json_python(&json!([{"id": "0", "text": "a\"b\\c\n\t\u{1}é/\u{7f}\u{2028}"}, {"id": "1", "text": "x"}])),
            "[{\"id\": \"0\", \"text\": \"a\\\"b\\\\c\\n\\t\\u0001é/\u{7f}\u{2028}\"}, {\"id\": \"1\", \"text\": \"x\"}]"
        );
        assert_eq!(json_python(&json!({"a": [1, {"b": null}], "c": true})), "{\"a\": [1, {\"b\": null}], \"c\": true}");
    }

    #[test]
    fn ac2_invite_premier_puis_second_appel() {
        let premier = invite_utilisateur(&[], &[], "Message de test pour b", "2026-10-12");
        assert_eq!(
            premier,
            format!(
                "## Summary\n\n\n## Last k Messages\n\n\n## Recently Extracted Memories\n[]\n\n## Existing Memories\n[]\n\n## New Messages\nuser: Message de test pour b\n\n\n## Observation Date\n2026-10-12\n\n## Current Date\n2026-10-12\n\n## Custom Instructions\n{CUSTOM_INSTRUCTIONS}\n\n# Output:"
            )
        );
        let derniers = vec![
            ("user".to_owned(), "Message de test pour a".to_owned()),
            ("".to_owned(), "sans rôle".to_owned()),
            ("user".to_owned(), "".to_owned()),
        ];
        let existants = vec!["La CI tourne sur ubuntu-latest".to_owned(), "Le dépôt cible bash 3.2".to_owned()];
        let second = invite_utilisateur(&derniers, &existants, "ligne 1\nligne 2", "2026-10-13");
        assert!(second.contains("## Last k Messages\nuser: Message de test pour a\n\n\n## Recently"), "{second}");
        assert!(second.contains(
            "## Existing Memories\n[{\"id\": \"0\", \"text\": \"La CI tourne sur ubuntu-latest\"}, {\"id\": \"1\", \"text\": \"Le dépôt cible bash 3.2\"}]\n\n"
        ));
        assert!(second.contains("## New Messages\nuser: ligne 1\nligne 2\n\n\n## Observation Date\n2026-10-13\n\n## Current Date\n2026-10-13\n\n"));
        assert!(invite_utilisateur(&[], &[], "", "d").contains("## New Messages\nuser: \n\n\n"));
    }

    #[test]
    fn ac1_contenu_reponse() {
        assert_eq!(contenu_reponse(&json!("abc")), "abc");
        assert_eq!(contenu_reponse(&json!(["a", {"text": "b"}, {"text": 5}, {"type": "x"}, 3, null, "c"])), "abc");
        assert_eq!(contenu_reponse(&Value::Null), "");
        assert_eq!(contenu_reponse(&json!(5)), "");
        assert_eq!(contenu_reponse(&json!({"text": "a"})), "");
    }

    #[test]
    fn ac1_retirer_blocs() {
        assert_eq!(retirer_blocs("  {\"a\":1} \u{1c}"), "{\"a\":1}");
        assert_eq!(retirer_blocs("```json\n<think>x</think>{\"m\":1}\n```"), "{\"m\":1}");
        assert_eq!(retirer_blocs("```\n  x  \n```"), "x");
        assert_eq!(retirer_blocs("```\n```"), "```\n```");
        assert_eq!(retirer_blocs("```js-x\nx\n```"), "```js-x\nx\n```");
        assert_eq!(retirer_blocs("```json\na\n```\nb\n```"), "a\n```\nb");
        assert_eq!(retirer_blocs("a<think>1\n2</think>b<think>3</think>c<think>ouvert"), "abc<think>ouvert");
        assert_eq!(retirer_blocs("<think>tout</think>"), "");
    }

    #[test]
    fn ac1_extraire_json() {
        assert_eq!(extraire_json("Voici: {\"memory\":[]} fin"), "{\"memory\":[]}");
        assert_eq!(extraire_json("avant ```json\n {\"a\":1} \n``` après ```x```"), "{\"a\":1}");
        assert_eq!(extraire_json("```{\"a\":1}```"), "{\"a\":1}");
        assert_eq!(extraire_json("```jsonx```"), "x");
        assert_eq!(extraire_json("```json```"), "");
        assert_eq!(extraire_json("`````"), "`````");
        assert_eq!(extraire_json("} rien {"), "} rien {");
        assert_eq!(extraire_json("  pas de json "), "pas de json");
    }

    #[test]
    fn ac5_json_tolerant() {
        assert_eq!(lire_json_tolerant("{\"text\":\"a\tb\nc\u{1}\"}"), Some(json!({"text": "a\tb\nc\u{1}"})));
        assert_eq!(lire_json_tolerant("{\"t\":\"\\\"\t\\\\\"}"), Some(json!({"t": "\"\t\\"})));
        assert_eq!(lire_json_tolerant("{\"a\":1,\"a\":2}"), Some(json!({"a": 2})));
        assert_eq!(lire_json_tolerant(" \n{\"a\":1}\t"), Some(json!({"a": 1})));
        assert_eq!(lire_json_tolerant("{\"a\":1} trailing"), None);
        assert_eq!(lire_json_tolerant("{\u{1}\"a\":1}"), None, "contrôle hors chaîne");
        assert_eq!(lire_json_tolerant("Pas de JSON"), None);
    }

    #[test]
    fn ac4_ac5_lire_faits_exemples_obligatoires() {
        for vide in [
            "Pas de JSON dans cette réponse.",
            "{\"faits\":[{\"text\":\"F\"}]}",
            "[\"a\"]",
            "{\"memory\":null}",
            "{\"memory\":[]}",
            "{\"memory\":{}}",
            "{\"memory\":0}",
            "{\"memory\":false}",
            "",
            "   ",
        ] {
            assert!(matches!(lire_faits(vide), Lecture::Vide | Lecture::Illisible(_)), "{vide:?}");
        }
        assert_eq!(lire_faits("Pas de JSON"), Lecture::Illisible("réponse LLM non JSON"));
        assert_eq!(lire_faits("{\"memory\":[]}"), Lecture::Vide);
        for invalide in [
            "{\"memory\":\"x\"}",
            "{\"memory\":5}",
            "{\"memory\":true}",
            "{\"memory\":{\"a\":1}}",
            "{\"memory\":[\"str\"]}",
            "{\"memory\":[{\"text\":\"a\"},null]}",
        ] {
            assert_eq!(lire_faits(invalide), Lecture::Invalide, "{invalide}");
        }
        let f = elements(json!([{"text": "F"}]));
        assert_eq!(lire_faits("```json\n<think>x</think>{\"memory\":[{\"text\":\"F\"}]}\n```"), f);
        assert_eq!(lire_faits("Voici: {\"memory\":[{\"text\":\"F\"}]} fin"), f);
        assert_eq!(lire_faits("{\"memory\":[{\"text\":\"F\"}]} trailing"), f);
        assert_eq!(lire_faits("{\"memory\":[{\"text\":\"a\tb\"}]}"), elements(json!([{"text": "a\tb"}])));
        assert_eq!(lire_faits("{\"memory\":[{\"nope\":1}]}"), elements(json!([{"nope": 1}])));
    }

    #[test]
    fn truthy_python() {
        for faux in [json!(null), json!(false), json!(0), json!(0.0), json!(-0.0), json!(""), json!([]), json!({})] {
            assert!(!truthy(&faux), "{faux}");
        }
        for vrai in [json!(true), json!(5), json!(0.5), json!(" "), json!([0]), json!({"a": null})] {
            assert!(truthy(&vrai), "{vrai}");
        }
    }
}
