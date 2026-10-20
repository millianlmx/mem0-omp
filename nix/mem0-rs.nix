# mem0-rs (S-1 d'orchestrator-living-in-a-vps) : le serveur mémoire Rust du dépôt.
# La crate exige rust 1.89 (édition 2024) : nixos-unstable la fournit. rusqlite
# `bundled` et sqlite-vec compilent du C (cc de stdenv) ; aws-lc-sys (rustls) peut
# réclamer cmake à la compilation, pas à la configuration du paquet.
{
  lib,
  rustPlatform,
  cmake,
}:
let
  cargoToml = builtins.fromTOML (builtins.readFile ../mem0-stack/mem0-rs/Cargo.toml);
in
rustPlatform.buildRustPackage {
  pname = "mem0-rs";
  inherit (cargoToml.package) version;
  src = lib.cleanSourceWith {
    src = ../mem0-stack/mem0-rs;
    # `target/` (build local) n'a rien à faire dans le store ; en flake il n'est de toute façon pas suivi.
    filter = path: type: baseNameOf path != "target";
  };
  cargoLock.lockFile = ../mem0-stack/mem0-rs/Cargo.lock;
  nativeBuildInputs = [ cmake ];
  dontUseCmakeConfigure = true;
  # Les tests de la crate lancent des serveurs : la preuve de bout en bout est test/req/vps-mem0-proxy.
  doCheck = false;
  meta = {
    description = "Service mémoire HTTP de mem0-omp (SQLite + sqlite-vec)";
    mainProgram = "mem0-rs";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ];
  };
}
