//! Horodatage au format de `datetime.now(timezone.utc).isoformat()` (D-1).
//!
//! Python écrit `AAAA-MM-JJTHH:MM:SS.ffffff+00:00` et omet `.ffffff` quand les
//! microsecondes valent 0. La précision est la microseconde : les nanosecondes
//! de l'horloge sont tronquées, comme dans `datetime`.

use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};

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

/// Microsecondes Unix d'une date de la source (import, S-5) :
/// `AAAA-MM-JJTHH:MM:SS`, puis facultativement `.` et 1 à 6 chiffres (complétés
/// à droite jusqu'à 6), puis un fuseau facultatif `Z` ou `±HH:MM` ; sans fuseau,
/// la date est lue en UTC. `None` : tout autre format, ou une date impossible.
pub fn micros_depuis_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let nombre = |de: usize, n: usize| -> Option<u32> {
        b.get(de..de + n)?
            .iter()
            .try_fold(0u32, |acc, &c| c.is_ascii_digit().then(|| acc * 10 + u32::from(c - b'0')))
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (annee, mois, jour) = (nombre(0, 4)?, nombre(5, 2)?, nombre(8, 2)?);
    let (heure, minute, seconde) = (nombre(11, 2)?, nombre(14, 2)?, nombre(17, 2)?);
    let mut i = 19;
    let mut micros = 0;
    if b.get(i) == Some(&b'.') {
        let debut = i + 1;
        i = debut;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        let n = i - debut;
        if n == 0 || n > 6 {
            return None;
        }
        micros = nombre(debut, n)? * 10u32.pow((6 - n) as u32);
    }
    let decalage = match &b[i..] {
        [] | [b'Z'] => 0,
        [signe @ (b'+' | b'-'), _, _, b':', _, _] => {
            let (h, m) = (nombre(i + 1, 2)?, nombre(i + 4, 2)?);
            if h > 23 || m > 59 {
                return None;
            }
            let secondes = i32::try_from(h * 3600 + m * 60).ok()?;
            if *signe == b'-' { -secondes } else { secondes }
        }
        _ => return None,
    };
    let date = Date::from_calendar_date(i32::try_from(annee).ok()?, Month::try_from(u8::try_from(mois).ok()?).ok()?, u8::try_from(jour).ok()?).ok()?;
    let heure = Time::from_hms_micro(u8::try_from(heure).ok()?, u8::try_from(minute).ok()?, u8::try_from(seconde).ok()?, micros).ok()?;
    let t = PrimitiveDateTime::new(date, heure).assume_offset(UtcOffset::from_whole_seconds(decalage).ok()?);
    i64::try_from(t.unix_timestamp_nanos().div_euclid(1000)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn micros_depuis_iso_formats_acceptes() {
        let base = micros_depuis_iso("2026-10-12T10:00:00").unwrap();
        assert_eq!(base, depuis(date(2026, 10, 12, 10, 0, 0, 0)).micros);
        assert_eq!(micros_depuis_iso("2026-10-12T10:00:00Z"), Some(base));
        assert_eq!(micros_depuis_iso("2026-10-12T10:00:00+00:00"), Some(base));
        assert_eq!(micros_depuis_iso("2026-10-12T12:00:00+02:00"), Some(base));
        assert_eq!(micros_depuis_iso("2026-10-12T08:30:00-01:30"), Some(base));
        assert_eq!(micros_depuis_iso("2026-10-12T10:00:00.5"), Some(base + 500_000));
        assert_eq!(micros_depuis_iso("2026-10-12T10:00:00.12"), Some(base + 120_000));
        assert_eq!(micros_depuis_iso("2026-10-12T10:00:00.123456+00:00"), Some(base + 123_456));
        assert_eq!(micros_depuis_iso("2026-10-12T10:00:00.000007Z"), Some(base + 7));
        assert_eq!(micros_depuis_iso("1970-01-01T00:00:00"), Some(0));
    }

    #[test]
    fn micros_depuis_iso_rejets() {
        for faux in [
            "2026-10-12 10:00:00",
            "2026-10-1210:00:00",
            "2026-10-12T10:00:00.1234567",
            "2026-10-12T10:00:00.",
            "2026-10-12T10:00:00+0200",
            "2026-10-12T10:00:00z",
            "2026-10-12T10:00",
            "2026-13-12T10:00:00",
            "2026-02-30T10:00:00",
            "2026-10-12T24:00:00",
            "2026-10-12T10:00:00+24:00",
            "2026-10-12T10:00:00 ",
            "+026-10-12T10:00:00",
            "",
        ] {
            assert_eq!(micros_depuis_iso(faux), None, "{faux}");
        }
    }
}
