//! mem0-rs : service mémoire HTTP au contrat de mem0-http, stockage SQLite unique.
//!
//! `mem0-rs [--host <adresse>] [--port <port>]` ; configuration par variables
//! d'environnement (S-1). Codes de sortie : 0 arrêt propre, 1 erreur, 2 usage.
//! `mem0-rs import …` : import depuis mem0-http (module [`import`]).

mod bm25;
mod config;
mod db;
mod embedder;
mod extraction;
mod graphe;
mod horodatage;
mod http;
mod import;
mod openai;
mod recherche;
mod validation;
mod verrou;

use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use crate::config::{Config, Ecoute};

#[tokio::main]
async fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1).peekable();
    if args.next_if(|a| a == "import").is_some() {
        return import::executer(args).await;
    }
    let Ok(ecoute) = config::lire_arguments(args) else {
        eprintln!("{}", config::USAGE);
        return ExitCode::from(2);
    };
    let cfg = match config::lire_env(|nom| std::env::var(nom).ok()) {
        Ok(c) => c,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(1);
        }
    };
    match demarrer(&ecoute, cfg).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}

async fn demarrer(ecoute: &Ecoute, cfg: Config) -> Result<(), String> {
    let chemin = cfg.db_path.display().to_string();
    // Écoute d'abord : un port occupé ne doit pas laisser de base créée derrière lui.
    let Ecoute { host, port } = ecoute;
    let listener = tokio::net::TcpListener::bind((host.as_str(), *port))
        .await
        .map_err(|e| format!("écoute impossible sur {host}:{port} : {e}"))?;
    // Exclusivité (S-10) : gardé jusqu'au retour de `axum::serve`.
    let _verrou = verrou::prendre(&cfg.db_path).map_err(|e| {
        let lock = verrou::chemin(&cfg.db_path).display().to_string();
        match e {
            verrou::ErreurVerrou::Tenu => {
                format!("MEM0_DB_PATH={chemin} est déjà servie par un autre processus mem0-rs (verrou {lock})")
            }
            verrou::ErreurVerrou::Io(e) => format!("MEM0_DB_PATH={chemin} : verrou {lock} impossible : {e}"),
        }
    })?;
    let conn = db::ouvrir(&cfg.db_path, cfg.embedding_dims).map_err(|e| e.message(&chemin))?;
    let client = openai::client().map_err(|e| e.to_string())?;
    let embedder =
        embedder::Embedder::new(client.clone(), &cfg.base_url, &cfg.embed_model, &cfg.api_token, cfg.embedding_dims);
    let chat = openai::ClientChat::new(client, &cfg.base_url, &cfg.llm_model, &cfg.api_token);
    let etat = Arc::new(http::Etat {
        db: Arc::new(Mutex::new(conn)),
        embedder,
        chat,
        http_token: cfg.http_token.clone(),
        installation_token: cfg.installation_token.clone(),
    });
    eprintln!(
        "mem0-rs {} à l'écoute sur http://{host}:{port} (MEM0_DB_PATH={chemin}, embeddings {} via {}, LLM {})",
        env!("CARGO_PKG_VERSION"),
        cfg.embed_model,
        cfg.base_url,
        cfg.llm_model
    );
    axum::serve(listener, http::routeur(etat))
        .with_graceful_shutdown(signal_d_arret())
        .await
        .map_err(|e| format!("mem0-rs : serveur interrompu : {e}"))
}

/// SIGTERM ou SIGINT : arrêt propre, les requêtes en cours finissent.
async fn signal_d_arret() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
