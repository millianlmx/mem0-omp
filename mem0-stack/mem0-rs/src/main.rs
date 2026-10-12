//! mem0-rs : service mémoire HTTP au contrat de mem0-http, stockage SQLite unique.
//!
//! `mem0-rs [--host <adresse>] [--port <port>]` ; configuration par variables
//! d'environnement (S-1). Codes de sortie : 0 arrêt propre, 1 erreur, 2 usage.

mod bm25;
mod config;
mod db;
mod embedder;
mod graphe;
mod horodatage;
mod http;
mod recherche;
mod validation;

use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use crate::config::{Config, Ecoute};

#[tokio::main]
async fn main() -> ExitCode {
    let Ok(ecoute) = config::lire_arguments(std::env::args_os().skip(1)) else {
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
    let conn = db::ouvrir(&cfg.db_path, cfg.embedding_dims).map_err(|e| match e {
        db::ErreurOuverture::Dims { stockee, demandee } => format!(
            "MEM0_DB_PATH={chemin} a été créée avec EMBEDDING_DIMS={stockee}, la configuration demande {demandee}"
        ),
        db::ErreurOuverture::Autre(raison) => format!("MEM0_DB_PATH={chemin} : {raison}"),
    })?;
    let embedder = embedder::Embedder::new(&cfg.base_url, &cfg.embed_model, &cfg.api_token, cfg.embedding_dims)
        .map_err(|e| e.to_string())?;
    let etat = Arc::new(http::Etat {
        db: Arc::new(Mutex::new(conn)),
        embedder,
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
