{
  description = "mem0-omp : l'orchestrateur de pipelines omp (omp-mem0-req), sa mémoire mem0-rs et leur module NixOS";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Le flake officiel d'oh-my-pi : `packages.<système>.omp` (binaire `bun --compile`).
    # Son `nixosModules.default` ne fait qu'ajouter le paquet : on ne l'importe pas.
    omp = {
      url = "github:can1357/oh-my-pi";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      omp,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forSystems (pkgs: {
        mem0-rs = pkgs.callPackage ./nix/mem0-rs.nix { };
        omp-mem0-plugins = pkgs.callPackage ./nix/plugins.nix { };
        omp-orchestrator = pkgs.callPackage ./nix/orchestrator-cli.nix { };
      });

      # `imports = [ inputs.mem0-omp.nixosModules.default ];` puis `services.omp-orchestrator.*`
      # (README § « Héberger l'orchestrateur sur un VPS NixOS »).
      nixosModules.default = import ./nix/module.nix { inherit self omp; };

      # Preuve des critères AC-1 à AC-4 : deux machines virtuelles, KVM requis.
      checks.x86_64-linux.vps = import ./nix/test-vps.nix {
        inherit self;
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
      };
    };
}
