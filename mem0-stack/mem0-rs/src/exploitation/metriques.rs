//! `GET /metrics` : l'état du service au format d'exposition texte de Prometheus
//! (requêtes par route et statut, latence, souvenirs, taille de la base, sauvegardes,
//! rêve), scruté avec le jeton du service (`X-Mem0-Token` ou `Authorization: Bearer`).
//!
//! Les compteurs HTTP vivent en mémoire et repartent de zéro au démarrage (Prometheus
//! lit la remise à zéro) ; souvenirs et taille sont relus à chaque lecture.

use std::collections::BTreeMap;
use std::fmt::Write;
use std::sync::Mutex;

/// Les bornes (secondes) de la latence d'une requête.
pub const BORNES: [f64; 11] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];

#[derive(Debug, Clone, Default)]
struct Histogramme {
    comptes: [u64; BORNES.len()],
    somme: f64,
    total: u64,
}

/// Les requêtes HTTP vues depuis le démarrage.
#[derive(Debug, Default)]
pub struct Metriques {
    requetes: Mutex<BTreeMap<(String, String, u16), u64>>,
    latences: Mutex<BTreeMap<(String, String), Histogramme>>,
}

impl Metriques {
    /// Une requête finie : sa route (le motif, jamais l'URL brute), sa méthode, son statut et sa durée.
    pub fn noter(&self, route: &str, methode: &str, statut: u16, secondes: f64) {
        if let Ok(mut r) = self.requetes.lock() {
            *r.entry((route.to_owned(), methode.to_owned(), statut)).or_default() += 1;
        }
        if let Ok(mut l) = self.latences.lock() {
            let h = l.entry((route.to_owned(), methode.to_owned())).or_default();
            h.somme += secondes;
            h.total += 1;
            for (i, borne) in BORNES.iter().enumerate() {
                if secondes <= *borne {
                    h.comptes[i] += 1;
                }
            }
        }
    }
}

/// Ce que l'exposition montre en plus des requêtes, lu au moment de la lecture.
#[derive(Debug, Clone, Default)]
pub struct Instantane {
    pub version: &'static str,
    pub uptime_s: u64,
    pub souvenirs: Option<i64>,
    pub octets_base: Option<u64>,
    pub derniere_sauvegarde_s: Option<u64>,
    pub sauvegarde_en_echec: bool,
    pub echecs_sauvegarde: u64,
    pub reve_actif: bool,
}

/// Une valeur d'étiquette échappée (`\`, `"`, saut de ligne).
fn echapper(valeur: &str) -> String {
    valeur.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

fn famille(sortie: &mut String, nom: &str, sorte: &str, aide: &str) {
    let _ = writeln!(sortie, "# HELP {nom} {aide}");
    let _ = writeln!(sortie, "# TYPE {nom} {sorte}");
}

/// Le texte d'exposition complet.
pub fn exposition(m: &Metriques, i: &Instantane) -> String {
    let mut s = String::new();
    famille(&mut s, "mem0_info", "gauge", "La version du service (valeur 1).");
    let _ = writeln!(s, "mem0_info{{version=\"{}\"}} 1", echapper(i.version));
    famille(&mut s, "mem0_uptime_seconds", "gauge", "Secondes depuis le démarrage.");
    let _ = writeln!(s, "mem0_uptime_seconds {}", i.uptime_s);
    if let Some(n) = i.souvenirs {
        famille(&mut s, "mem0_memories", "gauge", "Souvenirs en base.");
        let _ = writeln!(s, "mem0_memories {n}");
    }
    if let Some(n) = i.octets_base {
        famille(&mut s, "mem0_db_bytes", "gauge", "Taille de la base (fichier et WAL), en octets.");
        let _ = writeln!(s, "mem0_db_bytes {n}");
    }
    if let Some(t) = i.derniere_sauvegarde_s {
        famille(&mut s, "mem0_backup_last_success_timestamp_seconds", "gauge", "Instant du dernier instantané réussi.");
        let _ = writeln!(s, "mem0_backup_last_success_timestamp_seconds {t}");
    }
    famille(&mut s, "mem0_backup_failing", "gauge", "La dernière sauvegarde (locale ou distante) a échoué (1) ou non (0).");
    let _ = writeln!(s, "mem0_backup_failing {}", u8::from(i.sauvegarde_en_echec));
    famille(&mut s, "mem0_backup_failures_total", "counter", "Sauvegardes en échec depuis le démarrage.");
    let _ = writeln!(s, "mem0_backup_failures_total {}", i.echecs_sauvegarde);
    famille(&mut s, "mem0_dream_enabled", "gauge", "Le rêve de fond est actif (1) ou non (0).");
    let _ = writeln!(s, "mem0_dream_enabled {}", u8::from(i.reve_actif));

    famille(&mut s, "mem0_http_requests_total", "counter", "Requêtes HTTP par route, méthode et statut.");
    if let Ok(r) = m.requetes.lock() {
        for ((route, methode, statut), n) in r.iter() {
            let _ = writeln!(
                s,
                "mem0_http_requests_total{{route=\"{}\",method=\"{}\",status=\"{statut}\"}} {n}",
                echapper(route),
                echapper(methode)
            );
        }
    }
    famille(&mut s, "mem0_http_request_duration_seconds", "histogram", "Latence des requêtes HTTP par route et méthode.");
    if let Ok(l) = m.latences.lock() {
        for ((route, methode), h) in l.iter() {
            let etiquettes = format!("route=\"{}\",method=\"{}\"", echapper(route), echapper(methode));
            for (borne, n) in BORNES.iter().zip(h.comptes) {
                let _ = writeln!(s, "mem0_http_request_duration_seconds_bucket{{{etiquettes},le=\"{borne}\"}} {n}");
            }
            let _ = writeln!(s, "mem0_http_request_duration_seconds_bucket{{{etiquettes},le=\"+Inf\"}} {}", h.total);
            let _ = writeln!(s, "mem0_http_request_duration_seconds_sum{{{etiquettes}}} {}", h.somme);
            let _ = writeln!(s, "mem0_http_request_duration_seconds_count{{{etiquettes}}} {}", h.total);
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposition_cumulee_et_echappee() {
        let m = Metriques::default();
        m.noter("/memory/search", "POST", 200, 0.03);
        m.noter("/memory/search", "POST", 200, 2.0);
        m.noter("/memory/search", "POST", 401, 0.001);
        m.noter("inconnue", "GET", 404, 0.001);
        let i = Instantane { version: "0.1.0", souvenirs: Some(3), octets_base: Some(4096), ..Instantane::default() };
        let texte = exposition(&m, &i);
        for attendu in [
            "mem0_memories 3",
            "mem0_db_bytes 4096",
            "mem0_backup_failing 0",
            "mem0_http_requests_total{route=\"/memory/search\",method=\"POST\",status=\"200\"} 2",
            "mem0_http_requests_total{route=\"/memory/search\",method=\"POST\",status=\"401\"} 1",
            "mem0_http_request_duration_seconds_bucket{route=\"/memory/search\",method=\"POST\",le=\"0.05\"} 2",
            "mem0_http_request_duration_seconds_bucket{route=\"/memory/search\",method=\"POST\",le=\"2.5\"} 3",
            "mem0_http_request_duration_seconds_count{route=\"/memory/search\",method=\"POST\"} 3",
            "# TYPE mem0_http_request_duration_seconds histogram",
        ] {
            assert!(texte.lines().any(|l| l == attendu), "{attendu} absent de :\n{texte}");
        }
        assert!(!texte.contains("mem0_backup_last_success"), "sans instantané, pas d'instant");
        assert_eq!(echapper("a\"b\\c\nd"), "a\\\"b\\\\c\\nd");
    }
}
