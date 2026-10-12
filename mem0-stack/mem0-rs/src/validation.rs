//! Décodage manuel des corps de requête, façon FastAPI 0.142.2 + pydantic 2.13.5
//! (D-6) : décision 422 et corps `{"detail":[…]}` champ par champ, dans l'ordre de
//! déclaration des modèles de S-2.
//!
//! Le corps est lu comme JSON seulement si le content-type est `application/json`
//! ou `application/*+json` ; sinon pydantic reçoit les octets bruts.

use serde_json::{Map, Number, Value, json};

/// Rejet d'un corps.
#[derive(Debug, Clone, PartialEq)]
pub enum Rejet {
    /// 422 : les entrées de `detail`.
    Invalide(Vec<Value>),
    /// 400 `{"detail":"There was an error parsing the body"}` : octets JSON non UTF-8.
    CorpsIllisible,
    /// 500 : FastAPI échoue à sérialiser l'erreur (texte brut non UTF-8).
    Interne,
}

impl Rejet {
    /// Corps de la réponse 422.
    pub fn corps_422(entrees: &[Value]) -> Value {
        json!({ "detail": entrees })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AddRequest {
    pub text: String,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub tags: Option<String>,
    pub infer: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AddProcedureRequest {
    pub steps: String,
    pub agent_id: String,
}

/// Corps de POST /memory/search, lu par la recherche hybride (`recherche.rs`).
#[derive(Debug, Clone, PartialEq)]
pub struct SearchRequest {
    pub query: String,
    pub agent_id: Option<String>,
    /// Entier Python saturé aux bornes de i64 (un entier JSON plus grand est accepté).
    pub limit: i64,
    pub filters: Option<Map<String, Value>>,
    pub threshold: Option<f64>,
    pub explain: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UpdateRequest {
    pub text: String,
    /// `None` : champ absent ; `Some(v)` : présent (y compris `null`).
    pub tags: Option<Option<String>>,
}

/// Type JSON au sens de FastAPI : `application/json` ou `application/*+json`.
fn content_type_json(content_type: Option<&[u8]>) -> bool {
    let Some(brut) = content_type.and_then(|c| std::str::from_utf8(c).ok()) else {
        return false;
    };
    // email.message : le type est avant `;`, en minuscules ; un type sans un
    // unique `/` vaut `text/plain`.
    let type_ = brut.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let mut parties = type_.split('/');
    let (Some(principal), Some(sous), None) = (parties.next(), parties.next(), parties.next()) else {
        return false;
    };
    principal == "application" && (sous == "json" || sous.ends_with("+json"))
}

/// Position du décodeur JSON de Python (index en caractères) pour une erreur serde.
fn position_erreur(texte: &str, e: &serde_json::Error) -> usize {
    if e.is_eof() {
        return texte.chars().count();
    }
    // serde compte les lignes à partir de 1 et les colonnes en octets à partir de 1.
    // Approximation de la position de Python (le message reste libre, S-2).
    let mut debut_ligne = 0usize;
    for _ in 1..e.line() {
        match texte[debut_ligne..].find('\n') {
            Some(i) => debut_ligne += i + 1,
            None => break,
        }
    }
    let mut octet = (debut_ligne + e.column().saturating_sub(1)).min(texte.len());
    while !texte.is_char_boundary(octet) {
        octet -= 1;
    }
    let message = e.to_string();
    let debut = if ["invalid number", "invalid escape", "trailing comma", "control character"]
        .iter()
        .any(|p| message.starts_with(p))
    {
        // serde a déjà consommé le caractère que Python désigne.
        texte[..octet].char_indices().next_back().map_or(0, |(i, _)| i)
    } else {
        // Python désigne le début du littéral fautif (`tru`, `not`).
        texte[..octet].trim_end_matches(|c: char| c.is_ascii_alphanumeric()).len()
    };
    texte[..debut].chars().count()
}

/// Corps → objet JSON, ou rejet selon les premières lignes de la table D-6.
fn objet(content_type: Option<&[u8]>, corps: &[u8]) -> Result<Map<String, Value>, Rejet> {
    if corps.is_empty() {
        return Err(Rejet::Invalide(vec![erreur("missing", &[], "Field required", Value::Null)]));
    }
    let valeur = if content_type_json(content_type) {
        let sans_bom = corps.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(corps);
        let texte = std::str::from_utf8(sans_bom).map_err(|_| Rejet::CorpsIllisible)?;
        match serde_json::from_str::<Value>(texte) {
            Ok(v) => v,
            Err(e) => {
                return Err(Rejet::Invalide(vec![json!({
                    "type": "json_invalid",
                    "loc": ["body", position_erreur(texte, &e)],
                    "msg": "JSON decode error",
                    "input": {},
                    "ctx": { "error": e.to_string() },
                })]));
            }
        }
    } else {
        let texte = std::str::from_utf8(corps).map_err(|_| Rejet::Interne)?;
        Value::String(texte.to_owned())
    };
    match valeur {
        Value::Object(m) => Ok(m),
        Value::Null => Err(Rejet::Invalide(vec![erreur("missing", &[], "Field required", Value::Null)])),
        autre => Err(Rejet::Invalide(vec![erreur(
            "model_attributes_type",
            &[],
            "Input should be a valid dictionary or object to extract fields from",
            autre,
        )])),
    }
}

fn erreur(type_: &str, loc: &[&str], msg: &str, input: Value) -> Value {
    let mut chemin = vec![Value::from("body")];
    chemin.extend(loc.iter().map(|c| Value::from(*c)));
    json!({ "type": type_, "loc": chemin, "msg": msg, "input": input })
}

/// Erreur d'un champ : `(type, msg)`.
type ErreurChamp = (&'static str, &'static str);

const STRING_TYPE: ErreurChamp = ("string_type", "Input should be a valid string");
const INT_TYPE: ErreurChamp = ("int_type", "Input should be a valid integer");
const INT_PARSING: ErreurChamp = ("int_parsing", "Input should be a valid integer, unable to parse string as an integer");
const INT_FROM_FLOAT: ErreurChamp =
    ("int_from_float", "Input should be a valid integer, got a number with a fractional part");
const INT_PARSING_SIZE: ErreurChamp =
    ("int_parsing_size", "Unable to parse input string as an integer, exceeded maximum size");
const BOOL_TYPE: ErreurChamp = ("bool_type", "Input should be a valid boolean");
const BOOL_PARSING: ErreurChamp = ("bool_parsing", "Input should be a valid boolean, unable to interpret input");
const FLOAT_TYPE: ErreurChamp = ("float_type", "Input should be a valid number");
const FLOAT_PARSING: ErreurChamp = ("float_parsing", "Input should be a valid number, unable to parse string as a number");
const DICT_TYPE: ErreurChamp = ("dict_type", "Input should be a valid dictionary");

/// Un littéral JSON entier (sans `.` ni exposant) ?
fn litteral_entier(n: &Number) -> bool {
    !n.to_string().contains(['.', 'e', 'E'])
}

/// Entier Python borné à i64 (saturation : seuls des comparaisons s'en servent).
fn entier_sature(chiffres_signes: &str) -> i64 {
    chiffres_signes.parse::<i64>().unwrap_or(if chiffres_signes.starts_with('-') { i64::MIN } else { i64::MAX })
}

/// Chiffres ASCII séparés par des `_` isolés (littéral entier Python).
fn chiffres_python(s: &str) -> Option<String> {
    if s.is_empty() || s.starts_with('_') || s.ends_with('_') || s.contains("__") {
        return None;
    }
    s.bytes().all(|b| b.is_ascii_digit() || b == b'_').then(|| s.replace('_', ""))
}

/// Chaîne → entier, comme pydantic-core : blancs Unicode retirés, signe, `_`
/// entre chiffres, et une partie décimale faite seulement de zéros (`5.0`).
fn entier_depuis_chaine(s: &str) -> Option<i64> {
    let s = s.trim();
    let (signe, reste) = match s.as_bytes().first() {
        Some(b'+') => ("", &s[1..]),
        Some(b'-') => ("-", &s[1..]),
        _ => ("", s),
    };
    let (entiere, decimale) = match reste.split_once('.') {
        Some((e, d)) => (e, Some(d)),
        None => (reste, None),
    };
    if let Some(d) = decimale
        && (d.is_empty() || !d.bytes().all(|b| b == b'0'))
    {
        return None;
    }
    let chiffres = chiffres_python(entiere)?;
    Some(entier_sature(&format!("{signe}{chiffres}")))
}

/// Chaîne → flottant, comme pydantic-core : blancs retirés, `_` isolés entre
/// caractères retirés, puis la syntaxe flottante de Rust (`inf`, `nan` compris).
fn flottant_depuis_chaine(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.contains('_') && (s.starts_with('_') || s.ends_with('_') || s.contains("__")) {
        return None;
    }
    s.replace('_', "").parse::<f64>().ok()
}

fn valider_str(v: &Value) -> Result<String, ErreurChamp> {
    match v {
        Value::String(s) => Ok(s.clone()),
        _ => Err(STRING_TYPE),
    }
}

fn valider_int(v: &Value) -> Result<i64, ErreurChamp> {
    match v {
        Value::Bool(b) => Ok(i64::from(*b)),
        Value::Number(n) if litteral_entier(n) => Ok(entier_sature(&n.to_string())),
        Value::Number(n) => {
            let f = n.as_f64().ok_or(INT_PARSING_SIZE)?;
            if !f.is_finite() {
                Err(INT_PARSING_SIZE)
            } else if f.fract() != 0.0 {
                Err(INT_FROM_FLOAT)
            } else if !(-9_223_372_036_854_775_808.0..9_223_372_036_854_775_808.0).contains(&f) {
                Err(INT_PARSING_SIZE)
            } else {
                // Intervalle vérifié juste au-dessus : la conversion est exacte.
                Ok(f as i64)
            }
        }
        Value::String(s) => entier_depuis_chaine(s).ok_or(INT_PARSING),
        _ => Err(INT_TYPE),
    }
}

fn valider_bool(v: &Value) -> Result<bool, ErreurChamp> {
    match v {
        Value::Bool(b) => Ok(*b),
        Value::Number(n) if litteral_entier(n) => match n.as_i64() {
            Some(0) => Ok(false),
            Some(1) => Ok(true),
            Some(_) => Err(BOOL_PARSING),
            None => Err(BOOL_TYPE),
        },
        Value::Number(n) => match n.as_f64() {
            Some(0.0) => Ok(false),
            Some(1.0) => Ok(true),
            Some(f) if f.is_finite() && f.fract() == 0.0 => Err(BOOL_PARSING),
            _ => Err(BOOL_TYPE),
        },
        Value::String(s) => match s.to_lowercase().as_str() {
            "0" | "off" | "f" | "false" | "n" | "no" => Ok(false),
            "1" | "on" | "t" | "true" | "y" | "yes" => Ok(true),
            _ => Err(BOOL_PARSING),
        },
        _ => Err(BOOL_TYPE),
    }
}

fn valider_float(v: &Value) -> Result<f64, ErreurChamp> {
    match v {
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        Value::Number(n) => n.as_f64().ok_or(FLOAT_PARSING),
        Value::String(s) => flottant_depuis_chaine(s).ok_or(FLOAT_PARSING),
        _ => Err(FLOAT_TYPE),
    }
}

fn valider_dict(v: &Value) -> Result<Map<String, Value>, ErreurChamp> {
    match v {
        Value::Object(m) => Ok(m.clone()),
        _ => Err(DICT_TYPE),
    }
}

/// Lecteur de champs qui accumule les erreurs dans l'ordre des appels.
struct Champs<'a> {
    objet: &'a Map<String, Value>,
    erreurs: Vec<Value>,
}

impl<'a> Champs<'a> {
    fn new(objet: &'a Map<String, Value>) -> Self {
        Champs { objet, erreurs: Vec::new() }
    }

    fn noter<T>(&mut self, nom: &str, v: &Value, r: Result<T, ErreurChamp>) -> Option<T> {
        r.map_err(|(t, m)| self.erreurs.push(erreur(t, &[nom], m, v.clone()))).ok()
    }

    /// Champ requis.
    fn requis<T>(&mut self, nom: &str, valider: fn(&Value) -> Result<T, ErreurChamp>) -> Option<T> {
        match self.objet.get(nom) {
            None => {
                let tout = Value::Object(self.objet.clone());
                self.erreurs.push(erreur("missing", &[nom], "Field required", tout));
                None
            }
            Some(v) => self.noter(nom, v, valider(v)),
        }
    }

    /// Champ à défaut non nul : absent → `defaut`, `null` → erreur de type.
    fn defaut<T>(&mut self, nom: &str, defaut: T, valider: fn(&Value) -> Result<T, ErreurChamp>) -> Option<T> {
        match self.objet.get(nom) {
            None => Some(defaut),
            Some(v) => self.noter(nom, v, valider(v)),
        }
    }

    /// Champ `T | None = None` : `Some(None)` si absent ou `null`.
    fn optionnel<T>(&mut self, nom: &str, valider: fn(&Value) -> Result<T, ErreurChamp>) -> Option<Option<T>> {
        self.present(nom, valider).map(Option::flatten)
    }

    /// Comme `optionnel`, en distinguant absent (`Some(None)`) de présent (`Some(Some(_))`).
    fn present<T>(
        &mut self,
        nom: &str,
        valider: fn(&Value) -> Result<T, ErreurChamp>,
    ) -> Option<Option<Option<T>>> {
        match self.objet.get(nom) {
            None => Some(None),
            Some(Value::Null) => Some(Some(None)),
            Some(v) => self.noter(nom, v, valider(v)).map(|t| Some(Some(t))),
        }
    }

    fn fin<T>(self, modele: Option<T>) -> Result<T, Rejet> {
        match modele {
            Some(m) if self.erreurs.is_empty() => Ok(m),
            _ => Err(Rejet::Invalide(self.erreurs)),
        }
    }
}

pub fn add(content_type: Option<&[u8]>, corps: &[u8]) -> Result<AddRequest, Rejet> {
    let o = objet(content_type, corps)?;
    let mut c = Champs::new(&o);
    let text = c.requis("text", valider_str);
    let agent_id = c.optionnel("agent_id", valider_str);
    let run_id = c.optionnel("run_id", valider_str);
    let tags = c.optionnel("tags", valider_str);
    let infer = c.defaut("infer", true, valider_bool);
    let modele = (|| Some(AddRequest { text: text?, agent_id: agent_id?, run_id: run_id?, tags: tags?, infer: infer? }))();
    c.fin(modele)
}

pub fn add_procedure(content_type: Option<&[u8]>, corps: &[u8]) -> Result<AddProcedureRequest, Rejet> {
    let o = objet(content_type, corps)?;
    let mut c = Champs::new(&o);
    let steps = c.requis("steps", valider_str);
    let agent_id = c.requis("agent_id", valider_str);
    let modele = (|| Some(AddProcedureRequest { steps: steps?, agent_id: agent_id? }))();
    c.fin(modele)
}

pub fn search(content_type: Option<&[u8]>, corps: &[u8]) -> Result<SearchRequest, Rejet> {
    let o = objet(content_type, corps)?;
    let mut c = Champs::new(&o);
    let query = c.requis("query", valider_str);
    let agent_id = c.optionnel("agent_id", valider_str);
    let limit = c.defaut("limit", 5, valider_int);
    let filters = c.optionnel("filters", valider_dict);
    let threshold = c.optionnel("threshold", valider_float);
    let explain = c.defaut("explain", false, valider_bool);
    let modele = (|| {
        Some(SearchRequest {
            query: query?,
            agent_id: agent_id?,
            limit: limit?,
            filters: filters?,
            threshold: threshold?,
            explain: explain?,
        })
    })();
    c.fin(modele)
}

pub fn update(content_type: Option<&[u8]>, corps: &[u8]) -> Result<UpdateRequest, Rejet> {
    let o = objet(content_type, corps)?;
    let mut c = Champs::new(&o);
    let text = c.requis("text", valider_str);
    let tags = c.present("tags", valider_str);
    let modele = (|| Some(UpdateRequest { text: text?, tags: tags? }))();
    c.fin(modele)
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: Option<&[u8]> = Some(b"application/json");

    fn detail(r: Result<impl std::fmt::Debug, Rejet>) -> Value {
        match r {
            Err(Rejet::Invalide(e)) => Value::Array(e),
            autre => panic!("422 attendu, reçu {autre:?}"),
        }
    }

    fn une(type_: &str, loc: Value, msg: &str, input: Value) -> Value {
        json!([{ "type": type_, "loc": loc, "msg": msg, "input": input }])
    }

    fn search_json(corps: &str) -> Result<SearchRequest, Rejet> {
        search(JSON, corps.as_bytes())
    }

    fn champ(f: &str, v: &str) -> Value {
        detail(search_json(&format!(r#"{{"query":"x","{f}":{v}}}"#)))
    }

    #[test]
    fn d6_corps_vide() {
        let attendu = une("missing", json!(["body"]), "Field required", Value::Null);
        assert_eq!(detail(search(JSON, b"")), attendu);
        assert_eq!(detail(search(None, b"")), attendu);
        assert_eq!(detail(search_json("null")), attendu);
    }

    #[test]
    fn d6_json_invalide() {
        let d = detail(search_json("not json"));
        assert_eq!(d[0]["type"], "json_invalid");
        assert_eq!(d[0]["loc"], json!(["body", 0]));
        assert_eq!(d[0]["msg"], "JSON decode error");
        assert_eq!(d[0]["input"], json!({}));
        assert!(d[0]["ctx"]["error"].is_string());
        let cles: Vec<&String> = d[0].as_object().unwrap().keys().collect();
        assert_eq!(cles, ["type", "loc", "msg", "input", "ctx"]);
        // Positions du décodeur Python : fin de texte, puis donnée en trop.
        assert_eq!(detail(search_json(r#"{"query":"#))[0]["loc"], json!(["body", 9]));
        assert_eq!(detail(search_json(" "))[0]["loc"], json!(["body", 1]));
        assert_eq!(detail(search_json(r#"{"query":"x"} x"#))[0]["loc"], json!(["body", 14]));
    }

    #[test]
    fn d6_corps_non_objet_ou_content_type() {
        let msg = "Input should be a valid dictionary or object to extract fields from";
        assert_eq!(detail(search_json("[1]")), une("model_attributes_type", json!(["body"]), msg, json!([1])));
        assert_eq!(detail(search_json(r#""s""#)), une("model_attributes_type", json!(["body"]), msg, json!("s")));
        let brut = r#"{"query":"x"}"#;
        for ct in [None, Some(&b"text/plain"[..]), Some(b"application/json-patch"), Some(b"json")] {
            assert_eq!(
                detail(search(ct, brut.as_bytes())),
                une("model_attributes_type", json!(["body"]), msg, json!(brut)),
                "{ct:?}"
            );
        }
        for ct in [&b"application/vnd.a+json; charset=utf-8"[..], b"APPLICATION/JSON", b"application/json;charset=utf-8"] {
            assert!(search(Some(ct), brut.as_bytes()).is_ok());
        }
        assert_eq!(search(None, b"\xff\xfe"), Err(Rejet::Interne));
        assert_eq!(search(JSON, b"\xff\xfe"), Err(Rejet::CorpsIllisible));
        assert_eq!(search(JSON, "\u{feff}{\"query\":\"x\"}".as_bytes()).unwrap().query, "x");
    }

    #[test]
    fn d6_champ_requis_absent() {
        assert_eq!(detail(search_json("{}")), une("missing", json!(["body", "query"]), "Field required", json!({})));
        let d = detail(add_procedure(JSON, br#"{"x":1}"#));
        assert_eq!(d.as_array().unwrap().len(), 2);
        assert_eq!(d[0]["loc"], json!(["body", "steps"]));
        assert_eq!(d[1]["loc"], json!(["body", "agent_id"]));
        assert_eq!(d[1]["input"], json!({"x":1}));
    }

    #[test]
    fn d6_string_type() {
        for v in ["1", "true", "1.5", "[]", "{}"] {
            assert_eq!(
                champ("agent_id", v),
                une("string_type", json!(["body", "agent_id"]), "Input should be a valid string", serde_json::from_str(v).unwrap())
            );
        }
        assert_eq!(detail(add(JSON, br#"{"text":null}"#))[0]["type"], "string_type");
    }

    #[test]
    fn d6_int() {
        let loc = json!(["body", "limit"]);
        let m = "Input should be a valid integer, got a number with a fractional part";
        assert_eq!(champ("limit", "1.5"), une("int_from_float", loc.clone(), m, json!(1.5)));
        assert_eq!(champ("limit", "1e-300")[0]["type"], "int_from_float");
        let m = "Input should be a valid integer, unable to parse string as an integer";
        for v in [r#""5.5""#, r#""abc""#, r#""""#, r#""0x10""#, r#""1e3""#, r#""5.""#, r#""1__0""#, r#""_1""#, r#""5.0_0""#, r#""٣""#, r#""\u001c7""#] {
            assert_eq!(champ("limit", v), une("int_parsing", loc.clone(), m, serde_json::from_str(v).unwrap()), "{v}");
        }
        for v in ["null", "{}", "[]"] {
            assert_eq!(champ("limit", v), une("int_type", loc.clone(), "Input should be a valid integer", serde_json::from_str(v).unwrap()));
        }
        let m = "Unable to parse input string as an integer, exceeded maximum size";
        for v in ["1.5e300", "1e20", "9.3e18", "-1.5e300"] {
            let d = champ("limit", v);
            assert_eq!(d[0]["type"], "int_parsing_size", "{v}");
            assert_eq!(d[0]["msg"], m);
        }
    }

    #[test]
    fn d6_int_coercitions() {
        let l = |v: &str| search_json(&format!(r#"{{"query":"x","limit":{v}}}"#)).unwrap().limit;
        assert_eq!(l(r#""5""#), 5);
        assert_eq!(l(r#"" 7 ""#), 7);
        assert_eq!(l(r#""\n7\t""#), 7);
        assert_eq!(l(r#""\u00a07""#), 7);
        assert_eq!(l("5.0"), 5);
        assert_eq!(l("1e3"), 1000);
        assert_eq!(l("-0.0"), 0);
        assert_eq!(l("true"), 1);
        assert_eq!(l("false"), 0);
        assert_eq!(l(r#""5.00""#), 5);
        assert_eq!(l(r#""1_000""#), 1000);
        assert_eq!(l(r#""5_0.0""#), 50);
        assert_eq!(l(r#""+3""#), 3);
        assert_eq!(l(r#""-3""#), -3);
        assert_eq!(l(r#""05""#), 5);
        assert_eq!(l("9.2e18"), 9_200_000_000_000_000_000);
        assert_eq!(l("99999999999999999999"), i64::MAX);
        assert_eq!(l(r#""99999999999999999999""#), i64::MAX);
        assert_eq!(l("-9223372036854775809"), i64::MIN);
        assert_eq!(search_json(r#"{"query":"x"}"#).unwrap().limit, 5);
    }

    #[test]
    fn d6_bool() {
        let loc = json!(["body", "explain"]);
        let m = "Input should be a valid boolean, unable to interpret input";
        for v in [r#""ok""#, r#"" yes""#, r#""""#, r#""0.0""#, "2", "-1", "5.0"] {
            assert_eq!(champ("explain", v), une("bool_parsing", loc.clone(), m, serde_json::from_str(v).unwrap()), "{v}");
        }
        for v in ["null", "{}", "[]", "1.5", "100000000000000000000"] {
            assert_eq!(champ("explain", v)[0]["type"], "bool_type", "{v}");
            assert_eq!(champ("explain", v)[0]["msg"], "Input should be a valid boolean");
        }
        let b = |v: &str| search_json(&format!(r#"{{"query":"x","explain":{v}}}"#)).unwrap().explain;
        for v in ["true", "1", "1.0", "1e0", r#""1""#, r#""on""#, r#""T""#, r#""TRUE""#, r#""y""#, r#""Yes""#] {
            assert!(b(v), "{v}");
        }
        for v in ["false", "0", "0.0", "-0.0", r#""0""#, r#""Off""#, r#""f""#, r#""false""#, r#""n""#, r#""nO""#] {
            assert!(!b(v), "{v}");
        }
        assert!(add(JSON, br#"{"text":"a"}"#).unwrap().infer);
    }

    #[test]
    fn d6_float() {
        let loc = json!(["body", "threshold"]);
        let m = "Input should be a valid number, unable to parse string as a number";
        for v in [r#""abc""#, r#""1__0""#, r#""1e""#, r#""0x1""#, r#""1_""#, r#""_1""#, r#""in f""#, r#""""#, r#"".""#, r#""null""#, r#""٣""#] {
            assert_eq!(champ("threshold", v), une("float_parsing", loc.clone(), m, serde_json::from_str(v).unwrap()), "{v}");
        }
        for v in ["{}", "[]"] {
            assert_eq!(champ("threshold", v), une("float_type", loc.clone(), "Input should be a valid number", serde_json::from_str(v).unwrap()));
        }
        let t = |v: &str| search_json(&format!(r#"{{"query":"x","threshold":{v}}}"#)).unwrap().threshold;
        assert_eq!(t("null"), None);
        assert_eq!(t("0.5"), Some(0.5));
        assert_eq!(t("1"), Some(1.0));
        assert_eq!(t("true"), Some(1.0));
        assert_eq!(t("false"), Some(0.0));
        assert_eq!(t(r#""1e-3""#), Some(0.001));
        assert_eq!(t(r#"" 0.5 ""#), Some(0.5));
        assert_eq!(t(r#""1_0""#), Some(10.0));
        assert_eq!(t(r#""+.5""#), Some(0.5));
        assert_eq!(t(r#""5.""#), Some(5.0));
        assert_eq!(t(r#""1.5E+3""#), Some(1500.0));
        assert!(t(r#""inf""#).unwrap().is_infinite());
        assert!(t(r#""nan""#).unwrap().is_nan());
        let grand = "12345678901234567890123456789012345678901234567890";
        assert_eq!(t(grand), grand.parse::<f64>().ok());
    }

    #[test]
    fn d6_positions_json_invalid() {
        // Positions mesurées avec `json.loads` de Python 3.14.
        let mut ecarts = Vec::new();
        for (texte, pos) in [
            ("not json", 0),
            (r#"{"a":tru}"#, 5),
            ("{a}", 1),
            (r#"{"a":1 2}"#, 7),
            (r#"{"a":1.}"#, 6),
            ("[1,]", 2),
            ("{\"a\":\"x\n\"}", 7),
            (r#"{"a":1,}"#, 6),
            (r#"{"é":"è" x}"#, 9),
            ("\n\n  {\"a\"", 8),
            (r#"{"a":-}"#, 5),
            (r#"{"a":"\q"}"#, 6),
            ("}", 0),
            (r#"{"a":nul}"#, 5),
        ] {
            let e = serde_json::from_str::<Value>(texte).unwrap_err();
            let obtenu = position_erreur(texte, &e);
            if obtenu != pos {
                ecarts.push(format!("{texte:?} : {obtenu} au lieu de {pos} ({e})"));
            }
        }
        assert!(ecarts.is_empty(), "{ecarts:#?}");
    }

    #[test]
    fn d6_float_requis_null() {
        // Un float non optionnel reçoit null : float_type. Aucun modèle de S-2 n'en
        // a, d'où le test direct du validateur.
        assert_eq!(valider_float(&Value::Null), Err(FLOAT_TYPE));
    }

    #[test]
    fn d6_dict() {
        for v in ["[]", r#""a""#, "3"] {
            assert_eq!(
                champ("filters", v),
                une("dict_type", json!(["body", "filters"]), "Input should be a valid dictionary", serde_json::from_str(v).unwrap())
            );
        }
        assert_eq!(search_json(r#"{"query":"x","filters":null}"#).unwrap().filters, None);
        assert_eq!(search_json(r#"{"query":"x","filters":{"a":1}}"#).unwrap().filters.unwrap()["a"], 1);
    }

    #[test]
    fn d6_ordre_des_champs() {
        let d = detail(search_json(r#"{"explain":[],"threshold":{},"filters":3,"limit":[],"agent_id":2,"query":1}"#));
        let types: Vec<&str> = d.as_array().unwrap().iter().map(|e| e["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["string_type", "string_type", "int_type", "dict_type", "float_type", "bool_type"]);
        let locs: Vec<&str> = d.as_array().unwrap().iter().map(|e| e["loc"][1].as_str().unwrap()).collect();
        assert_eq!(locs, ["query", "agent_id", "limit", "filters", "threshold", "explain"]);
        let cles: Vec<&String> = d[0].as_object().unwrap().keys().collect();
        assert_eq!(cles, ["type", "loc", "msg", "input"]);
    }

    #[test]
    fn d6_champs_inconnus_et_doublons() {
        assert_eq!(search_json(r#"{"query":"x","zzz":[1]}"#).unwrap().query, "x");
        assert_eq!(detail(search_json(r#"{"query":"a","query":2}"#))[0]["input"], 2);
    }

    #[test]
    fn update_tags_absent_ou_present() {
        assert_eq!(update(JSON, br#"{"text":"a"}"#).unwrap().tags, None);
        assert_eq!(update(JSON, br#"{"text":"a","tags":null}"#).unwrap().tags, Some(None));
        assert_eq!(update(JSON, br#"{"text":"a","tags":""}"#).unwrap().tags, Some(Some(String::new())));
        assert_eq!(detail(update(JSON, br#"{"text":"a","tags":5}"#))[0]["type"], "string_type");
    }

    #[test]
    fn add_modele() {
        let r = add(JSON, br#"{"text":"t","agent_id":"a","run_id":null,"tags":"x,y","infer":"no"}"#).unwrap();
        assert_eq!(
            r,
            AddRequest { text: "t".into(), agent_id: Some("a".into()), run_id: None, tags: Some("x,y".into()), infer: false }
        );
        let p = add_procedure(JSON, "{\"steps\":\"a\\u0000b\",\"agent_id\":\"\"}".as_bytes()).unwrap();
        assert_eq!(p.steps, "a\0b");
        assert_eq!(detail(add_procedure(JSON, br#"{"steps":"a","agent_id":null}"#))[0]["type"], "string_type");
    }
}
