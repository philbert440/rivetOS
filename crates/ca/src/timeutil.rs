use std::time::{Duration, SystemTime, UNIX_EPOCH};

use x509_cert::der::DateTime;
use x509_cert::time::Time;

use crate::error::{Error, wrap};

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

pub fn time_at(secs: u64) -> Result<Time, Error> {
    let when = UNIX_EPOCH + Duration::from_secs(secs);
    Time::try_from(when).map_err(wrap)
}

pub fn format_enddate(time: Time) -> String {
    let dt = time.to_date_time();
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS[usize::from(dt.month() - 1)];
    format!(
        "{month} {:2} {:02}:{:02}:{:02} {} GMT",
        dt.day(),
        dt.hour(),
        dt.minutes(),
        dt.seconds(),
        dt.year()
    )
}

pub fn format_index_time(time: Time) -> String {
    let dt = time.to_date_time();
    format!(
        "{:02}{:02}{:02}{:02}{:02}{:02}Z",
        dt.year() % 100,
        dt.month(),
        dt.day(),
        dt.hour(),
        dt.minutes(),
        dt.seconds()
    )
}

pub fn parse_index_time(text: &str) -> Result<Time, Error> {
    let bytes = text.as_bytes();
    if bytes.len() != 13 || bytes[12] != b'Z' || !bytes[..12].iter().all(u8::is_ascii_digit) {
        return Err(Error::msg(format!("bad index time {text}")));
    }
    let number =
        |offset: usize| u16::from(bytes[offset] - b'0') * 10 + u16::from(bytes[offset + 1] - b'0');
    let yy = number(0);
    let year = if yy >= 50 { 1900 + yy } else { 2000 + yy };
    let dt = DateTime::new(
        year,
        u8::try_from(number(2)).map_err(wrap)?,
        u8::try_from(number(4)).map_err(wrap)?,
        u8::try_from(number(6)).map_err(wrap)?,
        u8::try_from(number(8)).map_err(wrap)?,
        u8::try_from(number(10)).map_err(wrap)?,
    )
    .map_err(wrap)?;
    Ok(Time::from(dt))
}

#[cfg(test)]
mod tests {
    use super::{format_enddate, format_index_time, parse_index_time};
    use x509_cert::der::DateTime;
    use x509_cert::time::Time;

    #[test]
    fn enddate_matches_openssl_strftime() {
        let dt = DateTime::new(2027, 1, 8, 22, 47, 59).unwrap();
        let time = Time::from(dt);
        assert_eq!(format_enddate(time), "Jan  8 22:47:59 2027 GMT");
        assert_eq!(format_index_time(time), "270108224759Z");
        assert_eq!(
            parse_index_time("270108224759Z").unwrap().to_date_time(),
            dt
        );
        assert_eq!(
            format_enddate(Time::from(DateTime::new(2027, 1, 10, 1, 2, 3).unwrap())),
            "Jan 10 01:02:03 2027 GMT"
        );
    }
}
