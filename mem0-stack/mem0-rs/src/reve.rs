//! Le rêve local de mem0-rs (reve-memoire, phases 1, 2, 5 et 6) : le travail
//! de fond qui entretient la mémoire hors du chemin des requêtes, quand la
//! portée est calme.
//!
//! 1. **Rejouer** : réindexe (entités, voisins sémantiques) les souvenirs dont
//!    l'index manque ou ne suit plus le texte (import, base migrée).
//! 2. **Comparer** : chaque paire de faits très proches ([`SEUIL_PAIRE`]) pas
//!    encore jugée passe au LLM du serveur, qui dit `doublon`, `remplace`,
//!    `contredit`, `precise` ou `distinct`. Une précision devient un lien
//!    `precise`, une contradiction un lien `contredit` ; un doublon, un
//!    remplacement ou une contradiction deviennent une **proposition** — jamais
//!    une suppression : l'humain décide (`POST /memory/dream/proposal`).
//! 5. **Oublier doucement** : une observation qui a perdu toutes ses preuves est
//!    retirée (objet dérivé) ; un fait jamais rappelé depuis
//!    `MEM0_DREAM_FORGET_DAYS`, sans lien ni rôle de preuve, devient une
//!    proposition d'oubli.
//! 6. **Journal** : une ligne `reves` par portée et par rêve, lue par
//!    `GET /memory/dream`.
//!
//! Les phases 3 (observations) et 4 (mental models) demandent un modèle qui
//! raisonne sur toute la portée : le harness les confie à une session omp
//! ([`crate::consolidation`]).
//!
//! Chat coupé (`OMLX_CHAT_BASE_URL=off`) : l'étape 2 est sautée, sans erreur.
//! Le dernier cycle (heure de fin, erreurs) est montré par `GET /health` ([`Suivi`]).
//!
//! Le verrou de la base n'est jamais tenu pendant un appel au LLM.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Value, json};

use crate::consolidation::journaliser;
use crate::extraction::{extraire_json, lire_json_tolerant, retirer_blocs};
use crate::horodatage::{self, Instant};
use crate::liens::{self, Lien, PREUVE, SEMANTIQUE};
use crate::openai::ClientChat;

/// Cosinus à partir duquel deux faits d'une portée sont comparés par le LLM.
pub const SEUIL_PAIRE: f64 = 0.85;
/// Souvenirs réindexés au plus par rêve et par portée.
const REINDEXATION_MAX: usize = 500;
/// Propositions d'oubli au plus par rêve et par portée.
const OUBLIS_MAX: usize = 10;

/// Réglage du rêve local (`MEM0_DREAM_*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reglage {
    /// Période de la boucle de fond ; zéro = rêve de fond coupé (la route
    /// `POST /memory/dream` reste disponible).
    pub intervalle: Duration,
    /// Une portée ne rêve que si aucun souvenir n'y a été écrit depuis `calme`.
    pub calme: Duration,
    /// Paires jugées par le LLM au plus, par rêve et par portée.
    pub paires: usize,
    /// Jours sans rappel avant une proposition d'oubli ; 0 = jamais.
    pub oubli_jours: u64,
}

impl Default for Reglage {
    fn default() -> Self {
        Reglage { intervalle: Duration::from_secs(3600), calme: Duration::from_secs(600), paires: 20, oubli_jours: 180 }
    }
}

/// Ce qu'un rêve a fait dans une portée.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct RapportPortee {
    pub dream: String,
    pub agent_id: Option<String>,
    pub reindexed: usize,
    pub pairs_judged: usize,
    pub links: usize,
    pub proposals: usize,
    pub orphans_removed: usize,
    pub forget_proposals: usize,
    pub errors: Vec<String>,
}

/// Verdict du LLM sur une paire.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub genre: String,
    /// `A` ou `B` : le souvenir qui fait foi (doublon, remplace) ou le plus précis.
    pub garder: Option<char>,
    pub raison: String,
}

pub const PROMPT_PAIRE: &str = "Tu compares deux souvenirs A et B de la mémoire d'un projet logiciel, pour l'entretenir. \
Réponds uniquement par un objet JSON : {\"verdict\": \"doublon\" | \"remplace\" | \"contredit\" | \"precise\" | \"distinct\", \"garder\": \"A\" | \"B\" | null, \"raison\": \"une phrase\"}.\n\
- doublon : A et B disent la même chose ; garder = le plus complet.\n\
- remplace : l'un rend l'autre obsolète (valeur, décision ou convention qui a changé) ; garder = celui qui fait foi, en général le plus récent.\n\
- contredit : ils s'opposent et rien ne dit lequel fait foi ; garder = null.\n\
- precise : l'un précise l'autre sans le contredire ; garder = le plus précis.\n\
- distinct : sujets voisins, faits différents (un nombre, une négation, un nom qui diffère suffit).\n\
Dans le doute, réponds distinct.";

/// Le message utilisateur d'une paire.
pub fn invite_paire(a: (&str, &str), b: (&str, &str)) -> String {
    format!("A (écrit le {}) : {}\nB (écrit le {}) : {}", &a.0[..a.0.len().min(10)], a.1, &b.0[..b.0.len().min(10)], b.1)
}

/// Lit le verdict du LLM ; `None` si la réponse est illisible ou hors des genres.
pub fn lire_verdict(contenu: &str) -> Option<Verdict> {
    let r = retirer_blocs(contenu);
    let v = lire_json_tolerant(&r).or_else(|| lire_json_tolerant(&extraire_json(&r)))?;
    let genre = v.get("verdict")?.as_str()?.trim().to_lowercase();
    if !["doublon", "remplace", "contredit", "precise", "distinct"].contains(&genre.as_str()) {
        return None;
    }
    let garder = match v.get("garder").and_then(Value::as_str).map(str::trim) {
        Some("A" | "a") => Some('A'),
        Some("B" | "b") => Some('B'),
        _ => None,
    };
    let raison = v.get("raison").and_then(Value::as_str).unwrap_or("").trim().chars().take(500).collect();
    Some(Verdict { genre, garder, raison })
}

/// Une paire à juger : (id, texte, hash, created_at) de chaque côté, A le plus ancien.
type Cote = (String, String, String, String);

/// Les paires de faits voisins de la portée à juger : lien `semantique` ≥
/// [`SEUIL_PAIRE`], aucune des deux n'est une observation, pas déjà jugée avec
/// ces textes, pas citée par une proposition ouverte.
fn paires_a_juger(conn: &Connection, portee: &str, n: usize) -> rusqlite::Result<Vec<(Cote, Cote)>> {
    let fait = "json_extract(COALESCE(x.metadata, '{}'), '$.memory_type') IS NOT 'observation'";
    let sql = format!(
        "SELECT a.id, a.memory, a.hash, a.created_at, b.id, b.memory, b.hash, b.created_at
         FROM liens l JOIN memories a ON a.id = l.source JOIN memories b ON b.id = l.cible
         WHERE l.type = ?1 AND l.poids >= ?2 AND COALESCE(a.agent_id, '') = ?3 AND COALESCE(b.agent_id, '') = ?3
           AND {} AND {}
           AND NOT EXISTS (SELECT 1 FROM paires_jugees p WHERE p.a = l.source AND p.b = l.cible AND p.hash_a = a.hash AND p.hash_b = b.hash)
           AND NOT EXISTS (SELECT 1 FROM propositions o, json_each(o.souvenirs) j
                           WHERE o.statut = 'ouverte' AND j.value IN (l.source, l.cible))
         ORDER BY l.poids DESC, l.source, l.cible LIMIT ?4",
        fait.replace("x.", "a."),
        fait.replace("x.", "b.")
    );
    conn.prepare(&sql)?
        .query_map(params![SEMANTIQUE, SEUIL_PAIRE, portee, i64::try_from(n).unwrap_or(i64::MAX)], |r| {
            let a: Cote = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
            let b: Cote = (r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?);
            // A : le plus ancien.
            Ok(if b.3 < a.3 { (b, a) } else { (a, b) })
        })?
        .collect()
}

/// Ouvre une proposition.
#[allow(clippy::too_many_arguments, reason = "les colonnes d'une proposition")]
pub fn proposer(
    conn: &Connection,
    portee: &str,
    genre: &str,
    souvenirs: &[&str],
    supprimer: Option<&str>,
    raison: &str,
    reve: &str,
    instant: &Instant,
) -> rusqlite::Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO propositions (id, agent_id, genre, souvenirs, supprimer, raison, statut, reve, created_at, decided_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ouverte', ?7, ?8, NULL)",
        params![id, portee, genre, json!(souvenirs).to_string(), supprimer, raison, reve, instant.iso],
    )?;
    Ok(id)
}

/// Applique le verdict d'une paire (A le plus ancien) ; rend (liens posés,
/// propositions ouvertes).
fn appliquer_verdict(
    conn: &Connection,
    portee: &str,
    a: &Cote,
    b: &Cote,
    v: &Verdict,
    reve: &str,
    instant: &Instant,
) -> rusqlite::Result<(usize, usize)> {
    // Rangée comme le lien `semantique` : le plus petit id d'abord.
    let (p, q) = if a.0 < b.0 { (a, b) } else { (b, a) };
    conn.execute(
        "INSERT OR REPLACE INTO paires_jugees (a, b, hash_a, hash_b, verdict) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![p.0, q.0, p.2, q.2, v.genre],
    )?;
    let (garde, autre) = match v.garder {
        Some('A') => (a, b),
        _ => (b, a),
    };
    let lien = |source: &str, cible: &str, type_: &str| Lien {
        source: source.to_owned(),
        target: cible.to_owned(),
        type_: type_.to_owned(),
        weight: 1.0,
        origin: "reve".to_owned(),
        reason: (!v.raison.is_empty()).then(|| v.raison.clone()),
        created_at: instant.iso.clone(),
    };
    match v.genre.as_str() {
        "precise" => {
            liens::lier(conn, &lien(&garde.0, &autre.0, "precise"))?;
            Ok((1, 0))
        }
        "contredit" => {
            liens::lier(conn, &lien(&b.0, &a.0, "contredit"))?;
            let supprimer = v.garder.map(|_| autre.0.as_str());
            proposer(conn, portee, "contredit", &[&a.0, &b.0], supprimer, &v.raison, reve, instant)?;
            Ok((1, 1))
        }
        "doublon" | "remplace" => {
            if v.genre == "remplace" {
                liens::lier(conn, &lien(&garde.0, &autre.0, "remplace"))?;
            }
            proposer(conn, portee, &v.genre, &[&a.0, &b.0], Some(&autre.0), &v.raison, reve, instant)?;
            Ok((usize::from(v.genre == "remplace"), 1))
        }
        _ => Ok((0, 0)),
    }
}

/// Phase 5 : observations orphelines retirées, propositions d'oubli.
fn oublier(
    conn: &mut Connection,
    portee: &str,
    reglage: &Reglage,
    reve: &str,
    instant: &Instant,
) -> rusqlite::Result<(usize, usize)> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let orphelines: Vec<String> = tx
        .prepare(
            "SELECT m.id FROM memories m
             WHERE COALESCE(m.agent_id, '') = ?1 AND json_extract(COALESCE(m.metadata, '{}'), '$.memory_type') = 'observation'
               AND NOT EXISTS (SELECT 1 FROM liens l WHERE l.source = m.id AND l.type = ?2)",
        )?
        .query_map(params![portee, PREUVE], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in &orphelines {
        crate::db::supprimer_dans(&tx, id, instant)?;
    }
    let mut oublis = 0;
    if reglage.oubli_jours > 0 {
        let fenetre = i64::try_from(reglage.oubli_jours).unwrap_or(i64::MAX / 2).saturating_mul(86_400_000_000);
        let limite = instant.micros.saturating_sub(fenetre);
        // Les rappels ne se comptent que depuis la création (ou la migration v4)
        // de la base : avant une fenêtre entière, « jamais rappelé » ne dit rien.
        if crate::db::rappels_depuis_us(&tx)? <= limite {
            let candidats: Vec<(String, String)> = tx
                .prepare(
                    "SELECT m.id, m.memory FROM memories m
                     WHERE COALESCE(m.agent_id, '') = ?1 AND m.updated_at_us < ?2
                       AND json_extract(COALESCE(m.metadata, '{}'), '$.memory_type') IS NOT 'observation'
                       AND NOT EXISTS (SELECT 1 FROM rappels r WHERE r.memory_id = m.id AND r.dernier_us >= ?2)
                       AND NOT EXISTS (SELECT 1 FROM liens l WHERE (l.source = m.id OR l.cible = m.id) AND l.type != ?3)
                       AND NOT EXISTS (SELECT 1 FROM propositions o, json_each(o.souvenirs) j
                                       WHERE o.statut IN ('ouverte', 'refusee') AND o.genre = 'oubli' AND j.value = m.id)
                     ORDER BY m.updated_at_us, m.id LIMIT ?4",
                )?
                .query_map(params![portee, limite, SEMANTIQUE, OUBLIS_MAX as i64], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (id, _) in &candidats {
                let raison = format!("ni rappelé ni relié depuis {} jours", reglage.oubli_jours);
                proposer(&tx, portee, "oubli", &[id], Some(id), &raison, reve, instant)?;
                oublis += 1;
            }
        }
    }
    tx.commit()?;
    Ok((orphelines.len(), oublis))
}

/// Un rêve sur la portée `portee` (`agent_id`, chaîne vide pour NULL).
pub async fn rever_portee(
    db: &Arc<Mutex<Connection>>,
    chat: &ClientChat,
    reglage: &Reglage,
    portee: &str,
) -> Result<RapportPortee, String> {
    let debut = horodatage::maintenant();
    let reve = uuid::Uuid::new_v4().to_string();
    let mut rapport = RapportPortee {
        dream: reve.clone(),
        agent_id: (!portee.is_empty()).then(|| portee.to_owned()),
        ..RapportPortee::default()
    };
    let base = |e: rusqlite::Error| format!("base : {e}");
    let verrou = || db.lock().map_err(|_| "verrou de la base empoisonné".to_owned());

    // 1. Rejouer.
    {
        let mut conn = verrou()?;
        let ids = liens::a_reindexer(&conn, Some(portee), REINDEXATION_MAX).map_err(base)?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(base)?;
        liens::indexer_lot(&tx, &ids.iter().map(String::as_str).collect::<Vec<_>>(), &debut.iso).map_err(base)?;
        tx.commit().map_err(base)?;
        rapport.reindexed = ids.len();
    }

    // 2. Comparer (sautée, chat coupé).
    let paires = if chat.actif() { paires_a_juger(&*verrou()?, portee, reglage.paires).map_err(base)? } else { Vec::new() };
    for (a, b) in paires {
        let reponse = match chat.completer(PROMPT_PAIRE, &invite_paire((&a.3, &a.1), (&b.3, &b.1))).await {
            Ok(r) => r,
            Err(e) => {
                rapport.errors.push(format!("LLM : {e}"));
                break;
            }
        };
        let Some(verdict) = lire_verdict(&reponse) else {
            rapport.errors.push(format!("verdict illisible pour {} / {}", a.0, b.0));
            continue;
        };
        let instant = horodatage::maintenant();
        let conn = verrou()?;
        // Un des deux a pu changer ou disparaître pendant l'appel : on rejuge plus tard.
        let inchanges: i64 = conn
            .query_row("SELECT count(*) FROM memories WHERE (id = ?1 AND hash = ?2) OR (id = ?3 AND hash = ?4)", params![a.0, a.2, b.0, b.2], |r| r.get(0))
            .map_err(base)?;
        if inchanges != 2 {
            continue;
        }
        let (l, p) = appliquer_verdict(&conn, portee, &a, &b, &verdict, &reve, &instant).map_err(base)?;
        rapport.pairs_judged += 1;
        rapport.links += l;
        rapport.proposals += p;
    }

    // 5. Oublier doucement.
    {
        let mut conn = verrou()?;
        let (orphelines, oublis) = oublier(&mut conn, portee, reglage, &reve, &horodatage::maintenant()).map_err(base)?;
        rapport.orphans_removed = orphelines;
        rapport.forget_proposals = oublis;
    }

    // 6. Journal.
    let fin = horodatage::maintenant();
    let conn = verrou()?;
    journaliser(&conn, &reve, portee, "local", &debut, &fin, &serde_json::to_value(&rapport).unwrap_or(Value::Null))
        .map_err(base)?;
    Ok(rapport)
}

/// Les portées qui ont des souvenirs (`agent_id`, chaîne vide pour NULL), triées.
pub fn portees(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    conn.prepare("SELECT DISTINCT COALESCE(agent_id, '') FROM memories ORDER BY 1")?.query_map([], |r| r.get(0))?.collect()
}

/// La portée doit-elle rêver ? Il faut qu'aucun souvenir n'y ait été écrit depuis
/// `calme`, et qu'elle ait changé depuis son dernier rêve local (ou n'ait jamais
/// rêvé) — ou, avec `paires`, qu'il lui reste des paires à juger : un rêve qui a
/// épuisé son quota reprend au tour suivant, sans attendre une écriture.
pub fn due(conn: &Connection, portee: &str, calme: Duration, paires: bool, maintenant_us: i64) -> rusqlite::Result<bool> {
    let (plus_recent, dernier): (Option<i64>, Option<i64>) = conn.query_row(
        "SELECT (SELECT max(updated_at_us) FROM memories WHERE COALESCE(agent_id, '') = ?1),
                (SELECT max(debut_us) FROM reves WHERE agent_id = ?1 AND genre = 'local')",
        [portee],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let Some(plus_recent) = plus_recent else {
        return Ok(false);
    };
    let calme_us = i64::try_from(calme.as_micros()).unwrap_or(i64::MAX);
    if maintenant_us.saturating_sub(plus_recent) < calme_us {
        return Ok(false);
    }
    Ok(dernier.is_none_or(|d| plus_recent > d) || (paires && !paires_a_juger(conn, portee, 1)?.is_empty()))
}

/// Le dernier cycle du rêve local (boucle ou `POST /memory/dream`), montré par
/// `GET /health`.
#[derive(Debug, Default)]
pub struct Suivi(Mutex<Option<DernierCycle>>);

#[derive(Debug, Clone)]
struct DernierCycle {
    fin: String,
    erreur: Option<String>,
}

impl Suivi {
    /// Note la fin d'un cycle et ses erreurs (« portée » : erreur ; vide = réussi).
    pub fn noter(&self, erreurs: &[String]) {
        let cycle = DernierCycle {
            fin: horodatage::maintenant().iso,
            erreur: (!erreurs.is_empty()).then(|| erreurs.join(" ; ")),
        };
        if let Ok(mut d) = self.0.lock() {
            *d = Some(cycle);
        }
    }

    /// `(last_run_at, last_error)` ; `(null, null)` avant le premier cycle.
    pub fn etat(&self) -> (Option<String>, Option<String>) {
        match self.0.lock().ok().and_then(|d| d.clone()) {
            Some(c) => (Some(c.fin), c.erreur),
            None => (None, None),
        }
    }
}

/// Erreur d'une portée dans le suivi d'un cycle.
pub fn erreur_de_portee(portee: &str, erreur: &str) -> String {
    format!("« {portee} » : {erreur}")
}

/// Boucle du rêve de fond, lancée par `main` quand l'intervalle n'est pas nul.
/// Le premier tour a lieu une période après le démarrage ; un tour sans portée
/// due n'est pas un cycle.
pub async fn boucle(db: Arc<Mutex<Connection>>, chat: ClientChat, reglage: Reglage, suivi: Arc<Suivi>) {
    loop {
        tokio::time::sleep(reglage.intervalle).await;
        let maintenant = horodatage::maintenant().micros;
        let paires = reglage.paires > 0 && chat.actif();
        let dues: Vec<String> = {
            let Ok(conn) = db.lock() else { return };
            match portees(&conn) {
                Ok(p) => p.into_iter().filter(|p| due(&conn, p, reglage.calme, paires, maintenant).unwrap_or(false)).collect(),
                Err(e) => {
                    eprintln!("mem0-rs : rêve : {e}");
                    suivi.noter(&[e.to_string()]);
                    continue;
                }
            }
        };
        if dues.is_empty() {
            continue;
        }
        let mut erreurs = Vec::new();
        for portee in dues {
            match rever_portee(&db, &chat, &reglage, &portee).await {
                Ok(r) if !r.errors.is_empty() => {
                    let e = r.errors.join(" ; ");
                    eprintln!("mem0-rs : rêve de « {portee} » : {e}");
                    erreurs.push(erreur_de_portee(&portee, &e));
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("mem0-rs : rêve de « {portee} » impossible : {e}");
                    erreurs.push(erreur_de_portee(&portee, &e));
                }
            }
        }
        suivi.noter(&erreurs);
    }
}

/// Une proposition, telle que rendue par `GET /memory/dream`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Proposition {
    pub id: String,
    pub kind: String,
    pub memories: Vec<PropositionSouvenir>,
    pub delete: Option<String>,
    pub reason: Option<String>,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PropositionSouvenir {
    pub id: String,
    pub memory: Option<String>,
}

/// Les propositions de la portée au statut donné, des plus récentes aux plus anciennes.
pub fn propositions(conn: &Connection, portee: &str, statut: &str, n: usize) -> rusqlite::Result<Vec<Proposition>> {
    type Ligne = (String, String, String, Option<String>, Option<String>, String, String);
    let lignes: Vec<Ligne> = conn
        .prepare_cached(
            "SELECT id, genre, souvenirs, supprimer, raison, statut, created_at FROM propositions
             WHERE agent_id = ?1 AND statut = ?2 ORDER BY created_at DESC, id LIMIT ?3",
        )?
        .query_map(params![portee, statut, i64::try_from(n).unwrap_or(i64::MAX)], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut texte = conn.prepare_cached("SELECT memory FROM memories WHERE id = ?1")?;
    lignes
        .into_iter()
        .map(|(id, genre, souvenirs, supprimer, raison, statut, created_at)| {
            let ids: Vec<String> = serde_json::from_str(&souvenirs).unwrap_or_default();
            let memories = ids
                .into_iter()
                .map(|id| {
                    let memory = rusqlite::OptionalExtension::optional(texte.query_row([&id], |r| r.get(0)))?;
                    Ok(PropositionSouvenir { id, memory })
                })
                .collect::<rusqlite::Result<_>>()?;
            Ok(Proposition { id, kind: genre, memories, delete: supprimer, reason: raison, status: statut, created_at })
        })
        .collect()
}

/// Les derniers rêves de la portée (local et consolidation), du plus récent au plus ancien.
pub fn journal(conn: &Connection, portee: &str, n: usize) -> rusqlite::Result<Vec<Value>> {
    conn.prepare_cached(
        "SELECT id, genre, debut, fin, rapport FROM reves WHERE agent_id = ?1 ORDER BY debut_us DESC, id LIMIT ?2",
    )?
    .query_map(params![portee, i64::try_from(n).unwrap_or(i64::MAX)], |r| {
        let rapport: String = r.get(4)?;
        Ok(json!({
            "id": r.get::<_, String>(0)?,
            "kind": r.get::<_, String>(1)?,
            "started_at": r.get::<_, String>(2)?,
            "ended_at": r.get::<_, String>(3)?,
            "report": serde_json::from_str::<Value>(&rapport).unwrap_or(Value::Null),
        }))
    })?
    .collect()
}

/// Issue d'une décision sur une proposition.
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// Appliquée ; `true` si un souvenir a été supprimé.
    Faite(bool),
    Inconnue,
    /// Déjà décidée ou caduque : son statut.
    DejaClose(String),
}

/// Accepte (applique sa suppression, s'il y en a une) ou refuse une proposition
/// ouverte, en une transaction.
pub fn decider(conn: &mut Connection, id: &str, accepter: bool, instant: &Instant) -> rusqlite::Result<Decision> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let ligne: Option<(String, Option<String>)> = rusqlite::OptionalExtension::optional(tx.query_row(
        "SELECT statut, supprimer FROM propositions WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let Some((statut, supprimer)) = ligne else {
        return Ok(Decision::Inconnue);
    };
    if statut != "ouverte" {
        return Ok(Decision::DejaClose(statut));
    }
    tx.execute(
        "UPDATE propositions SET statut = ?2, decided_at = ?3 WHERE id = ?1",
        params![id, if accepter { "acceptee" } else { "refusee" }, instant.iso],
    )?;
    let supprime = match (accepter, supprimer) {
        (true, Some(cible)) => crate::db::supprimer_dans(&tx, &cible, instant)?,
        _ => false,
    };
    tx.commit()?;
    Ok(Decision::Faite(supprime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdicts_lus_et_refuses() {
        let v = lire_verdict(r#"{"verdict":"remplace","garder":"B","raison":"la valeur a changé"}"#).unwrap();
        assert_eq!(v, Verdict { genre: "remplace".into(), garder: Some('B'), raison: "la valeur a changé".into() });
        let v = lire_verdict("<think>hmm</think>```json\n{\"verdict\":\"Distinct\",\"garder\":null}\n```").unwrap();
        assert_eq!((v.genre.as_str(), v.garder), ("distinct", None));
        assert!(lire_verdict(r#"{"verdict":"fusionner"}"#).is_none());
        assert!(lire_verdict("pas du json").is_none());
        assert!(lire_verdict(r#"{"garder":"A"}"#).is_none());
    }

    #[test]
    fn invite_paire_dates_courtes() {
        assert_eq!(
            invite_paire(("2026-10-12T10:00:00+00:00", "x"), ("2026-10-13T08:00:00+00:00", "y")),
            "A (écrit le 2026-10-12) : x\nB (écrit le 2026-10-13) : y"
        );
    }

    #[test]
    fn due_calme_changement_et_paires_restantes() {
        let dossier = std::env::temp_dir().join(format!("mem0-rs-reve-due-{}", uuid::Uuid::new_v4()));
        let mut conn = crate::db::ouvrir(&dossier.join("b.db"), 2).unwrap();
        let i = horodatage::maintenant();
        let ajouter = |conn: &mut Connection, id: &str, v: &[f32]| {
            let s = crate::db::NouveauSouvenir {
                id,
                memory: id,
                hash: id,
                user_id: "moi",
                agent_id: Some("p"),
                run_id: None,
                role: Some("user"),
                attributed_to: None,
                tags: None,
                instant: &i,
            };
            crate::db::ajouter(conn, &s, v).unwrap();
        };
        let calme = Duration::from_secs(600);
        assert!(!due(&conn, "p", calme, true, i.micros).unwrap(), "portée vide");
        ajouter(&mut conn, "a", &[1.0, 0.0]);
        assert!(!due(&conn, "p", calme, true, i.micros + 1).unwrap(), "pas encore calme");
        let plus_tard = i.micros + 601_000_000;
        assert!(due(&conn, "p", calme, true, plus_tard).unwrap(), "jamais rêvé");
        journaliser(&conn, "r1", "p", "local", &horodatage::Instant { iso: "x".into(), micros: plus_tard }, &i, &Value::Null).unwrap();
        assert!(!due(&conn, "p", calme, true, plus_tard + 1).unwrap(), "rien n'a changé depuis le rêve");
        // Une paire très proche, jamais jugée : le rêve reprend même sans écriture nouvelle.
        ajouter(&mut conn, "b", &[1.0, 0.01]);
        journaliser(&conn, "r2", "p", "local", &horodatage::Instant { iso: "y".into(), micros: plus_tard + 2 }, &i, &Value::Null).unwrap();
        assert!(due(&conn, "p", calme, true, plus_tard + 3).unwrap(), "paire restante");
        assert!(!due(&conn, "p", calme, false, plus_tard + 3).unwrap(), "sans LLM, la paire n'appelle rien");
        drop(conn);
        let _ = std::fs::remove_dir_all(dossier);
    }

    #[test]
    fn reglage_par_defaut() {
        let r = Reglage::default();
        assert_eq!((r.intervalle.as_secs(), r.calme.as_secs(), r.paires, r.oubli_jours), (3600, 600, 20, 180));
    }
}
