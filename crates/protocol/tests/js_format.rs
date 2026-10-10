use protocol::js::{en_us_hour24_hhmm, to_fixed};

#[test]
fn to_fixed_follows_ecmascript() {
    let cases = [
        (0.0, 0, "0", "n = 0 and fractionDigits 0 is the string 0"),
        (
            0.0,
            1,
            "0.0",
            "n = 0 is padded to fractionDigits+1 zeros then split as 0.0",
        ),
        (
            -0.0,
            1,
            "0.0",
            "negative zero is not < 0, so no sign is prefixed",
        ),
        (
            1.5,
            0,
            "2",
            "1.5 is exact and halfway; the larger integer n is 2",
        ),
        (
            2.5,
            0,
            "3",
            "2.5 is exact and halfway; the larger integer n is 3, not ties-to-even 2",
        ),
        (
            -1.5,
            0,
            "-2",
            "the sign is applied after rounding the magnitude half away from zero",
        ),
        (
            0.25,
            1,
            "0.3",
            "0.25 is exact; n/10 candidates 0.2 and 0.3 are equidistant and the larger n is 3",
        ),
        (
            1.25,
            1,
            "1.3",
            "1.25 is exact and halfway between 1.2 and 1.3; the larger n wins",
        ),
        (
            6.25,
            1,
            "6.3",
            "6.25 is exact; (1 - 15/16) * 100 is this value, and toFixed(1) is 6.3",
        ),
        (
            6.25,
            2,
            "6.25",
            "two fraction digits land on the exact value, so no tie is involved",
        ),
        (
            90.0,
            1,
            "90.0",
            "90 is exact and already on a tenth, so the fraction digit is 0",
        ),
        (92.5, 1, "92.5", "92.5 is exact at one fraction digit"),
        (
            1.005,
            2,
            "1.00",
            "1.005 is not dyadic; its binary64 value is 1.0049999999999998934..., and n/100 is closer to 1.00 than to 1.01",
        ),
        (
            1e21,
            2,
            "1e+21",
            "10^21 is exact and the spec switches to Number::toString, which is 1e+21",
        ),
        (f64::NAN, 1, "NaN", "non-finite values use Number::toString"),
        (
            f64::INFINITY,
            1,
            "Infinity",
            "non-finite values use Number::toString",
        ),
        (
            f64::NEG_INFINITY,
            1,
            "-Infinity",
            "non-finite values use Number::toString",
        ),
    ];
    for (value, digits, expected, rule) in cases {
        assert_eq!(to_fixed(value, digits).as_deref(), Ok(expected), "{rule}");
    }
    let ratio = (1.0 - 15.0 / 16.0) * 100.0;
    assert_eq!(
        to_fixed(ratio, 1).as_deref(),
        Ok("6.3"),
        "compacting 16 messages to 15 is exactly 6.25 percent, and toFixed(1) rounds the tie to 6.3"
    );
    assert!(to_fixed(1.0, -1).is_err(), "fractionDigits below 0 throws");
    assert!(
        to_fixed(1.0, 101).is_err(),
        "fractionDigits above 100 throws"
    );
}

#[test]
fn en_us_hour24_prints_midnight_as_24() {
    let cases = [
        (
            0,
            0,
            "24:00",
            "en-US hour12:false resolves to hour cycle h24, and hour 0 is displayed as 24",
        ),
        (
            0,
            30,
            "24:30",
            "h24 uses 24 for the whole hour 0, not only for minute 00",
        ),
        (
            1,
            5,
            "01:05",
            "hour and minute are both 2-digit fields with a colon and no day period",
        ),
        (12, 0, "12:00", "noon stays 12 in h24"),
        (
            23,
            59,
            "23:59",
            "the last minute of the day stays in the 00-23 range except hour 0",
        ),
    ];
    for (hour, minute, expected, rule) in cases {
        assert_eq!(en_us_hour24_hhmm(hour, minute), expected, "{rule}");
    }
}
