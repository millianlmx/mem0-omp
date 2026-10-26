//! Consolidation (reve-memoire, phases 3 et 4) : observations et mental models.
//!
//! mem0-rs ne fait pas lui-même ces deux phases : elles demandent un modèle qui
//! raisonne sur des dizaines de souvenirs, alors que le LLM du serveur (oMLX) est
//! petit. Le harness les confie à une session omp, dont les modèles sont déjà
//! configurés : il lit le **dossier** d'une portée ([`dossier`], `GET
//! /memory/dream/dossier`), fait raisonner la session dessus, puis rend son
//! résultat ([`Consolidation`], `POST /memory/dream/consolidation`), que le
//! serveur valide ([`valider`]) et applique en une transaction ([`appliquer`]).
//!
//! - Une **observation** est un souvenir (`metadata.memory_type = "observation"`,
//!   étiquette `observation`) : une croyance consolidée, fondée sur des faits
//!   reliés par des liens `preuve`, affinée plutôt qu'écrasée quand un fait
//!   nouveau la précise ou la contredit. Elle se cherche comme un souvenir.
//! - Un **mental model** est une réponse permanente à une question fixe sur le
//!   projet ([`MODELES_DEFAUT`]), réécrite seulement quand sa portée a changé, lue
//!   d'un coup au démarrage d'une session (`GET /memory/models`).
//! - Le **filigrane** d'une portée (`consolidations.horizon_us`) dit jusqu'où ses
//!   faits ont été consolidés : un dossier ne rend que les faits plus récents.

use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::{self, NouveauSouvenir, Souvenir, Tags};
use crate::horodatage::Instant;
use crate::liens::{self, Lien, LienVu, PREUVE};
use crate::redaction::masquer;

/// Les questions des mental models d'une portée : (nom, question).
pub const MODELES_DEFAUT: [(&str, &str); 5] = [
    ("carte", "Quelle est l'architecture du projet : modules, rôles, flux principaux, et où vit chaque chose ?"),
    ("conventions", "Quelles conventions de nommage, de découpage, de tests et de commits ce dépôt applique-t-il ?"),
    ("decisions", "Quelles décisions d'architecture ont été prises, avec leur raison, et lesquelles ont été renversées ?"),
    ("pieges", "Quels bugs, pièges et fausses pistes connus faut-il éviter : symptôme, cause racine, correctif ?"),
    ("preferences", "Quelles préférences de travail l'utilisateur a-t-il exprimées ?"),
];

/// Faits nouveaux au plus par dossier ; au-delà, le filigrane avance jusqu'au
/// dernier rendu et la consolidation suivante prend la suite.
pub const NOUVEAUX_MAX: usize = 60;
/// Faits de contexte au plus (reliés aux nouveaux).
pub const CONTEXTE_MAX: usize = 60;
/// Observations rendues au plus.
pub const OBSERVATIONS_MAX: usize = 150;
/// Longueur maximale d'une observation, et d'un mental model, en caractères.
pub const OBSERVATION_MAX_CHARS: usize = 4_000;
pub const MODELE_MAX_CHARS: usize = 20_000;
/// Éléments au plus par consolidation, chaque liste.
pub const ELEMENTS_MAX: usize = 100;

/// Le souvenir est-il une observation ?
pub fn est_observation(s: &Souvenir) -> bool {
    s.metadata.as_ref().and_then(|m| m.get("memory_type")).and_then(Value::as_str) == Some("observation")
}

/// Un mental model tel que rendu : sa question, son contenu (vide s'il n'a jamais
/// été écrit), ses sources, sa date et s'il est périmé (un souvenir de la portée
/// a changé depuis, ou il n'a jamais été écrit alors que la portée a des souvenirs).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Modele {
    pub name: String,
    pub question: String,
    pub content: String,
    pub sources: Vec<String>,
    pub updated_at: Option<String>,
    pub stale: bool,
}

/// Les mental models de la portée : les questions par défaut, plus celles
/// qu'une consolidation a déjà écrites, dans l'ordre des défauts puis par nom.
pub fn modeles(conn: &Connection, user_id: &str, agent_id: Option<&str>) -> rusqlite::Result<Vec<Modele>> {
    let portee = liens::cle_portee(agent_id);
    let plus_recent: Option<i64> = conn.query_row(
        "SELECT max(updated_at_us) FROM memories WHERE user_id = ?1 AND agent_id IS ?2",
        params![user_id, agent_id],
        |r| r.get(0),
    )?;
    let mut stockes: BTreeMap<String, (String, String, String, String, i64)> = conn
        .prepare_cached("SELECT nom, question, contenu, sources, maj_at, maj_us FROM modeles WHERE agent_id = ?1")?
        .query_map([portee], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))))?
        .collect::<rusqlite::Result<_>>()?;
    let rendre = |nom: &str, question: &str, stocke: Option<(String, String, String, String, i64)>| match stocke {
        Some((question, contenu, sources, maj_at, maj_us)) => Modele {
            name: nom.to_owned(),
            question,
            content: contenu,
            sources: serde_json::from_str(&sources).unwrap_or_default(),
            updated_at: Some(maj_at),
            stale: plus_recent.is_some_and(|p| p > maj_us),
        },
        None => Modele {
            name: nom.to_owned(),
            question: question.to_owned(),
            content: String::new(),
            sources: Vec::new(),
            updated_at: None,
            stale: plus_recent.is_some(),
        },
    };
    let mut tous: Vec<Modele> =
        MODELES_DEFAUT.iter().map(|(nom, question)| rendre(nom, question, stockes.remove(*nom))).collect();
    tous.extend(stockes.into_iter().map(|(nom, s)| {
        let question = s.0.clone();
        rendre(&nom, &question, Some(s))
    }));
    Ok(tous)
}

/// Un fait du dossier.
#[derive(Debug, Clone, Serialize)]
pub struct FaitDossier {
    pub id: String,
    pub memory: String,
    pub tags: Option<String>,
    pub updated_at: String,
    pub entities: Vec<String>,
    pub links: Vec<LienVu>,
}

/// Une observation du dossier : ses preuves, et si l'une d'elles a changé depuis.
#[derive(Debug, Clone, Serialize)]
pub struct ObservationDossier {
    pub id: String,
    pub memory: String,
    pub updated_at: String,
    pub evidence: Vec<String>,
    pub stale: bool,
}

/// Ce que la session de consolidation reçoit pour une portée.
#[derive(Debug, Clone, Serialize)]
pub struct Dossier {
    pub agent_id: Option<String>,
    /// À renvoyer tel quel dans la consolidation : le filigrane avancera jusque-là.
    pub horizon_us: i64,
    /// Filigrane actuel (date du dernier fait consolidé), `None` si jamais consolidé.
    pub since: Option<String>,
    /// Y a-t-il des faits nouveaux à consolider ?
    pub due: bool,
    pub new_facts: Vec<FaitDossier>,
    pub context: Vec<FaitDossier>,
    pub observations: Vec<ObservationDossier>,
    pub models: Vec<Modele>,
}

/// Filigrane de la portée (`agent_id` NULL : clé vide), 0 si jamais consolidée.
pub fn filigrane(conn: &Connection, agent_id: Option<&str>) -> rusqlite::Result<i64> {
    Ok(conn
        .query_row("SELECT horizon_us FROM consolidations WHERE agent_id = ?1", [liens::cle_portee(agent_id)], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

/// Le dossier de consolidation de la portée `user_id`/`agent_id`.
pub fn dossier(conn: &Connection, user_id: &str, agent_id: Option<&str>) -> rusqlite::Result<Dossier> {
    let depuis = filigrane(conn, agent_id)?;
    let mut tous = db::tous(conn, user_id, agent_id)?;
    // `tous` ne rend pas les microsecondes : elles se relisent par id.
    let micros: HashMap<String, i64> = conn
        .prepare_cached("SELECT id, updated_at_us FROM memories WHERE user_id = ?1 AND agent_id IS ?2")?
        .query_map(params![user_id, agent_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    tous.sort_by_key(|s| (micros.get(&s.id).copied().unwrap_or(0), s.id.clone()));
    let (observations, faits): (Vec<Souvenir>, Vec<Souvenir>) = tous.into_iter().partition(est_observation);
    let mut nouveaux: Vec<&Souvenir> =
        faits.iter().filter(|s| micros.get(&s.id).copied().unwrap_or(0) > depuis).collect();
    nouveaux.truncate(NOUVEAUX_MAX);
    let horizon_us = match nouveaux.last() {
        Some(s) => micros.get(&s.id).copied().unwrap_or(depuis),
        None => depuis,
    };
    let ids_nouveaux: Vec<&str> = nouveaux.iter().map(|s| s.id.as_str()).collect();
    let par_id: HashMap<&str, &Souvenir> = faits.iter().map(|s| (s.id.as_str(), s)).collect();

    // Contexte : les faits reliés aux nouveaux (lien ou entité), les plus reliés d'abord.
    let mut connexions: HashMap<&str, usize> = HashMap::new();
    for l in liens::liens_touchant(conn, &ids_nouveaux)? {
        for bout in [l.source.as_str(), l.target.as_str()] {
            if let Some((id, _)) = par_id.get_key_value(bout) {
                *connexions.entry(id).or_default() += 1;
            }
        }
    }
    let entites = liens::entites_de(conn, &ids_nouveaux)?;
    let cles: HashSet<String> = entites.values().flatten().cloned().collect();
    let frequente = 3.max(faits.len() / 4);
    for porteurs in liens::porteurs_entites(conn, user_id, agent_id, &cles)?.values() {
        if porteurs.len() > frequente {
            continue;
        }
        for p in porteurs {
            if let Some((id, _)) = par_id.get_key_value(p.as_str()) {
                *connexions.entry(id).or_default() += 1;
            }
        }
    }
    let nouveaux_set: HashSet<&str> = ids_nouveaux.iter().copied().collect();
    let mut contexte: Vec<(&str, usize)> =
        connexions.into_iter().filter(|(id, _)| !nouveaux_set.contains(id)).collect();
    contexte.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    contexte.truncate(CONTEXTE_MAX);
    let ids_contexte: Vec<&str> = contexte.iter().map(|(id, _)| *id).collect();

    let tous_ids: Vec<&str> = ids_nouveaux.iter().chain(&ids_contexte).copied().collect();
    let entites = liens::entites_de(conn, &tous_ids)?;
    let vus = liens::liens_vus(conn, &tous_ids)?;
    let fait = |id: &str| -> FaitDossier {
        let s = par_id[id];
        FaitDossier {
            id: s.id.clone(),
            memory: s.memory.clone(),
            tags: s.tags.clone().flatten(),
            updated_at: s.updated_at.clone(),
            entities: entites.get(id).cloned().unwrap_or_default(),
            links: vus.get(id).cloned().unwrap_or_default().into_iter().filter(|l| l.type_ != PREUVE).collect(),
        }
    };

    let ids_observations: Vec<&str> = observations.iter().rev().take(OBSERVATIONS_MAX).map(|s| s.id.as_str()).collect();
    let mut preuves: HashMap<String, Vec<String>> = HashMap::new();
    for l in liens::liens_touchant(conn, &ids_observations)?.into_iter().filter(|l| l.type_ == PREUVE) {
        if ids_observations.contains(&l.source.as_str()) {
            preuves.entry(l.source).or_default().push(l.target);
        }
    }
    let observations = observations
        .iter()
        .rev()
        .take(OBSERVATIONS_MAX)
        .map(|o| {
            let evidence = preuves.remove(&o.id).unwrap_or_default();
            let date = micros.get(&o.id).copied().unwrap_or(0);
            let stale = evidence.iter().any(|p| micros.get(p).is_some_and(|&t| t > date));
            ObservationDossier { id: o.id.clone(), memory: o.memory.clone(), updated_at: o.updated_at.clone(), evidence, stale }
        })
        .collect();
    Ok(Dossier {
        agent_id: agent_id.map(str::to_owned),
        horizon_us,
        since: (depuis > 0).then(|| crate::horodatage::iso_depuis_micros(depuis)),
        due: !ids_nouveaux.is_empty(),
        new_facts: ids_nouveaux.iter().map(|id| fait(id)).collect(),
        context: ids_contexte.iter().map(|id| fait(id)).collect(),
        observations,
        models: modeles(conn, user_id, agent_id)?,
    })
}

/// Une observation à créer (`id` absent) ou à affiner (`id` d'une observation).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObservationRendue {
    #[serde(default)]
    pub id: Option<String>,
    pub text: String,
    pub evidence: Vec<String>,
}

/// Un lien de cause trouvé par la session : `source` explique `target`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CauseRendue {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Un mental model réécrit.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModeleRendu {
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub sources: Vec<String>,
}

/// Corps de `POST /memory/dream/consolidation`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Consolidation {
    #[serde(default)]
    pub agent_id: Option<String>,
    /// `horizon_us` du dossier consolidé.
    pub horizon_us: i64,
    #[serde(default)]
    pub observations: Vec<ObservationRendue>,
    /// Observations à retirer (périmées, fusionnées dans une autre).
    #[serde(default)]
    pub obsolete: Vec<String>,
    #[serde(default)]
    pub causes: Vec<CauseRendue>,
    #[serde(default)]
    pub models: Vec<ModeleRendu>,
}

/// Contrôle une consolidation contre la base ; `Err(message)` = 422, rien n'est écrit.
pub fn valider(conn: &Connection, user_id: &str, c: &Consolidation) -> Result<(), String> {
    let agent_id = c.agent_id.as_deref();
    let sqlite = |e: rusqlite::Error| format!("base : {e}");
    let portee: HashMap<String, Souvenir> =
        db::tous(conn, user_id, agent_id).map_err(sqlite)?.into_iter().map(|s| (s.id.clone(), s)).collect();
    let fait = |id: &str| portee.get(id).is_some_and(|s| !est_observation(s));
    let observation = |id: &str| portee.get(id).is_some_and(est_observation);
    if c.observations.len() > ELEMENTS_MAX || c.causes.len() > ELEMENTS_MAX || c.obsolete.len() > ELEMENTS_MAX {
        return Err(format!("au plus {ELEMENTS_MAX} observations, causes et retraits par consolidation"));
    }
    if c.horizon_us < 0 {
        return Err("horizon_us : entier positif ou nul attendu".to_owned());
    }
    for (i, o) in c.observations.iter().enumerate() {
        let n = o.text.trim().chars().count();
        if n == 0 || n > OBSERVATION_MAX_CHARS {
            return Err(format!("observations[{i}].text : 1 à {OBSERVATION_MAX_CHARS} caractères"));
        }
        if o.evidence.is_empty() {
            return Err(format!("observations[{i}].evidence : au moins un fait"));
        }
        if let Some(p) = o.evidence.iter().find(|p| !fait(p)) {
            return Err(format!("observations[{i}].evidence : {p} n'est pas un fait de la portée"));
        }
        if let Some(id) = &o.id
            && !observation(id)
        {
            return Err(format!("observations[{i}].id : {id} n'est pas une observation de la portée"));
        }
    }
    if let Some(id) = c.obsolete.iter().find(|id| !observation(id)) {
        return Err(format!("obsolete : {id} n'est pas une observation de la portée"));
    }
    let affinees: HashSet<&str> = c.observations.iter().filter_map(|o| o.id.as_deref()).collect();
    if let Some(id) = c.obsolete.iter().find(|id| affinees.contains(id.as_str())) {
        return Err(format!("obsolete : {id} est aussi affinée"));
    }
    for (i, cause) in c.causes.iter().enumerate() {
        if !portee.contains_key(&cause.source) || !portee.contains_key(&cause.target) || cause.source == cause.target {
            return Err(format!("causes[{i}] : deux souvenirs distincts de la portée attendus"));
        }
    }
    let noms: HashSet<String> = modeles(conn, user_id, agent_id).map_err(sqlite)?.into_iter().map(|m| m.name).collect();
    for (i, m) in c.models.iter().enumerate() {
        if !noms.contains(&m.name) {
            return Err(format!("models[{i}].name : {} n'est pas un mental model de la portée", m.name));
        }
        let n = m.content.trim().chars().count();
        if n == 0 || n > MODELE_MAX_CHARS {
            return Err(format!("models[{i}].content : 1 à {MODELE_MAX_CHARS} caractères"));
        }
    }
    Ok(())
}

/// Ce qu'une consolidation a écrit.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct RapportConsolidation {
    pub dream: String,
    pub observations_added: usize,
    pub observations_refined: usize,
    pub observations_removed: usize,
    pub causes: usize,
    pub models: usize,
    pub horizon_us: i64,
}

/// Les textes à plonger avant [`appliquer`] : chaque observation, masquée.
pub fn textes(c: &Consolidation) -> Vec<String> {
    c.observations.iter().map(|o| masquer(o.text.trim())).collect()
}

fn md5_hex(texte: &str) -> String {
    use md5::{Digest, Md5};
    Md5::digest(texte.as_bytes()).iter().map(|o| format!("{o:02x}")).collect()
}

/// Applique une consolidation validée, en UNE transaction : observations créées
/// ou affinées (texte masqué, preuves remplacées), retirées, liens `cause`,
/// mental models (le contenu précédent est gardé), filigrane avancé, journal du
/// rêve. `vecteurs` : l'embedding de chaque texte de [`textes`], dans l'ordre.
pub fn appliquer(
    conn: &mut Connection,
    user_id: &str,
    c: &Consolidation,
    vecteurs: &[Vec<f32>],
    instant: &Instant,
) -> rusqlite::Result<RapportConsolidation> {
    let agent_id = c.agent_id.as_deref();
    let portee = liens::cle_portee(agent_id);
    let reve = uuid::Uuid::new_v4().to_string();
    let mut rapport = RapportConsolidation { dream: reve.clone(), ..RapportConsolidation::default() };
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let existants: HashSet<String> = tx
        .prepare("SELECT hash FROM memories WHERE user_id = ?1 AND agent_id IS ?2")?
        .query_map(params![user_id, agent_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for (o, (texte, vecteur)) in c.observations.iter().zip(textes(c).iter().zip(vecteurs)) {
        let hash = md5_hex(texte);
        let termes = db::termes(texte)?;
        let id = match &o.id {
            Some(id) => {
                db::mettre_a_jour_dans(&tx, id, texte, &hash, &Tags::Inchangees, vecteur, instant, &termes)?;
                tx.execute("DELETE FROM liens WHERE source = ?1 AND type = ?2", params![id, PREUVE])?;
                rapport.observations_refined += 1;
                id.clone()
            }
            None => {
                if existants.contains(&hash) {
                    continue;
                }
                let id = uuid::Uuid::new_v4().to_string();
                let metadata = json!({ "memory_type": "observation", "origine": "reve", "preuves": 0 }).to_string();
                db::ajouter_dans(
                    &tx,
                    &NouveauSouvenir {
                        id: &id,
                        memory: texte,
                        hash: &hash,
                        user_id,
                        agent_id,
                        run_id: None,
                        role: None,
                        attributed_to: None,
                        tags: Some("observation"),
                        instant,
                    },
                    vecteur,
                    &termes,
                    Some(&metadata),
                )?;
                rapport.observations_added += 1;
                id
            }
        };
        for preuve in &o.evidence {
            liens::lier(
                &tx,
                &Lien {
                    source: id.clone(),
                    target: preuve.clone(),
                    type_: PREUVE.to_owned(),
                    weight: 0.8,
                    origin: "reve".to_owned(),
                    reason: None,
                    created_at: instant.iso.clone(),
                },
            )?;
        }
        liens::compter_preuves(&tx, &id)?;
    }
    for id in &c.obsolete {
        if db::supprimer_dans(&tx, id, instant)? {
            rapport.observations_removed += 1;
        }
    }
    for cause in &c.causes {
        liens::lier(
            &tx,
            &Lien {
                source: cause.source.clone(),
                target: cause.target.clone(),
                type_: "cause".to_owned(),
                weight: 1.0,
                origin: "reve".to_owned(),
                reason: cause.reason.as_deref().map(masquer),
                created_at: instant.iso.clone(),
            },
        )?;
        rapport.causes += 1;
    }
    let questions: HashMap<String, String> =
        modeles(&tx, user_id, agent_id)?.into_iter().map(|m| (m.name, m.question)).collect();
    for m in &c.models {
        let precedent: Option<String> = tx
            .query_row("SELECT contenu FROM modeles WHERE agent_id = ?1 AND nom = ?2", params![portee, m.name], |r| r.get(0))
            .optional()?;
        tx.execute(
            "INSERT OR REPLACE INTO modeles (agent_id, nom, question, contenu, sources, precedent, maj_at, maj_us)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                portee,
                m.name,
                questions.get(&m.name).cloned().unwrap_or_default(),
                masquer(m.content.trim()),
                serde_json::to_string(&m.sources).unwrap_or_else(|_| "[]".to_owned()),
                precedent,
                instant.iso,
                instant.micros
            ],
        )?;
        rapport.models += 1;
    }
    let horizon = c.horizon_us.max(filigrane(&tx, agent_id)?);
    tx.execute(
        "INSERT OR REPLACE INTO consolidations (agent_id, horizon_us) VALUES (?1, ?2)",
        params![portee, horizon],
    )?;
    rapport.horizon_us = horizon;
    journaliser(&tx, &reve, portee, "consolidation", instant, instant, &serde_json::to_value(&rapport).unwrap_or(Value::Null))?;
    tx.commit()?;
    Ok(rapport)
}

/// Une ligne du journal des rêves.
pub fn journaliser(
    conn: &Connection,
    id: &str,
    portee: &str,
    genre: &str,
    debut: &Instant,
    fin: &Instant,
    rapport: &Value,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO reves (id, agent_id, genre, debut, debut_us, fin, rapport) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, portee, genre, debut.iso, debut.micros, fin.iso, rapport.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modeles_par_defaut_noms_uniques() {
        let noms: HashSet<&str> = MODELES_DEFAUT.iter().map(|(n, _)| *n).collect();
        assert_eq!(noms.len(), MODELES_DEFAUT.len());
        assert!(MODELES_DEFAUT.iter().all(|(_, q)| q.ends_with('?')));
    }

    #[test]
    fn consolidation_refuse_les_champs_inconnus() {
        let c: Result<Consolidation, _> = serde_json::from_str(r#"{"horizon_us":1,"observation":[]}"#);
        assert!(c.is_err());
        let c: Consolidation = serde_json::from_str(r#"{"horizon_us":1}"#).unwrap();
        assert!(c.observations.is_empty() && c.models.is_empty() && c.agent_id.is_none());
    }
}
