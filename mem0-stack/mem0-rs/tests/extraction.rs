//! Tests boîte noire de `POST /memory/add` avec `infer=true` (BR-3 de
//! mem0-rs-extraction-llm) : le vrai binaire, branché sur un faux serveur OpenAI
//! dont les réponses chat/completions sont scriptées.

#[allow(dead_code, reason = "module partagé : chaque fichier de tests n'en utilise qu'une partie")]
mod common;

use std::time::Duration;

use common::{Dossier, FauxOpenAI, JETON_OMLX, Lancement, MODELE_CHAT, Reponse, ReponseChat, Serveur};
use md5::{Digest, Md5};
use serde_json::{Value, json};

const SYSTEME: &str = include_str!("../src/prompts/additive_extraction.txt");
const CONSIGNES: &str = include_str!("../src/prompts/custom_instructions.txt");

/// Banc : serveur lancé, faux OpenAI et dossier jetable (le serveur est tué
/// avant que son dossier soit supprimé).
struct Banc {
    serveur: Serveur,
    faux: FauxOpenAI,
    _dossier: Dossier,
}

async fn banc(nom: &str) -> Banc {
    let faux = FauxOpenAI::demarrer().await;
    let dossier = Dossier::nouveau(nom);
    let serveur =
        Serveur::demarrer(&Lancement { base: &dossier.base(), embedder_url: &faux.base_url, jeton: "", installation: "" })
            .await;
    Banc { serveur, faux, _dossier: dossier }
}

fn md5_hex(texte: &str) -> String {
    Md5::digest(texte.as_bytes()).iter().map(|o| format!("{o:02x}")).collect()
}

fn ok(r: &Reponse) -> Value {
    assert_eq!(r.statut, 200, "réponse : {}", r.texte);
    assert_eq!(r.content_type, "application/json");
    r.json()
}

fn assert_500(r: &Reponse) {
    assert_eq!(r.statut, 500, "réponse : {}", r.texte);
    assert_eq!(r.content_type, "text/plain; charset=utf-8");
    assert_eq!(r.texte, "Internal Server Error");
}

fn cles(v: &Value) -> Vec<&str> {
    v.as_object().expect("objet attendu").keys().map(String::as_str).collect()
}

fn contenu(c: &str) -> ReponseChat {
    ReponseChat::Contenu(c.to_owned())
}

/// `POST /memory/add` avec `infer: true`.
async fn inferer(s: &Serveur, texte: &str, agent_id: &str) -> Reponse {
    s.appeler("POST", "/memory/add", Some(&json!({"text": texte, "agent_id": agent_id, "infer": true}))).await
}

/// add infer=false ; rend l'id.
async fn ajouter(s: &Serveur, texte: &str, agent_id: &str) -> String {
    let r = ok(&s.appeler("POST", "/memory/add", Some(&json!({"text": texte, "agent_id": agent_id, "infer": false}))).await);
    r["results"][0]["id"].as_str().expect("id").to_owned()
}

async fn tous(s: &Serveur, agent_id: &str) -> Value {
    ok(&s.appeler("GET", &format!("/memory/all?agent_id={agent_id}"), None).await)
}

async fn historique(s: &Serveur, id: &str) -> Value {
    ok(&s.appeler("GET", &format!("/memory/{id}/history"), None).await)
}

fn memoires(v: &Value) -> Vec<&str> {
    v["results"].as_array().unwrap().iter().map(|l| l["memory"].as_str().unwrap()).collect()
}

/// Cosinus du faux embedder (vecteurs déjà normalisés).
fn cosinus(a: &str, b: &str) -> f64 {
    common::plonger(a).iter().zip(common::plonger(b)).map(|(x, y)| x * y).sum()
}

/// La date UTC du jour, `AAAA-MM-JJ`.
fn aujourd_hui() -> String {
    time::OffsetDateTime::now_utc().date().to_string()
}

/// Invite utilisateur attendue (S-2, étape 5), construite indépendamment de mem0-rs.
fn invite(derniers: &[String], existants: &[&str], texte: &str, date: &str) -> String {
    let l: String = derniers.iter().map(|l| format!("{l}\n")).collect();
    let e = if existants.is_empty() {
        "[]".to_owned()
    } else {
        let objets: Vec<String> = existants
            .iter()
            .enumerate()
            .map(|(i, t)| format!("{{\"id\": \"{i}\", \"text\": {}}}", serde_json::to_string(t).unwrap()))
            .collect();
        format!("[{}]", objets.join(", "))
    };
    format!(
        "## Summary\n\n\n## Last k Messages\n{l}\n\n## Recently Extracted Memories\n[]\n\n## Existing Memories\n{e}\n\n## New Messages\nuser: {texte}\n\n\n## Observation Date\n{date}\n\n## Current Date\n{date}\n\n## Custom Instructions\n{CONSIGNES}\n\n# Output:"
    )
}

/// L'invite user d'une requête chat reçue.
fn invite_recue(corps: &Value) -> &str {
    corps["messages"][1]["content"].as_str().expect("invite user")
}

/// La date d'observation d'une invite reçue.
fn date_recue(invite: &str) -> String {
    let (_, apres) = invite.split_once("\n\n## Observation Date\n").expect("section Observation Date");
    apres[..10].to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn ac1_faits_extraits_un_appel_chat() {
    let b = banc("ac1-infer").await;
    let s = &b.serveur;
    b.faux.scripter(vec![contenu(
        r#"{"memory":[{"id":"0","text":"Fait A","attributed_to":"user"},{"text":"Fait B","attributed_to":5},{"text":"Fait C","attributed_to":""}]}"#,
    )]);
    let texte = "Notes de la réunion d'équipe";
    let r = ok(&s
        .appeler("POST", "/memory/add", Some(&json!({"text":texte,"agent_id":"ag-ac1","tags":"t1,t2","infer":true})))
        .await);
    assert_eq!(cles(&r), ["results"]);
    let resultats = r["results"].as_array().unwrap();
    assert_eq!(memoires(&r), ["Fait A", "Fait B", "Fait C"]);
    for l in resultats {
        assert_eq!(cles(l), ["id", "memory", "event"]);
        assert_eq!(l["event"], "ADD");
    }
    assert_eq!(b.faux.requetes_chat().len(), 1, "exactement UN appel chat/completions");
    assert_eq!(b.faux.autorisations_chat(), [format!("Bearer {JETON_OMLX}")]);
    assert_eq!(
        b.faux.entrees(),
        [vec![format!("user: {texte} ")], vec!["Fait A".to_owned(), "Fait B".to_owned(), "Fait C".to_owned()]]
    );

    let all = tous(s, "ag-ac1").await;
    assert_eq!(all["total"], 3);
    for (i, attendu) in resultats.iter().enumerate() {
        let id = attendu["id"].as_str().unwrap();
        let l = all["results"].as_array().unwrap().iter().find(|l| l["id"] == id).expect("souvenir relu");
        let memory = l["memory"].as_str().unwrap();
        assert_eq!(memory, attendu["memory"]);
        let mut cles_attendues = vec!["id", "memory", "hash", "metadata", "created_at", "updated_at", "user_id", "agent_id"];
        if i < 2 {
            cles_attendues.push("attributed_to");
        }
        assert_eq!(cles(l), cles_attendues, "pas de role pour un fait extrait");
        assert_eq!(l["metadata"], json!({"tags":"t1,t2"}));
        assert_eq!(l["hash"], md5_hex(memory));
        assert_eq!(l["created_at"], l["updated_at"]);
        assert_eq!((&l["user_id"], &l["agent_id"]), (&json!("moi"), &json!("ag-ac1")));
        let h = historique(s, id).await;
        assert_eq!(
            h,
            json!([{
                "id": h[0]["id"], "memory_id": id, "old_memory": null, "new_memory": memory, "event": "ADD",
                "created_at": l["created_at"], "updated_at": null, "is_deleted": false, "actor_id": null, "role": null,
            }])
        );
    }
    let lire = |all: &Value, memory: &str| all["results"].as_array().unwrap().iter().find(|l| l["memory"] == memory).cloned();
    assert_eq!(lire(&all, "Fait A").unwrap()["attributed_to"], "user");
    assert_eq!(lire(&all, "Fait B").unwrap()["attributed_to"], 5);

    // PUT d'un fait extrait : attributed_to conservé, role toujours absent, révision UPDATE sans role.
    let id_a = lire(&all, "Fait A").unwrap()["id"].as_str().unwrap().to_owned();
    ok(&s.appeler("PUT", &format!("/memory/{id_a}"), Some(&json!({"text":"Fait A révisé"}))).await);
    let a = lire(&tous(s, "ag-ac1").await, "Fait A révisé").expect("fait révisé");
    assert_eq!(a["attributed_to"], "user");
    assert!(a.get("role").is_none());
    let h = historique(s, &id_a).await;
    assert_eq!(h.as_array().unwrap().len(), 2);
    assert_eq!((&h[1]["event"], &h[1]["old_memory"], &h[1]["new_memory"]), (&json!("UPDATE"), &json!("Fait A"), &json!("Fait A révisé")));
    assert_eq!(h[1]["role"], Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn ac2_corps_chat_exact() {
    let b = banc("ac2-infer").await;
    let s = &b.serveur;
    let faits = ["Le dépôt cible bash 3.2", "La CI tourne sur ubuntu-latest"];
    b.faux.scripter(vec![contenu(r#"{"memory":[{"text":"Le dépôt cible bash 3.2"},{"text":"La CI tourne sur ubuntu-latest"}]}"#)]);
    let t1 = "Première ligne\nseconde ligne « citée »";
    let avant = aujourd_hui();
    assert_eq!(memoires(&ok(&inferer(s, t1, "ag-ac2").await)), faits);
    let apres = aujourd_hui();

    let requetes = b.faux.requetes_chat();
    let premier = &requetes[0];
    let date = date_recue(invite_recue(premier));
    assert!(date == avant || date == apres, "date UTC du jour attendue, reçu {date}");
    let attendu = json!({
        "model": MODELE_CHAT,
        "messages": [
            {"role": "system", "content": SYSTEME},
            {"role": "user", "content": invite(&[], &[], t1, &date)},
        ],
        "max_tokens": 2000,
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
        "top_p": 0.1,
    });
    // Comparaison textuelle : ordre des clés et valeurs exactes.
    assert_eq!(serde_json::to_string(premier).unwrap(), serde_json::to_string(&attendu).unwrap());

    // Second appel du scope : Last k Messages (texte brut multiligne) et
    // Existing Memories par cosinus décroissant.
    let t2 = "Deuxième appel sur la CI";
    let requete = format!("user: {t2} ");
    let (c0, c1) = (cosinus(&requete, faits[0]), cosinus(&requete, faits[1]));
    assert!((c0 - c1).abs() >= 1e-6, "précondition : cosinus distincts ({c0}, {c1})");
    let existants: Vec<&str> = if c0 > c1 { vec![faits[0], faits[1]] } else { vec![faits[1], faits[0]] };
    assert_eq!(ok(&inferer(s, t2, "ag-ac2").await), json!({"results": []}));
    let second = &b.faux.requetes_chat()[1];
    let date = date_recue(invite_recue(second));
    assert_eq!(invite_recue(second), invite(&[format!("user: {t1}")], &existants, t2, &date));
    assert_eq!(second["messages"][0]["content"], SYSTEME);
    // Un autre scope ne voit ni les messages ni les souvenirs de celui-ci.
    ok(&inferer(s, "Autre scope", "ag-ac2-autre").await);
    let troisieme = &b.faux.requetes_chat()[2];
    assert_eq!(invite_recue(troisieme), invite(&[], &[], "Autre scope", &date_recue(invite_recue(troisieme))));
}

#[tokio::test(flavor = "multi_thread")]
async fn ac3_doublon_md5_top10() {
    let b = banc("ac3-infer").await;
    let s = &b.serveur;

    // Un fait identique à un souvenir existant (dans le top 10) n'est pas recréé.
    ajouter(s, "Le dépôt cible bash 3.2", "ag-ac3a").await;
    b.faux.scripter(vec![contenu(r#"{"memory":[{"text":"Le dépôt cible bash 3.2"},{"text":"Fait inédit du doublon"}]}"#)]);
    let e0 = b.faux.entrees().len();
    assert_eq!(memoires(&ok(&inferer(s, "Rappel des décisions", "ag-ac3a").await)), ["Fait inédit du doublon"]);
    let all = tous(s, "ag-ac3a").await;
    assert_eq!(all["total"], 2);
    assert_eq!(memoires(&all).iter().filter(|m| **m == "Le dépôt cible bash 3.2").count(), 1);
    let chat = &b.faux.requetes_chat()[0];
    assert_eq!(
        invite_recue(chat),
        invite(&[], &["Le dépôt cible bash 3.2"], "Rappel des décisions", &date_recue(invite_recue(chat)))
    );
    assert_eq!(b.faux.entrees()[e0 + 1], ["Le dépôt cible bash 3.2", "Fait inédit du doublon"]);

    // Deux faits identiques dans la même réponse : un seul souvenir.
    b.faux.scripter(vec![contenu(r#"{"memory":[{"text":"Fait répété"},{"text":"Fait répété"},{"text":"Fait unique"}]}"#)]);
    assert_eq!(memoires(&ok(&inferer(s, "Liste répétée", "ag-ac3b").await)), ["Fait répété", "Fait unique"]);
    assert_eq!(tous(s, "ag-ac3b").await["total"], 2);
    assert_eq!(b.faux.entrees().last().unwrap(), &["Fait répété", "Fait répété", "Fait unique"]);

    // Un doublon hors du top 10 (11 souvenirs plus proches de la requête) EST recréé.
    let lointain = "Fait lointain zéphyr";
    ajouter(s, lointain, "ag-ac3c").await;
    let proches: Vec<String> =
        ["un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze"].iter().map(|n| format!("alpha beta gamma {n}")).collect();
    for p in &proches {
        ajouter(s, p, "ag-ac3c").await;
    }
    let requete = "alpha beta gamma";
    let c_lointain = cosinus(&format!("user: {requete} "), lointain);
    assert!(
        proches.iter().all(|p| cosinus(&format!("user: {requete} "), p) > c_lointain + 1e-6),
        "précondition : les 11 souvenirs sont plus proches que le doublon"
    );
    b.faux.scripter(vec![contenu(r#"{"memory":[{"text":"Fait lointain zéphyr"}]}"#)]);
    assert_eq!(memoires(&ok(&inferer(s, requete, "ag-ac3c").await)), [lointain]);
    let all = tous(s, "ag-ac3c").await;
    assert_eq!(all["total"], 13);
    assert_eq!(memoires(&all).iter().filter(|m| **m == lointain).count(), 2);
    let invite_c = invite_recue(b.faux.requetes_chat().last().unwrap()).to_owned();
    assert_eq!(invite_c.matches("\"text\": \"alpha beta gamma").count(), 10, "Existing Memories = top 10");
    assert!(!invite_c.contains(lointain));
}

#[tokio::test(flavor = "multi_thread")]
async fn ac4_ac5_reponses_degradees() {
    let b = banc("ac4-ac5-infer").await;
    let s = &b.serveur;
    let enveloppe = |v: Value| ReponseChat::Enveloppe(v);
    let message = |content: Value| {
        json!({"id": "c", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]})
    };
    // (réponse scriptée, statut attendu) ; aucun souvenir dans tous les cas.
    let cas: Vec<(ReponseChat, u16)> = vec![
        (contenu("Pas de JSON dans cette réponse."), 200),
        (contenu(r#"{"faits":[{"text":"Fait ignoré"}]}"#), 200),
        (contenu(r#"["a"]"#), 200),
        (contenu(r#"{"memory":[]}"#), 200),
        (contenu(r#"{"memory":null}"#), 200),
        (contenu(r#"{"memory":{}}"#), 200),
        (contenu(""), 200),
        (contenu(r#"{"memory":[{"nope":1}]}"#), 200),
        (contenu(r#"{"memory":[{"text":123}]}"#), 200),
        (contenu(r#"{"memory":[{"text":""},{"text":null}]}"#), 200),
        (enveloppe(message(Value::Null)), 200),
        (enveloppe(message(json!(5))), 200),
        (enveloppe(message(json!([{"type": "text", "text": "{\"memory\":[]}"}]))), 200),
        (contenu(r#"{"memory":"x"}"#), 500),
        (contenu(r#"{"memory":["str"]}"#), 500),
        (contenu(r#"{"memory":{"a":1}}"#), 500),
        (contenu(r#"{"memory":5}"#), 500),
        (contenu(r#"{"memory":true}"#), 500),
        (contenu(r#"{"memory":[{"text":"F"},null]}"#), 500),
        (contenu(r#"{"memory":[{"text":["a"]}]}"#), 500),
        (contenu(r#"{"memory":[{"text":{"a":1}}]}"#), 500),
        (enveloppe(json!({"id": "c", "choices": []})), 500),
        (enveloppe(json!({"id": "c", "choices": [{"message": "texte"}]})), 500),
        (contenu("Voici : {\"memory\":\"x\"} et du texte"), 500),
    ];
    for (i, (reponse, statut)) in cas.into_iter().enumerate() {
        let agent = format!("deg-{i}");
        let n0 = b.faux.requetes_chat().len();
        b.faux.scripter(vec![reponse.clone()]);
        let r = inferer(s, "Réponse dégradée", &agent).await;
        if statut == 200 {
            assert_eq!(ok(&r), json!({"results": []}), "cas {i} : {reponse:?}");
        } else {
            assert_500(&r);
        }
        assert_eq!(b.faux.requetes_chat().len(), n0 + 1, "cas {i} : un seul appel chat");
        assert_eq!(tous(s, &agent).await, json!({"total": 0, "results": []}), "cas {i} : {reponse:?}");
    }
    assert!(s.journal().contains("extraction"), "une lecture en échec est journalisée : {}", s.journal());

    // Réponses tolérées : le fait est extrait.
    let tolerees = [
        ("```json\n<think>raisonnement</think>{\"memory\":[{\"text\":\"Fait balisé\"}]}\n```", "Fait balisé"),
        ("Voici: {\"memory\":[{\"text\":\"Fait entouré\"}]} fin", "Fait entouré"),
        ("{\"memory\":[{\"text\":\"Fait suivi\"}]} trailing", "Fait suivi"),
        ("{\"memory\":[{\"text\":\"a\tb\"}]}", "a\tb"),
        ("{\"memory\":[{\"text\":\"  \"}]}", "  "),
    ];
    for (i, (reponse, fait)) in tolerees.into_iter().enumerate() {
        let agent = format!("tol-{i}");
        b.faux.scripter(vec![contenu(reponse)]);
        assert_eq!(memoires(&ok(&inferer(s, "Réponse tolérée", &agent).await)), [fait], "{reponse:?}");
        assert_eq!(memoires(&tous(s, &agent).await), [fait]);
    }

    // Un text non chaîne : repli texte par texte, le fait chaîne est gardé.
    b.faux.scripter(vec![contenu(r#"{"memory":[{"text":"Fait gardé"},{"text":7}]}"#)]);
    let e0 = b.faux.entrees().len();
    assert_eq!(memoires(&ok(&inferer(s, "Repli", "repli").await)), ["Fait gardé"]);
    assert_eq!(b.faux.entrees()[e0..], [vec!["user: Repli ".to_owned()], vec!["Fait gardé".to_owned()]]);
}

#[tokio::test(flavor = "multi_thread")]
async fn ac5_messages_sauves_seulement_sur_200() {
    let b = banc("ac5-infer").await;
    let s = &b.serveur;
    let agent = "ag-ac5";
    let derniere_invite = |b: &Banc| invite_recue(b.faux.requetes_chat().last().unwrap()).to_owned();

    // A : 200 (réponse illisible), message sauvé ; plus de 300 points de code.
    let a = "Premier message de la suite, accentué. ".repeat(12);
    assert!(a.chars().count() > 300);
    b.faux.scripter(vec![contenu("Pas de JSON")]);
    ok(&inferer(s, &a, agent).await);
    // B : 500 (memory non liste), C : 500 (chat en erreur) : non sauvés.
    b.faux.scripter(vec![contenu(r#"{"memory":"x"}"#)]);
    assert_500(&inferer(s, "Deuxième message", agent).await);
    b.faux.scripter(vec![ReponseChat::Statut(400)]);
    assert_500(&inferer(s, "Troisième message", agent).await);
    // D : seul A figure dans Last k Messages, tronqué à 300 + "...".
    let d = "Quatrième message";
    ok(&inferer(s, d, agent).await);
    let tronque: String = a.chars().take(300).collect();
    let i = derniere_invite(&b);
    assert_eq!(i, invite(&[format!("user: {tronque}...")], &[], d, &date_recue(&i)));

    // Éviction : au plus 10 messages par scope, les plus récents.
    let suite: Vec<String> = (1..=10).map(|n| format!("Message {n}")).collect();
    for m in &suite {
        ok(&inferer(s, m, agent).await);
    }
    ok(&inferer(s, "Dernier", agent).await);
    let i = derniere_invite(&b);
    let attendus: Vec<String> = suite.iter().map(|m| format!("user: {m}")).collect();
    assert_eq!(i, invite(&attendus, &[], "Dernier", &date_recue(&i)));
    assert_eq!(tous(s, agent).await["total"], 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn ac6_chat_500_trois_essais_sans_ecriture() {
    let b = banc("ac6-infer").await;
    let s = &b.serveur;
    b.faux.scripter(vec![ReponseChat::Statut(500); 3]);
    let debut = std::time::Instant::now();
    assert_500(&inferer(s, "LLM en panne", "ag-ac6").await);
    assert!(debut.elapsed() >= Duration::from_millis(1400), "nouvelles tentatives attendues (0,5 s puis 1 s)");
    let requetes = b.faux.requetes_chat();
    assert_eq!(requetes.len(), 3, "3 essais au plus");
    assert!(requetes.iter().all(|r| r == &requetes[0]), "les 3 essais portent le même corps");
    assert_eq!(b.faux.appels(), 1, "seul l'embedding de la requête");
    assert_eq!(tous(s, "ag-ac6").await, json!({"total": 0, "results": []}));
    assert!(s.journal().contains("extraction"), "{}", s.journal());
    // Le message n'a pas été sauvé : l'appel suivant a un Last k Messages vide.
    ok(&inferer(s, "Après la panne", "ag-ac6").await);
    let i = invite_recue(b.faux.requetes_chat().last().unwrap()).to_owned();
    assert_eq!(i, invite(&[], &[], "Après la panne", &date_recue(&i)));
}
