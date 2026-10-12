//! Horodatage au format de `datetime.now(timezone.utc).isoformat()` (D-1).
//!
//! Python écrit `AAAA-MM-JJTHH:MM:SS.ffffff+00:00` et omet `.ffffff` quand les
//! microsecondes valent 0. La précision est la microseconde : les nanosecondes
//! de l'horloge sont tronquées, comme dans `datetime`.

use time::OffsetDateTime;

/// Un instant UTC : son texte isoformat et sa valeur en microsecondes Unix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instant {
    pub iso: String,
    pub micros: i64,
}

/// L'instant présent, tronqué à la microseconde.
pub fn maintenant() -> Instant {
    depuis(OffsetDateTime::now_utc())
}

fn depuis(t: OffsetDateTime) -> Instant {
    let t = t.to_offset(time::UtcOffset::UTC);
    let micros = i64::try_from(t.unix_timestamp_nanos().div_euclid(1000)).unwrap_or(i64::MAX);
    let us = t.microsecond();
    let mut iso = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    );
    if us != 0 {
        iso.push_str(&format!(".{us:06}"));
    }
    iso.push_str("+00:00");
    Instant { iso, micros }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::{Date, Month, PrimitiveDateTime, Time};

    fn date(a: i32, m: u8, j: u8, h: u8, mi: u8, s: u8, ns: u32) -> OffsetDateTime {
        let d = Date::from_calendar_date(a, Month::try_from(m).unwrap(), j).unwrap();
        PrimitiveDateTime::new(d, Time::from_hms_nano(h, mi, s, ns).unwrap()).assume_utc()
    }
    #[test]
    fn microsecondes_a_zero_omises() {
        let t = date(2026, 10, 12, 10, 0, 0, 0);
        assert_eq!(depuis(t).iso, "2026-10-12T10:00:00+00:00");
    }

    #[test]
    fn microsecondes_sur_six_chiffres() {
        let t = date(2026, 10, 12, 10, 0, 0, 123_456_789);
        let i = depuis(t);
        assert_eq!(i.iso, "2026-10-12T10:00:00.123456+00:00");
        assert_eq!(i.micros % 1_000_000, 123_456);
        let t = date(2026, 1, 2, 3, 4, 5, 7_000);
        assert_eq!(depuis(t).iso, "2026-01-02T03:04:05.000007+00:00");
    }
}
