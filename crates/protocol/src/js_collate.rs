use std::cmp::Ordering;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct CollateError {
    message: String,
}

pub fn locale_compare(left: &str, right: &str) -> Result<i32, CollateError> {
    let collator = collator()?;
    Ok(match collator.compare(left, right) {
        Ordering::Less => -1,
        Ordering::Equal => 0,
        Ordering::Greater => 1,
    })
}

fn collator() -> Result<icu_collator::CollatorBorrowed<'static>, CollateError> {
    let prefs = icu_collator::CollatorPreferences::from(icu_locale_core::locale!("en-US"));
    icu_collator::CollatorBorrowed::try_new(
        prefs,
        icu_collator::options::CollatorOptions::default(),
    )
    .map_err(|err| CollateError {
        message: err.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::locale_compare;

    #[test]
    fn default_en_us_orders_case() {
        assert!(locale_compare("a", "b").unwrap() < 0);
        assert_eq!(locale_compare("a", "a").unwrap(), 0);
        assert!(locale_compare("b", "a").unwrap() > 0);
    }
}
