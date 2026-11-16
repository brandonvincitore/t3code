use serde::Serialize;
use std::ffi::OsString;

#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    Telemetry,
    ProcessIdentity(u32),
}

pub fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Mode, &'static str> {
    let mut args = args.into_iter();
    let Some(flag) = args.next() else {
        return Ok(Mode::Telemetry);
    };
    let usage = "usage: t3-resource-monitor [--process-identity <positive-u32-pid>]";
    if flag != "--process-identity" {
        return Err(usage);
    }
    let value = args.next().ok_or(usage)?;
    let value = value.to_str().ok_or(usage)?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(usage);
    }
    let pid = value.parse::<u32>().map_err(|_| usage)?;
    if pid == 0 || args.next().is_some() {
        return Err(usage);
    }
    Ok(Mode::ProcessIdentity(pid))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pid: u32,
    ppid: u32,
    birth_id: String,
    started_at_upper_bound_ms: u64,
    zombie: bool,
}

pub fn read(pid: u32) -> Option<ProcessIdentity> {
    if pid == 0 || pid > i32::MAX as u32 {
        return None;
    }
    platform_read(pid)
}

#[cfg(any(target_os = "macos", test))]
fn microsecond_identity(
    pid: u32,
    ppid: u32,
    seconds: u64,
    micros: u64,
    zombie: bool,
) -> Option<ProcessIdentity> {
    if seconds == 0 || micros >= 1_000_000 {
        return None;
    }
    Some(ProcessIdentity {
        pid,
        ppid,
        birth_id: format!("{seconds}:{micros}"),
        started_at_upper_bound_ms: seconds
            .checked_mul(1_000)?
            .checked_add(micros.div_ceil(1_000))?,
        zombie,
    })
}

#[cfg(target_os = "macos")]
fn platform_read(pid: u32) -> Option<ProcessIdentity> {
    fn observe(pid: u32) -> Option<libc::proc_bsdinfo> {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = i32::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
        // libproc initializes the entire public struct only on a full-size return.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if written != size {
            return None;
        }
        let info = unsafe { info.assume_init() };
        if info.pbi_pid != pid || !(libc::SIDL..=libc::SZOMB).contains(&info.pbi_status) {
            return None;
        }
        Some(info)
    }
    let first = observe(pid)?;
    let last = observe(pid)?;
    if first.pbi_start_tvsec != last.pbi_start_tvsec
        || first.pbi_start_tvusec != last.pbi_start_tvusec
        || first.pbi_ppid != last.pbi_ppid
    {
        return None;
    }
    microsecond_identity(
        pid,
        last.pbi_ppid,
        last.pbi_start_tvsec,
        last.pbi_start_tvusec,
        last.pbi_status == libc::SZOMB,
    )
}

#[cfg(any(target_os = "linux", test))]
struct LinuxStat {
    ppid: u32,
    start_ticks: u64,
    zombie: bool,
}

#[cfg(any(target_os = "linux", test))]
fn parse_linux_stat(stat: &[u8], pid: u32) -> Option<LinuxStat> {
    let (_, ppid) = super::parse_proc_stat(stat)?;
    let open = stat.iter().position(|&byte| byte == b'(')?;
    let prefix = stat.get(..open)?.strip_suffix(b" ")?;
    if prefix.is_empty() || !prefix.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if std::str::from_utf8(prefix).ok()?.parse::<u32>().ok()? != pid {
        return None;
    }
    let close = stat.iter().rposition(|&byte| byte == b')')?;
    let fields = std::str::from_utf8(stat.get(close + 1..)?.strip_prefix(b" ")?).ok()?;
    let mut fields = fields.split_ascii_whitespace();
    let zombie = match fields.next()? {
        "Z" => true,
        "R" | "S" | "D" | "T" | "t" | "W" | "K" | "P" | "I" => false,
        _ => return None,
    };
    // starttime is field 22; state (field 3) has already been consumed.
    for _ in 4..22 {
        let field = fields.next()?;
        let digits = field.strip_prefix('-').unwrap_or(field);
        if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        field.parse::<i128>().ok()?;
    }
    let start = fields.next()?;
    if !start.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(LinuxStat {
        ppid,
        start_ticks: start.parse().ok()?,
        zombie,
    })
}

#[cfg(any(target_os = "linux", test))]
fn linux_birth_bound(
    ticks: u64,
    hz: u64,
    boot_before_ns: u128,
    realtime_ns: u128,
    boot_after_ns: u128,
) -> Option<u64> {
    if hz == 0 || boot_after_ns < boot_before_ns || realtime_ns < boot_after_ns {
        return None;
    }
    let hz = u128::from(hz);
    let tick_start = u128::from(ticks)
        .checked_mul(1_000_000_000)?
        .checked_div(hz)?;
    if tick_start > boot_before_ns {
        return None;
    }
    // The bracket's earliest boottime gives the latest boot epoch; ticks truncate birth time.
    let tick_end = u128::from(ticks)
        .checked_add(1)?
        .checked_mul(1_000_000_000)?
        .div_ceil(hz);
    let upper_ns = realtime_ns
        .checked_sub(boot_before_ns)?
        .checked_add(tick_end)?;
    u64::try_from(upper_ns.div_ceil(1_000_000)).ok()
}

#[cfg(target_os = "linux")]
fn platform_read(pid: u32) -> Option<ProcessIdentity> {
    fn clock_ns(clock: libc::clockid_t) -> Option<u128> {
        let mut time = std::mem::MaybeUninit::<libc::timespec>::uninit();
        // clock_gettime initializes both fields on success.
        if unsafe { libc::clock_gettime(clock, time.as_mut_ptr()) } != 0 {
            return None;
        }
        let time = unsafe { time.assume_init() };
        if time.tv_sec < 0 || !(0..1_000_000_000).contains(&time.tv_nsec) {
            return None;
        }
        (time.tv_sec as u128)
            .checked_mul(1_000_000_000)?
            .checked_add(time.tv_nsec as u128)
    }
    use std::io::{Read, Seek};

    // A single proc handle stays bound to the original task across PID reuse.
    let mut file = std::fs::File::open(format!("/proc/{pid}/stat")).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let first = parse_linux_stat(&bytes, pid)?;
    let hz = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).ok()?;
    let before = clock_ns(libc::CLOCK_BOOTTIME)?;
    let realtime = clock_ns(libc::CLOCK_REALTIME)?;
    let after = clock_ns(libc::CLOCK_BOOTTIME)?;
    let bound = linux_birth_bound(first.start_ticks, hz, before, realtime, after)?;
    file.rewind().ok()?;
    bytes.clear();
    file.read_to_end(&mut bytes).ok()?;
    let last = parse_linux_stat(&bytes, pid)?;
    if first.start_ticks != last.start_ticks || first.ppid != last.ppid {
        return None;
    }
    Some(ProcessIdentity {
        pid,
        ppid: last.ppid,
        birth_id: last.start_ticks.to_string(),
        started_at_upper_bound_ms: bound,
        zombie: last.zombie,
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn platform_read(_pid: u32) -> Option<ProcessIdentity> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn parses_only_the_standalone_identity_mode() {
        let parse = |args: &[&str]| parse_args(args.iter().map(|arg| OsString::from(*arg)));
        assert_eq!(parse(&[]), Ok(Mode::Telemetry));
        assert_eq!(
            parse(&["--process-identity", "42"]),
            Ok(Mode::ProcessIdentity(42))
        );
        for args in [
            vec!["--unknown"],
            vec!["--process-identity"],
            vec!["--process-identity", "0"],
            vec!["--process-identity", "-1"],
            vec!["--process-identity", "+1"],
            vec!["--process-identity", " 1"],
            vec!["--process-identity", "4294967296"],
            vec!["--process-identity", "42", "extra"],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }

    #[test]
    fn preserves_microsecond_identity_and_rounds_birth_up() {
        let first = microsecond_identity(42, 1, 100, 1, false).unwrap();
        let second = microsecond_identity(42, 1, 100, 999, false).unwrap();
        assert_eq!(first.birth_id, "100:1");
        assert_eq!(second.birth_id, "100:999");
        assert_eq!(first.started_at_upper_bound_ms, 100_001);
        assert_eq!(second.started_at_upper_bound_ms, 100_001);
        for (micros, expected) in [(0, 100_000), (1000, 100_001), (1001, 100_002)] {
            let identity = microsecond_identity(42, 1, 100, micros, true).unwrap();
            assert_eq!(identity.started_at_upper_bound_ms, expected);
            assert!(identity.zombie);
        }
        assert!(microsecond_identity(42, 1, 0, 0, false).is_none());
        assert!(microsecond_identity(42, 1, 100, 1_000_000, false).is_none());
        assert!(microsecond_identity(42, 1, u64::MAX, 0, false).is_none());
    }

    #[test]
    fn uses_the_upper_tick_edge_and_clock_bracket() {
        assert_eq!(
            linux_birth_bound(123, 100, 10_000_000_000, 100_000_000_001, 10_000_000_100),
            Some(91_241)
        );
        assert_eq!(
            linux_birth_bound(3, 3, 2_000_000_000, 100_000_000_000, 2_000_000_010),
            Some(99_334)
        );
        for (ticks, hz, before, real, after) in [
            (1, 0, 10, 100, 11),
            (1, 100, 11, 100, 10),
            (1, 100, 10, 5, 11),
            (100, 100, 10, 100, 11),
            (u64::MAX, 1, u64::MAX as u128, u128::MAX, u64::MAX as u128),
            (0, 100, 0, u128::MAX, 0),
        ] {
            assert_eq!(linux_birth_bound(ticks, hz, before, real, after), None);
        }
    }

    #[test]
    fn parses_linux_identity_with_arbitrary_stat_names_and_rejects_invalid_rows() {
        let row = |name: &str, state: &str, ticks: &str| {
            format!("42 ({name}) {state} 1 0 0 0 -1 0 0 0 0 0 0 0 0 0 0 0 0 0 {ticks} 0\n")
        };
        for name in ["normal", "a) b (c)", "name\nwith newline"] {
            let stat = parse_linux_stat(row(name, "S", "123").as_bytes(), 42).unwrap();
            assert_eq!((stat.ppid, stat.start_ticks, stat.zombie), (1, 123, false));
        }
        assert!(
            parse_linux_stat(row("zombie", "Z", "123").as_bytes(), 42)
                .unwrap()
                .zombie
        );
        for bytes in [
            b"42 (truncated".to_vec(),
            row("x", "X", "123").into_bytes(),
            row("x", "?", "123").into_bytes(),
            row("x", "S", "-1").into_bytes(),
            row("x", "S", "18446744073709551616").into_bytes(),
            row("x", "S", "123").replace("S 1", "S -1").into_bytes(),
            row("x", "S", "123").replace("S 1", "S bogus").into_bytes(),
            b"42 (x) S 1".to_vec(),
        ] {
            assert!(parse_linux_stat(&bytes, 42).is_none());
        }
        assert!(parse_linux_stat(row("x", "S", "123").as_bytes(), 43).is_none());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn reads_current_process_without_telemetry() {
        let pid = std::process::id();
        let identity = read(pid).expect("current process identity");
        assert_eq!(identity.pid, pid);
        assert!(!identity.zombie);
        assert!(!identity.birth_id.is_empty());
        assert!(identity.started_at_upper_bound_ms > 0);
        let json = serde_json::to_value(identity).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 5);
        assert!(json.get("birthId").is_some());
        assert!(json.get("startedAtUpperBoundMs").is_some());
        assert!(read(0).is_none());
        assert!(read(u32::MAX).is_none());
    }
}
