use protocol::JsNumber;

fn spell(value: f64) -> String {
    serde_json::to_string(&JsNumber::from(value)).unwrap()
}

#[test]
fn javascript_number_spelling() {
    let cases: &[(f64, &str)] = &[
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (-1.0, "-1"),
        (10.0, "10"),
        (42.0, "42"),
        (1000.0, "1000"),
        (-3.0, "-3"),
        (-1000.0, "-1000"),
        (0.5, "0.5"),
        (0.25, "0.25"),
        (1.5, "1.5"),
        (10.5, "10.5"),
        (1.1, "1.1"),
        (0.1, "0.1"),
        (-0.1, "-0.1"),
        (0.3, "0.3"),
        (0.30000000000000004, "0.30000000000000004"),
        (0.01, "0.01"),
        (1e-5, "0.00001"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (-1e-7, "-1e-7"),
        (1.5e-7, "1.5e-7"),
        (-1.5e-7, "-1.5e-7"),
        (8.99e-7, "8.99e-7"),
        (9.99e-7, "9.99e-7"),
        (1e16, "10000000000000000"),
        (1e20, "100000000000000000000"),
        (1.23e20, "123000000000000000000"),
        (123456789012345680000.0, "123456789012345680000"),
        (1e21, "1e+21"),
        (-1e21, "-1e+21"),
        (1.23e21, "1.23e+21"),
        (6.02214076e23, "6.02214076e+23"),
        (9007199254740991.0, "9007199254740991"),
        (9007199254740992.0, "9007199254740992"),
        (9007199254740994.0, "9007199254740994"),
        (-9007199254740991.0, "-9007199254740991"),
        (std::f64::consts::PI, "3.141592653589793"),
        (std::f64::consts::E, "2.718281828459045"),
        (f64::MAX, "1.7976931348623157e+308"),
        (f64::MIN_POSITIVE, "2.2250738585072014e-308"),
        (f64::from_bits(1), "5e-324"),
    ];
    assert!(cases.len() >= 40, "{}", cases.len());
    for (value, expected) in cases {
        assert_eq!(spell(*value), *expected, "{value}");
        let parsed: JsNumber = serde_json::from_str(expected).unwrap();
        assert_eq!(parsed.as_f64(), *value, "{expected}");
        assert_eq!(spell(parsed.as_f64()), *expected, "{expected}");
    }
}

#[test]
fn large_integer_token_round_trips() {
    let token = "123456789012345680000";
    let parsed: JsNumber = serde_json::from_str(token).unwrap();
    assert_eq!(parsed.as_f64(), 123456789012345680000.0);
    assert_eq!(spell(parsed.as_f64()), token);
}

#[test]
fn whole_numbers_do_not_grow_a_decimal() {
    let parsed: JsNumber = serde_json::from_str("1000.0").unwrap();
    assert_eq!(serde_json::to_string(&parsed).unwrap(), "1000");
    assert_eq!(spell(-0.0), "0");
}

#[test]
fn non_finite_values_serialize_as_null() {
    assert_eq!(spell(f64::NAN), "null");
    assert_eq!(spell(f64::INFINITY), "null");
    assert_eq!(spell(f64::NEG_INFINITY), "null");
    assert!(serde_json::from_str::<JsNumber>("null").is_err());
}

#[test]
fn integer_accessors_reject_fractions_and_out_of_range_values() {
    assert_eq!(JsNumber::from(1000.0).as_i64(), Some(1000));
    assert_eq!(JsNumber::from(1000.0).as_u64(), Some(1000));
    assert_eq!(JsNumber::from(-0.0).as_u64(), Some(0));
    assert_eq!(JsNumber::from(-1.0).as_u64(), None);
    assert_eq!(JsNumber::from(1.5).as_i64(), None);
    assert_eq!(
        JsNumber::from(9007199254740992.0).as_i64(),
        Some(9007199254740992)
    );
    assert_eq!(JsNumber::from(f64::NAN).as_i64(), None);
    assert_eq!(JsNumber::from(f64::INFINITY).as_u64(), None);
    assert_eq!(JsNumber::from(18446744073709551616.0).as_u64(), None);
    assert_eq!(JsNumber::from(9223372036854775808.0).as_i64(), None);
}
