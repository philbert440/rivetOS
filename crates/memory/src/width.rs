#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WidthMigrationDecision {
    Skip,
    Alter,
    Refuse,
}

pub fn decide_width_migration(
    typmod: Option<i64>,
    non_null_count: i64,
    target: i64,
) -> WidthMigrationDecision {
    match typmod {
        None => WidthMigrationDecision::Skip,
        Some(value) if value == target => WidthMigrationDecision::Skip,
        Some(_) if non_null_count > 0 => WidthMigrationDecision::Refuse,
        Some(_) => WidthMigrationDecision::Alter,
    }
}
