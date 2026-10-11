use std::cmp::Ordering;
use std::os::unix::fs::PermissionsExt;

use protocol::digest::{sha256_hex, sha256_hex_js};
use protocol::host::{
    FsError, MapEnv, access, copy_file, home_dir, lstat, mkdir, open_read, open_write, read_dir,
    read_link, read_text, realpath, rename, rmdir, stat, symlink, unlink, write_text,
};
use protocol::js::{
    JsString, JsValue, date_parse, default_locale, from_serde, js_boolean, js_replace,
    js_replace_all_string, js_replace_string, js_slice, js_slice_units, js_string, js_substring,
    js_substring_units, js_trim_end_units, js_trim_start_units, js_trim_units, local_date_parts,
    local_timestamp, locale_compare, number_to_locale_string, number_to_locale_string_en,
    number_to_locale_string_en_us, posix_basename, posix_dirname, posix_extname, posix_is_absolute,
    posix_join, posix_normalize, posix_relative, posix_resolve, resolved_time_zone,
    time_zone_name_short, timezone_offset_minutes, to_fixed, to_iso_string, to_locale_string,
    to_locale_string_en_us_time_zone, to_locale_time_string_en_us_hour24, utc_day,
};
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(include_str!("golden/js-semantics.json")).unwrap()
}

fn units_of(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_u64().unwrap() as u16)
        .collect()
}

fn optional_number(value: &Value, undefined_key: &str, value_key: &str) -> Option<f64> {
    if value[undefined_key].as_bool() == Some(true) {
        None
    } else {
        match &value[value_key] {
            Value::Null => Some(f64::NAN),
            Value::Number(number) => Some(number.as_f64().unwrap()),
            _ => Some(f64::NAN),
        }
    }
}

fn case_payload(case: &Value) -> Value {
    if let Some(value) = case.get("value") {
        value.clone()
    } else {
        serde_json::from_str(case["json"].as_str().unwrap_or("null")).unwrap()
    }
}

fn number_case(case: &Value) -> f64 {
    if case.get("neg_zero").and_then(Value::as_bool) == Some(true)
        || case.get("is_neg_zero").and_then(Value::as_bool) == Some(true)
    {
        return -0.0;
    }
    match &case_payload(case) {
        Value::String(text) if text == "NaN" => f64::NAN,
        Value::String(text) if text == "Infinity" => f64::INFINITY,
        Value::String(text) if text == "-Infinity" => f64::NEG_INFINITY,
        Value::Number(number) => number.as_f64().unwrap(),
        Value::Null => {
            if case.get("is_nan").and_then(Value::as_bool) == Some(true) {
                f64::NAN
            } else {
                match case.get("is_inf").and_then(Value::as_i64).unwrap_or(0) {
                    1 => f64::INFINITY,
                    -1 => f64::NEG_INFINITY,
                    _ => 0.0,
                }
            }
        }
        _ => panic!("number"),
    }
}

fn js_value(case: &Value) -> JsValue {
    let payload = case_payload(case);
    match case["kind"].as_str().unwrap() {
        "number" => JsValue::Number(number_case(case)),
        "string" => JsValue::from_text(payload.as_str().unwrap()),
        "boolean" => JsValue::Bool(payload.as_bool().unwrap()),
        "null" => JsValue::Null,
        "array" | "object" => from_serde(&payload),
        other => panic!("{other}"),
    }
}

#[test]
fn utf16_length_slice_and_substring() {
    let root = golden();
    for case in root["utf16"]["length"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        assert_eq!(
            JsString::from_units(text).len(),
            case["length"].as_u64().unwrap() as usize
        );
    }
    for case in root["utf16"]["slice"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        let start = optional_number(case, "start_undefined", "start");
        let end = optional_number(case, "end_undefined", "end");
        let actual = js_slice_units(&text, start, end);
        assert_eq!(actual, units_of(&case["result"]));
        if let Ok(utf8) = String::from_utf16(&text) {
            assert_eq!(js_slice(&utf8, start, end).units(), actual.as_slice());
        }
    }
    for case in root["utf16"]["substring"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        let start = optional_number(case, "start_undefined", "start");
        let end = optional_number(case, "end_undefined", "end");
        let actual = js_substring_units(&text, start, end);
        assert_eq!(actual, units_of(&case["result"]));
        if let Ok(utf8) = String::from_utf16(&text) {
            assert_eq!(js_substring(&utf8, start, end).units(), actual.as_slice());
        }
    }
}

#[test]
fn trim_matches_whitespace() {
    for case in golden()["trim"].as_array().unwrap() {
        let text = units_of(&case["text"]);
        assert_eq!(js_trim_units(&text), units_of(&case["trim"]).as_slice());
        assert_eq!(
            js_trim_start_units(&text),
            units_of(&case["trim_start"]).as_slice()
        );
        assert_eq!(
            js_trim_end_units(&text),
            units_of(&case["trim_end"]).as_slice()
        );
    }
}

#[test]
fn string_and_boolean() {
    let root = golden();
    for case in root["to_string"].as_array().unwrap() {
        assert_eq!(
            js_string(&js_value(case)).to_utf8(),
            case["string"].as_str().unwrap()
        );
    }
    for case in root["truthy"].as_array().unwrap() {
        assert_eq!(
            js_boolean(&js_value(case)),
            case["truthy"].as_bool().unwrap()
        );
    }
}

#[test]
fn to_fixed_and_number_locale() {
    let root = golden();
    for case in root["to_fixed"].as_array().unwrap() {
        let digits = case["digits"].as_f64().unwrap();
        let result = to_fixed(number_case(case), digits);
        if let Some(error) = case.get("error").and_then(Value::as_str) {
            assert_eq!(result.unwrap_err().to_string(), error);
        } else {
            assert_eq!(result.unwrap(), case["result"].as_str().unwrap());
        }
    }
    for case in root["number_locale"].as_array().unwrap() {
        let value = number_case(case);
        assert_eq!(
            number_to_locale_string(value),
            case["default"].as_str().unwrap()
        );
        assert_eq!(
            number_to_locale_string_en_us(value),
            case["en_us"].as_str().unwrap()
        );
        assert_eq!(
            number_to_locale_string_en(value),
            case["en"].as_str().unwrap()
        );
    }
}

#[test]
fn iso_strings() {
    for case in golden()["iso"].as_array().unwrap() {
        let ms = match &case["ms"] {
            Value::Number(number) => number.as_f64().unwrap(),
            Value::String(text) if text == "NaN" => f64::NAN,
            Value::String(text) => text.parse().unwrap(),
            _ => panic!("ms"),
        };
        if let Some(error) = case.get("error").and_then(Value::as_str) {
            assert_eq!(to_iso_string(ms).unwrap_err().to_string(), error);
            assert_eq!(utc_day(ms).unwrap_err().to_string(), error);
        } else {
            assert_eq!(to_iso_string(ms).unwrap(), case["iso"].as_str().unwrap());
            assert_eq!(utc_day(ms).unwrap(), case["day"].as_str().unwrap());
        }
    }
}

#[test]
fn locale_compare_sorted_and_pairs() {
    let root = golden();
    let sorted: Vec<&str> = root["locale_compare"]["sorted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_str().unwrap())
        .collect();
    let mut items = sorted.clone();
    items.sort_by(|left, right| match locale_compare(left, right).unwrap() {
        value if value < 0 => Ordering::Less,
        value if value > 0 => Ordering::Greater,
        _ => Ordering::Equal,
    });
    assert_eq!(items, sorted);
    for case in root["locale_compare"]["pairs"].as_array().unwrap() {
        let sign =
            locale_compare(case["a"].as_str().unwrap(), case["b"].as_str().unwrap()).unwrap();
        assert_eq!(sign.signum(), case["sign"].as_i64().unwrap() as i32);
    }
}

#[test]
fn replace_regex_and_string() {
    let root = golden();
    for case in root["replace"].as_array().unwrap() {
        let text = JsString::from_units(units_of(&case["text"]));
        let replaced = js_replace(
            &text,
            case["source"].as_str().unwrap(),
            case["flags"].as_str().unwrap(),
            case["replacement"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(replaced.units(), units_of(&case["result"]).as_slice());
        if !case["result_string_pattern"].is_null() {
            let literal = js_replace_string(
                &text,
                case["source"].as_str().unwrap(),
                case["replacement"].as_str().unwrap(),
            );
            assert_eq!(
                literal.units(),
                units_of(&case["result_string_pattern"]).as_slice()
            );
        }
    }
    for case in root["replace_all_string"].as_array().unwrap() {
        let text = JsString::from_units(units_of(&case["text"]));
        let replaced = js_replace_all_string(
            &text,
            case["pattern"].as_str().unwrap(),
            case["replacement"].as_str().unwrap(),
        );
        assert_eq!(replaced.units(), units_of(&case["result"]).as_slice());
    }
}

#[test]
fn read_file_sha256_and_home() {
    let root = golden();
    let dir = std::env::temp_dir();
    for (index, case) in root["read_file_utf8"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let bytes = hex::decode(case["hex"].as_str().unwrap()).unwrap();
        let path = dir.join(format!("rr0-read-{}-{index}", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let text = read_text(&path).unwrap();
        assert_eq!(
            JsString::from_text(&text).units(),
            units_of(&case["units"]).as_slice()
        );
        std::fs::remove_file(&path).unwrap();
    }
    for case in root["sha256"].as_array().unwrap() {
        let text = JsString::from_units(units_of(&case["text"]));
        assert_eq!(sha256_hex_js(&text), case["hex"].as_str().unwrap());
        assert_eq!(
            sha256_hex(text.to_utf8().as_bytes()),
            case["hex"].as_str().unwrap()
        );
    }
    for case in root["homedir"].as_array().unwrap() {
        let mut env = MapEnv::new();
        let expected = if case["home"].is_null() {
            account_home()
        } else {
            env.set("HOME", case["home"].as_str().unwrap());
            Some(case["result"].as_str().unwrap().to_string())
        };
        assert_eq!(home_dir(&env), expected, "{}", case["label"]);
    }
}

fn account_home() -> Option<String> {
    let user = nix::unistd::User::from_uid(nix::unistd::Uid::current())
        .ok()
        .flatten()?;
    Some(user.dir.to_string_lossy().into_owned())
}

#[test]
fn dates_for_every_recorded_zone() {
    for block in golden()["dates"].as_array().unwrap() {
        let mut env = MapEnv::new();
        env.set("TZ", block["tz"].as_str().unwrap());
        assert_eq!(
            resolved_time_zone(&env),
            block["resolved"].as_str().unwrap()
        );
        assert_eq!(default_locale(), block["default_locale"].as_str().unwrap());
        for row in block["rows"].as_array().unwrap() {
            let ms = row["ms"].as_f64().unwrap();
            assert_eq!(
                to_locale_time_string_en_us_hour24(ms, &env),
                row["time_hhmm_h12false"].as_str().unwrap()
            );
            assert_eq!(
                to_locale_string(ms, &env),
                row["locale_string_default"].as_str().unwrap()
            );
            assert_eq!(
                to_locale_string_en_us_time_zone(ms, "America/New_York"),
                row["locale_string_en_us_new_york"].as_str().unwrap()
            );
            assert_eq!(
                time_zone_name_short(ms, &env),
                row["time_zone_short"].as_str().unwrap()
            );
            let parts = local_date_parts(ms, &env).unwrap();
            let expected = row["local_parts"].as_array().unwrap();
            assert_eq!(parts.year as i64, expected[0].as_i64().unwrap());
            assert_eq!(parts.month as i64, expected[1].as_i64().unwrap());
            assert_eq!(parts.day as i64, expected[2].as_i64().unwrap());
            assert_eq!(parts.hour as i64, expected[3].as_i64().unwrap());
            assert_eq!(parts.minute as i64, expected[4].as_i64().unwrap());
            assert_eq!(parts.second as i64, expected[5].as_i64().unwrap());
            assert_eq!(
                local_timestamp(ms, &env).unwrap(),
                row["local_ts"].as_str().unwrap()
            );
            assert_eq!(
                timezone_offset_minutes(ms, &env).unwrap() as i64,
                row["timezone_offset_minutes"].as_i64().unwrap()
            );
        }
        for item in block["date_parse"].as_array().unwrap() {
            let parsed = date_parse(item["text"].as_str().unwrap(), &env);
            match item["ms"].as_f64() {
                Some(ms) => assert_eq!(parsed, Some(ms), "{}", item["text"]),
                None => assert!(parsed.is_none(), "{}", item["text"]),
            }
        }
    }
}

#[test]
fn node_path_matches_posix() {
    let node = &golden()["node_path"];
    let cwd = node["cwd"].as_str().unwrap();
    for case in node["normalize"].as_array().unwrap() {
        assert_eq!(
            posix_normalize(case["p"].as_str().unwrap()),
            case["r"].as_str().unwrap(),
            "{}",
            case["p"]
        );
    }
    for case in node["dirname"].as_array().unwrap() {
        assert_eq!(
            posix_dirname(case["p"].as_str().unwrap()),
            case["r"].as_str().unwrap(),
            "{}",
            case["p"]
        );
    }
    for case in node["basename"].as_array().unwrap() {
        let path = case["p"].as_str().unwrap();
        assert_eq!(
            posix_basename(path, None),
            case["r"].as_str().unwrap(),
            "{path}"
        );
        assert_eq!(
            posix_basename(path, Some(".txt")),
            case["r_ext"].as_str().unwrap(),
            "{path}"
        );
    }
    for case in node["extname"].as_array().unwrap() {
        assert_eq!(
            posix_extname(case["p"].as_str().unwrap()),
            case["r"].as_str().unwrap(),
            "{}",
            case["p"]
        );
    }
    for case in node["is_absolute"].as_array().unwrap() {
        assert_eq!(
            posix_is_absolute(case["p"].as_str().unwrap()),
            case["r"].as_bool().unwrap(),
            "{}",
            case["p"]
        );
    }
    for case in node["join"].as_array().unwrap() {
        let parts: Vec<&str> = case["a"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(posix_join(&parts), case["r"].as_str().unwrap());
    }
    for case in node["resolve"].as_array().unwrap() {
        let parts: Vec<&str> = case["a"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap())
            .collect();
        assert_eq!(posix_resolve(cwd, &parts), case["r"].as_str().unwrap());
    }
    for case in node["relative"].as_array().unwrap() {
        assert_eq!(
            posix_relative(
                cwd,
                case["from"].as_str().unwrap(),
                case["to"].as_str().unwrap()
            ),
            case["r"].as_str().unwrap(),
            "{} -> {}",
            case["from"],
            case["to"]
        );
    }
}

#[test]
fn filesystem_errors_match_node() {
    let root = std::env::temp_dir().join(format!("rr0-fs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("file.txt");
    write_text(&file, "x").unwrap();
    let dir = root.join("dir");
    mkdir(&dir).unwrap();
    write_text(&dir.join("inner"), "y").unwrap();
    let locked = root.join("locked.txt");
    write_text(&locked, "z").unwrap();
    let mut permissions = std::fs::metadata(&locked).unwrap().permissions();
    permissions.set_mode(0o0);
    std::fs::set_permissions(&locked, permissions.clone()).unwrap();
    let missing = root.join("missing.txt");
    let locked_denied = read_text(&locked).is_err();
    for case in golden()["fs_errors"].as_array().unwrap() {
        if case["op"].as_str() == Some("readFile(locked)") && !locked_denied {
            continue;
        }
        let err = fs_op(
            case["op"].as_str().unwrap(),
            &root,
            &file,
            &dir,
            &locked,
            &missing,
        );
        assert_fs(&err, case, &root);
    }
    permissions.set_mode(0o600);
    std::fs::set_permissions(&locked, permissions).unwrap();
    std::fs::remove_dir_all(&root).unwrap();
}

fn fs_op(
    op: &str,
    root: &std::path::Path,
    file: &std::path::Path,
    dir: &std::path::Path,
    locked: &std::path::Path,
    missing: &std::path::Path,
) -> FsError {
    let under_file = file.join("x");
    let missing_child = missing.join("x");
    let dest_b = root.join("b");
    let dest_c = root.join("c");
    match op {
        "readFile(dir)" => read_text(dir).unwrap_err(),
        "readFile(missing)" => read_text(missing).unwrap_err(),
        "readFile(locked)" => read_text(locked).unwrap_err(),
        "writeFile(dir)" => write_text(dir, "a").unwrap_err(),
        "writeFile(under file)" => write_text(&under_file, "a").unwrap_err(),
        "mkdir(existing)" => mkdir(dir).unwrap_err(),
        "mkdir(missing parent)" => mkdir(&missing_child).unwrap_err(),
        "rmdir(non-empty)" => rmdir(dir).unwrap_err(),
        "readdir(file)" => read_dir(file).unwrap_err(),
        "readdir(missing)" => read_dir(missing).unwrap_err(),
        "stat(missing)" => stat(missing).unwrap_err(),
        "lstat(missing)" => lstat(missing).unwrap_err(),
        "unlink(missing)" => unlink(missing).unwrap_err(),
        "unlink(dir)" => unlink(dir).unwrap_err(),
        "rename(missing)" => rename(missing, &dest_b).unwrap_err(),
        "open(missing, r)" => open_read(missing).unwrap_err(),
        "open(dir, w)" => open_write(dir).unwrap_err(),
        "copyFile(missing)" => copy_file(missing, &dest_c).unwrap_err(),
        "realpath(missing)" => realpath(missing).unwrap_err(),
        "access(missing)" => access(missing).unwrap_err(),
        "readlink(file)" => read_link(file).unwrap_err(),
        "symlink(existing)" => symlink(file, dir).unwrap_err(),
        other => panic!("{other}"),
    }
}

fn assert_fs(err: &FsError, case: &Value, root: &std::path::Path) {
    let root_text = root.display().to_string();
    let norm = |text: &str| text.replace(&root_text, "<ROOT>");
    assert_eq!(err.code, case["code"].as_str().unwrap(), "{}", case["op"]);
    assert_eq!(
        i64::from(err.errno),
        case["errno"].as_i64().unwrap(),
        "{}",
        case["op"]
    );
    assert_eq!(
        err.syscall,
        case["syscall"].as_str().unwrap(),
        "{}",
        case["op"]
    );
    assert_eq!(
        norm(&err.to_string()),
        case["message"].as_str().unwrap(),
        "{}",
        case["op"]
    );
    assert_eq!(
        err.path
            .as_deref()
            .map(|path| path.replace(&root_text, "<ROOT>")),
        case["path"].as_str().map(str::to_string),
        "{}",
        case["op"]
    );
    assert_eq!(
        err.dest
            .as_deref()
            .map(|path| path.replace(&root_text, "<ROOT>")),
        case["dest"].as_str().map(str::to_string),
        "{}",
        case["op"]
    );
    assert_eq!(
        norm(&err.node_string()),
        case["string"].as_str().unwrap(),
        "{}",
        case["op"]
    );
}
