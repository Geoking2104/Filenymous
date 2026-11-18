use std::fs;

fn main() {
    // Version du sidecar `holochain` (bins/holochain-v<version>-<triple>) :
    // celle des crates d'API Holochain utilisées par l'app (Cargo.toml).
    let cargo_toml: toml::Value =
        toml::from_str(&fs::read_to_string("Cargo.toml").expect("Failed to read Cargo.toml"))
            .expect("Failed to parse Cargo.toml");
    let version = cargo_toml["dependencies"]["holochain_conductor_api"]
        .as_str()
        .expect("holochain_conductor_api version must be a plain string")
        .trim_start_matches(['=', '^', '~']);
    println!("cargo:rustc-env=HOLOCHAIN_VERSION={version}");
    println!("cargo:rerun-if-changed=Cargo.toml");

    tauri_build::build()
}
