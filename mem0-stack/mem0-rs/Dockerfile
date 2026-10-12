# Image de mem0-rs pour mem0-stack/docker-compose.yml, en deux étapes.
#
# Étape de build : rust:1.89-bookworm porte le MSRV de la crate (1.89, le plus
# haut de tout Cargo.lock) et le gcc/make de buildpack-deps. aws-lc-sys (hors
# FIPS), libsqlite3-sys `bundled`, sqlite-vec et ring n'ont besoin que d'un
# compilateur C : ni CMake, ni clang, ni OpenSSL, donc aucun apt-get ici.
FROM rust:1.89-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

# Étape d'exécution : même Debian que l'étape de build, donc même glibc.
# curl sert le healthcheck du compose (le binaire n'a pas de sous-commande
# santé) ; ca-certificates sert un oMLX joint en https.
#
# Pas d'instruction USER : la base vit dans un bind-mount d'un dossier de
# l'hôte, où un uid fixe non nul ne peut pas écrire sous Docker Linux. Sous
# podman rootless, ce root est l'utilisateur non privilégié de l'hôte.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/mem0-rs /usr/local/bin/mem0-rs
# Base SQLite et ses compagnons (-wal, -shm, .lock) dans le dossier monté.
ENV MEM0_DB_PATH=/data/mem0-rs.db
EXPOSE 8321
ENTRYPOINT ["/usr/local/bin/mem0-rs"]
CMD ["--host", "0.0.0.0", "--port", "8321"]
