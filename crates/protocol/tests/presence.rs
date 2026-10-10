use protocol::DelegationRequest;
use serde_json::json;

#[test]
fn presence_flag_omitted_when_unset_true_when_set_never_false() {
    let mut request = DelegationRequest {
        from_agent: "a".to_string(),
        to_agent: "b".to_string(),
        task: "t".to_string(),
        context: None,
        timeout_ms: None,
        no_delegation: false,
        model: None,
    };
    let value = serde_json::to_value(&request).unwrap();
    assert!(value.get("noDelegation").is_none());
    request.no_delegation = true;
    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(value.get("noDelegation"), Some(&json!(true)));
    let parsed: DelegationRequest =
        serde_json::from_str(r#"{"fromAgent":"a","toAgent":"b","task":"t","noDelegation":false}"#)
            .unwrap();
    assert!(!parsed.no_delegation);
    let again = serde_json::to_value(&parsed).unwrap();
    assert!(again.get("noDelegation").is_none());
}
