use hii_fabric_identity::{DeviceKeySubmission, IdentityAuthority, IdentityConfig};
use url::Url;

#[test]
fn public_bootstrap_exposes_only_hashed_recovery_material() {
    let config = IdentityConfig::new(
        "humaninformationinterface.com",
        Url::parse("https://app.humaninformationinterface.com").unwrap(),
    );
    let (authority, material) = IdentityAuthority::bootstrap(
        config,
        "owner-1",
        "Ummi",
        DeviceKeySubmission {
            device_id: "mac".into(),
            display_name: "Mac".into(),
            signing_public_key: vec![1; 32],
            encryption_public_key: vec![2; 32],
        },
        1,
        1_700_000_000_000,
    )
    .unwrap();

    let ledger = serde_json::to_string(authority.ledger()).unwrap();
    assert!(!ledger.contains(&material.recovery_codes[0]));
    assert!(!ledger.contains(&material.passkey_registration_secret));
    assert!(!ledger.contains("privateKey"));
    assert_eq!(authority.ledger().trust_epoch, 1);
}
