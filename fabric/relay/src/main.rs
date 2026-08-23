use hii_fabric_relay::RelayConfig;

fn main() {
    let config = RelayConfig::default();
    println!(
        "HII Fabric relay foundation ready (local store, no network listener; max ciphertext {} bytes)",
        config.max_ciphertext_bytes
    );
}
