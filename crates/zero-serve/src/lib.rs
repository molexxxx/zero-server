//! The standalone zero-server binary, `zero`.
//!
//! `zero serve [DIRECTORY]` serves a directory of static files through `zero-static`
//! (a path segment that begins with a dot is answered 404, a directory path serves its
//! `index.html`) over HTTP/1.1, or over HTTPS through `zero-tls` with `--cert`, `--key`
//! and `--name`, with the `zero-policy` security header defaults on every response the
//! handler writes. The responses the HTTP driver writes on its own, such as a 400 for a
//! malformed request, a 421 for a host the certificate does not cover or the problem
//! response after a handler error, carry none of them. `zero version` and `zero help`
//! print what they name. The arguments are parsed by hand ([`parse`]) and [`run`] is the
//! whole binary, so `main` only hands it the arguments.
//!
//! The first `SIGTERM` or `SIGINT` (on Windows Ctrl+C, Ctrl+Break or closing the console)
//! stops accepting, lets the requests in flight finish for up to the drain limit
//! ([`CLOSE_DRAIN`] at most when the console closes) and exits 0; a second one exits at
//! once with [`StopSignal::exit_status`]. The signals reach a thread that waits for them
//! through `zero_sys::signal`, so no code runs in a signal handler and this crate holds
//! no `unsafe` code.

use std::ffi::OsString;
use std::fmt;
use std::io::{self, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use zero_core::{Error, Rng};
use zero_http::{Call, Event, Handler, StatusSink, Worker, Workers};
use zero_http_types::StatusCode;
use zero_io::rt::ShutdownHandle;
use zero_io::seam::Shutdown;
use zero_policy::cors::Field;
use zero_policy::SecurityHeaders;
use zero_static::{Files, Options};
use zero_sys::signal::{StopSignal, StopSignals};
use zero_tls::{Identities, Identity, TlsOptions};

/// The version of the binary.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Where `zero serve` listens without `--listen`: port 8080 on the loopback interface, so
/// a server started without flags is not reachable from another host.
pub const DEFAULT_LISTEN: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8080));

/// How long a stop waits for the requests in flight without `--drain`.
///
/// Kubernetes sends `SIGTERM` to the main process of each container and the KILL signal
/// once the grace period expires, and "The default terminationGracePeriodSeconds setting
/// is 30 seconds", a period that a `preStop` hook spends from too. Ten seconds, which is
/// also when the process leaves at the latest, ends the drain well inside it.
///
/// @see <https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination>
pub const DEFAULT_DRAIN: Duration = Duration::from_secs(10);

/// The longest drain `--drain` takes: one day.
///
/// The limit is added to the current instant when the drain starts, here and in the
/// runtime's `shutdown_timeout`, whose sum panics when it overflows; with this bound the
/// sum is representable on every platform, so a large `--drain` is refused on the
/// command line instead of failing every worker at the stop.
pub const MAX_DRAIN: Duration = Duration::from_secs(24 * 60 * 60);

/// The longest drain after the console closes on Windows: four seconds.
///
/// The system ends the process once a `CTRL_CLOSE_EVENT` handler has held the event for
/// the close time-out, "SPI_GETHUNGAPPTIMEOUT, 5000ms" by default, wherever the drain
/// stands. A drain that ends a second before that lets the process stop on its own and
/// exit 0 instead.
///
/// @see <https://learn.microsoft.com/en-us/windows/console/handlerroutine>
pub const CLOSE_DRAIN: Duration = Duration::from_secs(4);

/// The most worker threads `--threads` takes, and the most the default starts on a host
/// with more logical CPUs: the worker index a slot id carries has room for
/// [`zero_core::slot::MAX_WORKERS`].
pub const MAX_THREADS: usize = zero_core::slot::MAX_WORKERS as usize;

/// The exit code of a server that could not start or that failed.
pub const EXIT_FAILURE: u8 = 1;

/// The exit code of a command line this binary does not take.
pub const EXIT_USAGE: u8 = 2;

/// What `zero help` prints.
pub const USAGE: &str = "\
zero, the zero-server binary

Usage:
  zero serve [DIRECTORY] [OPTIONS]
  zero version
  zero help

zero serve answers GET and HEAD for the files under DIRECTORY (the current
directory when none is given) over HTTP/1.1, or over HTTPS with --cert and
--key. A directory path serves its index.html, a path segment that begins
with a dot is answered 404, and every answer from the directory carries the
default security headers. A request the HTTP layer refuses on its own (a 400,
408, 413, 421 or 505, or a 500 after a read error) is answered without them.

Options:
  --listen ADDR:PORT  the address and port to listen on (default 127.0.0.1:8080)
  --threads N         worker threads, 1 to 128 (default: one per logical CPU,
                      at most 128)
  --drain SECONDS     how long a stop waits for requests in flight, 0 to 86400
                      (default 10)
  --cert FILE         the PEM certificate chain, end-entity certificate first
  --key FILE          the PEM private key: PKCS#8, PKCS#1 or SEC1
  --name HOST         a host the certificate serves; repeat it for each host,
                      at least one with --cert
  -h, --help          print this text
  -V, --version       print the version

Stopping:
  SIGTERM or SIGINT, and on Windows Ctrl+C, Ctrl+Break or closing the console,
  stops accepting and lets the requests in flight finish for up to the drain
  limit. Closing the console drains for at most 4 seconds, since Windows ends
  the process 5 seconds after the console closes by default. A second signal
  exits at once.

Exit status:
  0    stopped cleanly
  1    the server could not start, or it failed
  2    the command line is not one zero takes
  >128 a second signal ended the drain (128 plus the signal number on Unix)
";

/// What the command line asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// `zero serve`: serve a directory.
    Serve(Serve),
    /// `zero version`, `--version` or `-V`: print the version.
    Version,
    /// `zero help`, `--help` or `-h`: print the usage.
    Help,
}

/// The settings of `zero serve`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Serve {
    /// The directory served; the current directory when none is given.
    pub root: PathBuf,
    /// The address and port to listen on (`--listen`).
    pub listen: SocketAddr,
    /// The worker threads (`--threads`); 0 runs one per logical CPU, at most
    /// [`MAX_THREADS`].
    pub threads: usize,
    /// How long a stop waits for the requests in flight (`--drain`).
    pub drain: Duration,
    /// The certificate to serve HTTPS with, when `--cert` is given.
    pub tls: Option<Tls>,
}

impl Default for Serve {
    fn default() -> Self {
        Serve {
            root: PathBuf::from("."),
            listen: DEFAULT_LISTEN,
            threads: 0,
            drain: DEFAULT_DRAIN,
            tls: None,
        }
    }
}

/// The certificate of an HTTPS listener.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tls {
    /// The PEM certificate chain, end-entity certificate first (`--cert`).
    pub cert: PathBuf,
    /// The PEM private key (`--key`).
    pub key: PathBuf,
    /// The hosts the certificate serves (`--name`), at least one.
    pub names: Vec<String>,
}

/// A command line this binary does not take.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageError {
    message: String,
}

impl UsageError {
    fn new(message: impl Into<String>) -> Self {
        UsageError {
            message: message.into(),
        }
    }
}

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UsageError {}

/// Why `zero serve` could not start, or why it stopped with an error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    message: String,
}

impl Failure {
    fn new(message: impl Into<String>) -> Self {
        Failure {
            message: message.into(),
        }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Failure {}

/// Run the binary.
///
/// # Arguments
///
/// * `args` - the command-line arguments after the program name.
///
/// # Returns
///
/// The exit code: 0 after a clean stop or a printed help or version, [`EXIT_FAILURE`]
/// when the server could not start or failed, [`EXIT_USAGE`] for a command line this
/// binary does not take. A second stop signal ends the process from the signal thread
/// with [`StopSignal::exit_status`](zero_sys::signal::StopSignal::exit_status) instead.
pub fn run<I>(args: I) -> ExitCode
where
    I: IntoIterator,
    I::Item: Into<OsString>,
{
    match parse(args) {
        Ok(Command::Help) => {
            let _ = io::stdout().write_all(USAGE.as_bytes());
            ExitCode::SUCCESS
        }
        Ok(Command::Version) => {
            let _ = writeln!(io::stdout(), "zero {VERSION}");
            ExitCode::SUCCESS
        }
        Ok(Command::Serve(options)) => match serve(&options) {
            Ok(()) => ExitCode::SUCCESS,
            Err(failure) => {
                say(format_args!("zero: {failure}"));
                ExitCode::from(EXIT_FAILURE)
            }
        },
        Err(usage) => {
            say(format_args!("zero: {usage}"));
            say(format_args!("Run 'zero help' for the usage."));
            ExitCode::from(EXIT_USAGE)
        }
    }
}

/// Parse a command line.
///
/// A flag takes its value as the next argument or after `=` (`--drain 5` or
/// `--drain=5`), and `--` makes every later argument the directory.
///
/// # Arguments
///
/// * `args` - the command-line arguments after the program name.
///
/// # Returns
///
/// The command, with the defaults for every flag not given.
///
/// # Errors
///
/// [`UsageError`] for a missing or unknown command, an argument after `help` or
/// `version`, an unknown flag, a flag without its value or given twice, a value out of
/// range (a `--drain` over [`MAX_DRAIN`] among them), an empty directory, `--cert`,
/// `--key` or `--name`, more than one directory, `--cert` without `--key` or the
/// reverse, `--cert` without a `--name`, and `--name` without `--cert`.
pub fn parse<I>(args: I) -> Result<Command, UsageError>
where
    I: IntoIterator,
    I::Item: Into<OsString>,
{
    let mut args = args.into_iter().map(Into::into);
    let Some(first) = args.next() else {
        return Err(UsageError::new("no command given"));
    };
    match first.to_str() {
        Some("serve") => parse_serve(args),
        Some("version" | "--version" | "-V") => match args.next() {
            None => Ok(Command::Version),
            Some(extra) => Err(UsageError::new(format!(
                "version takes no arguments, not {:?}",
                extra.to_string_lossy()
            ))),
        },
        Some("help" | "--help" | "-h") => match args.next() {
            None => Ok(Command::Help),
            Some(extra) => Err(UsageError::new(format!(
                "help takes no arguments, not {:?}",
                extra.to_string_lossy()
            ))),
        },
        Some(flag) if flag.starts_with('-') => {
            Err(UsageError::new(format!("unknown option {flag}")))
        }
        _ => Err(UsageError::new(format!(
            "unknown command {:?}",
            first.to_string_lossy()
        ))),
    }
}

/// Parse the arguments after `serve`.
fn parse_serve(mut args: impl Iterator<Item = OsString>) -> Result<Command, UsageError> {
    let mut root: Option<PathBuf> = None;
    let mut listen = None;
    let mut threads = None;
    let mut drain = None;
    let mut cert: Option<PathBuf> = None;
    let mut key: Option<PathBuf> = None;
    let mut names = Vec::new();
    let mut only_directories = false;
    while let Some(arg) = args.next() {
        let is_flag =
            !only_directories && arg.len() > 1 && arg.as_encoded_bytes().first() == Some(&b'-');
        if !is_flag {
            if root.is_some() {
                return Err(UsageError::new("serve takes one DIRECTORY"));
            }
            root = Some(path_value("DIRECTORY", arg)?);
            continue;
        }
        let Some(text) = arg.to_str() else {
            return Err(UsageError::new(format!(
                "unknown option {:?}",
                arg.to_string_lossy()
            )));
        };
        if text == "--" {
            only_directories = true;
            continue;
        }
        if text == "--help" || text == "-h" {
            return Ok(Command::Help);
        }
        let (name, inline) = match text.split_once('=') {
            Some((name, value)) => (name, Some(OsString::from(value))),
            None => (text, None),
        };
        match name {
            "--listen" => {
                let value = text_value(name, value_of(name, inline, &mut args)?)?;
                let addr = value.parse::<SocketAddr>().map_err(|_| {
                    UsageError::new(format!(
                        "--listen takes an IP address and a port such as 127.0.0.1:8080 or [::1]:8080, not {value:?}"
                    ))
                })?;
                once(&mut listen, name, addr)?;
            }
            "--threads" => {
                let value = text_value(name, value_of(name, inline, &mut args)?)?;
                let count = value
                    .parse::<usize>()
                    .ok()
                    .filter(|count| (1..=MAX_THREADS).contains(count))
                    .ok_or_else(|| {
                        UsageError::new(format!(
                            "--threads takes a whole number from 1 to {MAX_THREADS}, not {value:?}"
                        ))
                    })?;
                once(&mut threads, name, count)?;
            }
            "--drain" => {
                let value = text_value(name, value_of(name, inline, &mut args)?)?;
                let longest = MAX_DRAIN.as_secs();
                let seconds = value
                    .parse::<u64>()
                    .ok()
                    .filter(|seconds| *seconds <= longest)
                    .ok_or_else(|| {
                        UsageError::new(format!(
                            "--drain takes a whole number of seconds from 0 to {longest}, not {value:?}"
                        ))
                    })?;
                once(&mut drain, name, Duration::from_secs(seconds))?;
            }
            "--cert" => {
                let value = path_value(name, value_of(name, inline, &mut args)?)?;
                once(&mut cert, name, value)?;
            }
            "--key" => {
                let value = path_value(name, value_of(name, inline, &mut args)?)?;
                once(&mut key, name, value)?;
            }
            "--name" => {
                let value = text_value(name, value_of(name, inline, &mut args)?)?;
                if value.is_empty() {
                    return Err(UsageError::new("--name takes a host, not an empty value"));
                }
                names.push(value);
            }
            _ => return Err(UsageError::new(format!("unknown option {name}"))),
        }
    }
    let tls = match (cert, key) {
        (Some(cert), Some(key)) if !names.is_empty() => Some(Tls { cert, key, names }),
        (Some(_), Some(_)) => {
            return Err(UsageError::new(
                "--cert needs at least one --name, a host the certificate serves",
            ))
        }
        (Some(_), None) => return Err(UsageError::new("--cert needs --key")),
        (None, Some(_)) => return Err(UsageError::new("--key needs --cert")),
        (None, None) if !names.is_empty() => {
            return Err(UsageError::new("--name needs --cert and --key"))
        }
        (None, None) => None,
    };
    let defaults = Serve::default();
    Ok(Command::Serve(Serve {
        root: root.unwrap_or(defaults.root),
        listen: listen.unwrap_or(defaults.listen),
        threads: threads.unwrap_or(defaults.threads),
        drain: drain.unwrap_or(defaults.drain),
        tls,
    }))
}

/// The value of the flag `name`: the text after `=`, or the next argument.
fn value_of(
    name: &str,
    inline: Option<OsString>,
    args: &mut impl Iterator<Item = OsString>,
) -> Result<OsString, UsageError> {
    inline
        .or_else(|| args.next())
        .ok_or_else(|| UsageError::new(format!("{name} needs a value")))
}

/// A value that names a file or a directory, which cannot be empty.
fn path_value(name: &str, value: OsString) -> Result<PathBuf, UsageError> {
    if value.is_empty() {
        return Err(UsageError::new(format!(
            "{name} takes a path, not an empty value"
        )));
    }
    Ok(PathBuf::from(value))
}

/// A flag value that must be text.
fn text_value(name: &str, value: OsString) -> Result<String, UsageError> {
    value.into_string().map_err(|raw| {
        UsageError::new(format!(
            "the value of {name} is not valid UTF-8: {:?}",
            raw.to_string_lossy()
        ))
    })
}

/// Set a flag that may be given once.
fn once<T>(slot: &mut Option<T>, name: &str, value: T) -> Result<(), UsageError> {
    if slot.replace(value).is_some() {
        return Err(UsageError::new(format!("{name} is given twice")));
    }
    Ok(())
}

/// Serve a directory until a stop signal ends the drain, or until the server fails.
///
/// The directory and the certificate are checked before anything starts. The stop
/// signals are then routed to a thread of their own before the workers start, so every
/// worker inherits that routing; the main thread supervises: a stop signal starts the
/// drain, a core that stops on its own while the server runs stops the others too,
/// since a core with no worker would be a silent outage, and the call returns when every
/// core has returned or the drain limit passed, whichever is first.
///
/// # Arguments
///
/// * `options` - the settings.
///
/// # Returns
///
/// Nothing once the server stopped cleanly, including after a drain that reached its
/// limit with requests still in flight.
///
/// # Errors
///
/// [`Failure`] when the directory does not exist or is not a directory, the certificate
/// or the key cannot be read or does not hold what it should, the listener cannot be
/// bound, or a core stopped or failed while the server was running.
pub fn serve(options: &Serve) -> Result<(), Failure> {
    check_root(&options.root)?;
    let identity = options.tls.as_ref().map(load_identity).transpose()?;
    let headers = Arc::new(Headers::render()?);
    let signals = match StopSignals::install() {
        Ok(signals) => Some(signals),
        Err(err) => {
            say(format_args!(
                "zero: the stop signals cannot be routed ({err}); a stop ends the process without a drain"
            ));
            None
        }
    };
    let (events, reports) = mpsc::channel();
    let workers = start(options, identity, headers, events.clone())?;
    let shutdown = workers.shutdown_handle();
    let scheme = if options.tls.is_some() {
        "https"
    } else {
        "http"
    };
    say(format_args!(
        "zero: serving {} at {scheme}://{} on {} threads",
        options.root.display(),
        workers.local_addr(),
        workers.count()
    ));
    if let Some(signals) = signals {
        let watcher_events = events.clone();
        let watcher_shutdown = shutdown.clone();
        let drain = options.drain;
        let watching = std::thread::Builder::new()
            .name("zero-signals".to_owned())
            .spawn(move || watch(&signals, &watcher_shutdown, drain, &watcher_events));
        if let Err(err) = watching {
            shutdown.request();
            return Err(Failure::new(format!(
                "cannot start the signal thread: {err}"
            )));
        }
    }
    let joiner_events = events;
    let joining = std::thread::Builder::new()
        .name("zero-join".to_owned())
        .spawn(move || {
            let outcome = workers.join();
            let _ = joiner_events.send(Message::Joined(outcome));
        });
    if let Err(err) = joining {
        shutdown.request();
        return Err(Failure::new(format!("cannot start the join thread: {err}")));
    }
    supervise(&reports, &shutdown, options.drain)
}

/// Check that `root` is a directory the server can resolve.
fn check_root(root: &Path) -> Result<(), Failure> {
    match std::fs::metadata(root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(Failure::new(format!(
                "{} is not a directory",
                root.display()
            )))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Err(Failure::new(format!(
                "the directory {} does not exist",
                root.display()
            )))
        }
        Err(err) => {
            return Err(Failure::new(format!(
                "cannot read the directory {}: {err}",
                root.display()
            )))
        }
    }
    Files::new(root, site_options()).map_err(|err| {
        Failure::new(format!(
            "cannot resolve the directory {}: {err}",
            root.display()
        ))
    })?;
    Ok(())
}

/// Load the certificate and its key, naming the file that cannot be read.
fn load_identity(tls: &Tls) -> Result<Identity, Failure> {
    for (what, path) in [("certificate", &tls.cert), ("private key", &tls.key)] {
        std::fs::File::open(path).map_err(|err| {
            Failure::new(format!(
                "cannot read the {what} file {}: {err}",
                path.display()
            ))
        })?;
    }
    let names: Vec<&str> = tls.names.iter().map(String::as_str).collect();
    Identity::from_pem_files(&tls.cert, &tls.key, &names).map_err(|err| {
        Failure::new(format!(
            "cannot load the certificate {} with the key {}: {err}",
            tls.cert.display(),
            tls.key.display()
        ))
    })
}

/// How the directory is served: `index.html` for a directory path, and no path segment
/// that begins with a dot (RFC 9110 Section 17.3).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-17.3>
fn site_options() -> Options {
    Options {
        index: Some("index.html".to_owned()),
        dotfiles: false,
        ..Options::default()
    }
}

/// How many workers start: `requested`, or one per logical CPU up to [`MAX_THREADS`] when
/// `requested` is 0.
fn worker_count(requested: usize, cpus: usize) -> usize {
    match requested {
        0 => cpus.clamp(1, MAX_THREADS),
        count => count,
    }
}

/// The logical CPUs the process may run on, 1 when the system cannot say.
fn available_cpus() -> usize {
    std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
}

/// Start the workers, over TLS when there is an identity.
fn start(
    options: &Serve,
    identity: Option<Identity>,
    headers: Arc<Headers>,
    events: Sender<Message>,
) -> Result<Workers, Failure> {
    let mut config = zero_http::Config::default();
    config.runtime.io.threads = worker_count(options.threads, available_cpus());
    config.runtime.io.drain = options.drain;
    let root = options.root.clone();
    let make = move |_: &Worker| Site::new(&root, Arc::clone(&headers));
    let status = status_sink(events);
    let started = match identity {
        None => zero_http::serve(options.listen, config, status, make),
        Some(identity) => {
            let identities = Arc::new(Identities::new(
                std::slice::from_ref(&identity),
                Some(identity.clone()),
            ));
            zero_tls::serve(
                options.listen,
                config,
                identities,
                TlsOptions::default(),
                status,
                make,
            )
        }
    };
    started.map_err(|err| Failure::new(format!("cannot serve on {}: {err}", options.listen)))
}

/// What the server's threads report to the main thread.
enum Message {
    /// A stop signal arrived and the drain started, to end after the duration at the
    /// latest.
    Draining(Duration),
    /// A core returned.
    Stopped(usize),
    /// Every core returned.
    Joined(io::Result<()>),
}

/// The status callback: a core that returned is reported to the main thread, a panic is
/// printed.
fn status_sink(events: Sender<Message>) -> StatusSink {
    Arc::new(move |event| match event {
        Event::Started { .. } => {}
        Event::Stopped { core } => {
            let _ = events.send(Message::Stopped(core));
        }
        Event::TaskPanic { core, message } => {
            say(format_args!(
                "zero: a request on core {core} panicked: {message}"
            ));
        }
        Event::WorkerPanic { core, message } => {
            say(format_args!("zero: core {core} failed: {message}"));
        }
    })
}

/// How long the drain that `signal` starts may run: `drain`, and at most
/// [`CLOSE_DRAIN`] when the console closes, since the system ends the process once its
/// close time-out passes.
///
/// @see <https://learn.microsoft.com/en-us/windows/console/handlerroutine>
fn drain_after(signal: StopSignal, drain: Duration) -> Duration {
    match signal {
        StopSignal::Close => drain.min(CLOSE_DRAIN),
        StopSignal::Interrupt | StopSignal::Terminate | StopSignal::Break => drain,
    }
}

/// The signal thread: the first stop signal starts the drain, a second one ends the
/// process at once with its exit status.
fn watch(
    signals: &StopSignals,
    shutdown: &ShutdownHandle,
    drain: Duration,
    events: &Sender<Message>,
) {
    let first = match signals.wait() {
        Ok(signal) => signal,
        Err(err) => {
            say(format_args!("zero: cannot wait for a stop signal: {err}"));
            return;
        }
    };
    let limit = drain_after(first, drain);
    say(format_args!(
        "zero: {first} received; draining for up to {} s, and a second signal exits at once",
        limit.as_secs()
    ));
    let _ = events.send(Message::Draining(limit));
    shutdown.request();
    match signals.wait() {
        Ok(second) => {
            say(format_args!(
                "zero: {second} received during the drain; exiting now"
            ));
            std::process::exit(second.exit_status());
        }
        Err(err) => say(format_args!("zero: cannot wait for a stop signal: {err}")),
    }
}

/// Where the server stands, as the main thread sees it.
#[derive(Clone, Copy)]
enum State {
    /// Serving; no stop was asked for.
    Serving,
    /// Draining for up to `limit`.
    Draining {
        /// When the drain ends, or `None` without a limit when the limit does not fit
        /// an `Instant`.
        deadline: Option<Instant>,
        /// The limit, as it is reported when it passes.
        limit: Duration,
    },
}

impl State {
    /// A drain of up to `limit` from now.
    fn draining(limit: Duration) -> Self {
        State::Draining {
            deadline: Instant::now().checked_add(limit),
            limit,
        }
    }

    /// Whether `next` ends sooner than this state does; serving never ends on its own.
    fn outlasts(self, next: State) -> bool {
        match (self, next) {
            (State::Serving, _) => true,
            (State::Draining { deadline: None, .. }, State::Draining { deadline, .. }) => {
                deadline.is_some()
            }
            (
                State::Draining {
                    deadline: Some(current),
                    ..
                },
                State::Draining {
                    deadline: Some(sooner),
                    ..
                },
            ) => sooner < current,
            (State::Draining { .. }, _) => false,
        }
    }
}

/// The main thread's loop over the reports, until every core returned or the drain limit
/// passed.
///
/// A stop signal's report carries its own limit, which replaces a drain already running
/// when it ends sooner, so a console close cuts short the drain a failed core started.
fn supervise(
    reports: &Receiver<Message>,
    shutdown: &ShutdownHandle,
    drain: Duration,
) -> Result<(), Failure> {
    let mut state = State::Serving;
    let mut failure: Option<Failure> = None;
    loop {
        let report = match state {
            State::Draining {
                deadline: Some(deadline),
                limit,
            } => match reports.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(report) => report,
                Err(RecvTimeoutError::Timeout) => {
                    say(format_args!(
                        "zero: the drain limit of {} s passed; the connections still open are dropped",
                        limit.as_secs()
                    ));
                    return failure.map_or(Ok(()), Err);
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(Failure::new("the server stopped without reporting"))
                }
            },
            State::Serving | State::Draining { deadline: None, .. } => reports
                .recv()
                .map_err(|_| Failure::new("the server stopped without reporting"))?,
        };
        match report {
            Message::Draining(limit) => {
                let next = State::draining(limit);
                if state.outlasts(next) {
                    state = next;
                }
            }
            Message::Stopped(core) => {
                if matches!(state, State::Serving) {
                    say(format_args!(
                        "zero: core {core} stopped while the server was running; stopping the others"
                    ));
                    failure = Some(Failure::new(format!(
                        "core {core} stopped while the server was running"
                    )));
                    state = State::draining(drain);
                    shutdown.request();
                }
            }
            Message::Joined(Ok(())) => {
                say(format_args!("zero: stopped"));
                return failure.map_or(Ok(()), Err);
            }
            Message::Joined(Err(err)) => {
                return Err(Failure::new(format!("the server failed: {err}")));
            }
        }
    }
}

/// The security header fields of a response, rendered once per transport from the
/// `zero-policy` defaults: `Strict-Transport-Security` only on the TLS listener, since
/// an HSTS host "MUST NOT include the STS header field in HTTP responses conveyed over
/// non-secure transport" (RFC 6797 Section 7.2).
///
/// @see <https://www.rfc-editor.org/rfc/rfc6797.html#section-7.2>
struct Headers {
    plain: Vec<Field>,
    secure: Vec<Field>,
}

impl Headers {
    /// Render both sets once. The defaults name no content security policy, so no
    /// response needs a nonce of its own; a policy that draws one is refused here rather
    /// than sent with the same nonce on every response.
    fn render() -> Result<Self, Failure> {
        let policy = SecurityHeaders::default();
        let render = |secure| match policy.render(secure, &SystemRandom) {
            Ok(rendered) if rendered.nonce.is_none() => Ok(rendered.fields),
            Ok(_) => Err(Failure::new(
                "a security policy with a nonce must be rendered for each response",
            )),
            Err(err) => Err(Failure::new(format!(
                "cannot render the security headers: {err}"
            ))),
        };
        Ok(Headers {
            plain: render(false)?,
            secure: render(true)?,
        })
    }

    fn for_transport(&self, secure: bool) -> &[Field] {
        if secure {
            &self.secure
        } else {
            &self.plain
        }
    }
}

/// The operating system's generator, which a content security policy nonce is drawn
/// from.
struct SystemRandom;

impl Rng for SystemRandom {
    fn fill(&self, out: &mut [u8]) -> zero_core::Result<()> {
        zero_sys::random::fill(out).map_err(|err| Error::Io(err.to_string()))
    }
}

/// One core's handler: the directory, and the security headers every response it writes
/// gets. A response the driver writes instead, for a request it refuses before the
/// handler runs or after the handler fails, goes out without them.
struct Site {
    files: Option<Files>,
    headers: Arc<Headers>,
}

impl Site {
    /// The core's handler; a root that no longer resolves answers every request 404, as
    /// a file that cannot be opened is answered.
    fn new(root: &Path, headers: Arc<Headers>) -> Self {
        Site {
            files: Files::new(root, site_options()).ok(),
            headers,
        }
    }
}

impl Handler for Site {
    async fn handle(&self, call: &mut Call<'_>) -> Result<(), Error> {
        let served = match &self.files {
            Some(files) => files.serve(call),
            None => {
                call.response().status(StatusCode::NOT_FOUND);
                Ok(())
            }
        };
        let secure = call.request().is_secure();
        let mut response = call.response();
        for (name, value) in self.headers.for_transport(secure) {
            response.header(name, value)?;
        }
        served
    }
}

/// Write one line to standard error, ignoring a closed stream.
fn say(message: fmt::Arguments<'_>) {
    let _ = writeln!(io::stderr(), "{message}");
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use zero_io::rt::ShutdownHandle;
    use zero_sys::signal::StopSignal;

    use super::{
        available_cpus, drain_after, load_identity, parse, serve, supervise, worker_count, Command,
        Headers, Message, Serve, Tls, UsageError, CLOSE_DRAIN, DEFAULT_DRAIN, DEFAULT_LISTEN,
        MAX_DRAIN, MAX_THREADS, USAGE,
    };

    fn serve_with(args: &[&str]) -> Result<Serve, UsageError> {
        match parse(std::iter::once("serve").chain(args.iter().copied()))? {
            Command::Serve(serve) => Ok(serve),
            other => panic!("not serve: {other:?}"),
        }
    }

    fn refused(args: &[&str]) -> String {
        serve_with(args).expect_err("a usage error").to_string()
    }

    #[test]
    fn serve_without_flags_serves_the_current_directory_on_loopback_port_8080_over_http() {
        let serve = serve_with(&[]).unwrap();
        assert_eq!(serve, Serve::default());
        assert_eq!(serve.root, std::path::PathBuf::from("."));
        assert_eq!(serve.listen.to_string(), "127.0.0.1:8080");
        assert_eq!(serve.listen, DEFAULT_LISTEN);
        assert_eq!(serve.threads, 0, "0 runs one worker per logical CPU");
        assert_eq!(serve.tls, None);
    }

    #[test]
    fn the_default_starts_one_worker_per_logical_cpu_and_never_more_than_max_threads() {
        assert_eq!(worker_count(0, 8), 8);
        assert_eq!(worker_count(0, 0), 1);
        assert_eq!(worker_count(0, MAX_THREADS * 3), MAX_THREADS);
        assert_eq!(
            worker_count(3, MAX_THREADS * 3),
            3,
            "--threads is taken as given"
        );
        assert_eq!(
            worker_count(0, available_cpus()),
            available_cpus().min(MAX_THREADS)
        );
    }

    /// Kubernetes Pod Lifecycle, Termination of Pods: "The default
    /// terminationGracePeriodSeconds setting is 30 seconds".
    #[test]
    fn the_default_drain_timeout_is_shorter_than_the_kubernetes_default_terminationgraceperiodseconds_of_30_seconds(
    ) {
        let termination_grace_period = Duration::from_secs(30);
        assert!(DEFAULT_DRAIN < termination_grace_period);
        assert_eq!(serve_with(&[]).unwrap().drain, DEFAULT_DRAIN);
        assert_eq!(
            serve_with(&["--drain", "45"]).unwrap().drain,
            Duration::from_secs(45)
        );
    }

    #[test]
    fn every_flag_takes_its_value_as_the_next_argument_or_after_an_equals_sign() {
        let spaced = serve_with(&[
            "site",
            "--listen",
            "[::1]:9000",
            "--threads",
            "3",
            "--drain",
            "0",
            "--cert",
            "chain.pem",
            "--key",
            "key.pem",
            "--name",
            "localhost",
            "--name",
            "127.0.0.1",
        ])
        .unwrap();
        let joined = serve_with(&[
            "--listen=[::1]:9000",
            "--threads=3",
            "--drain=0",
            "--cert=chain.pem",
            "--key=key.pem",
            "--name=localhost",
            "--name=127.0.0.1",
            "site",
        ])
        .unwrap();
        assert_eq!(spaced, joined);
        assert_eq!(spaced.root, std::path::PathBuf::from("site"));
        assert_eq!(spaced.listen.to_string(), "[::1]:9000");
        assert_eq!(spaced.threads, 3);
        assert_eq!(spaced.drain, Duration::ZERO);
        assert_eq!(
            spaced.tls,
            Some(Tls {
                cert: "chain.pem".into(),
                key: "key.pem".into(),
                names: vec!["localhost".to_owned(), "127.0.0.1".to_owned()],
            })
        );
        let dashed = serve_with(&["--", "--site"]).unwrap();
        assert_eq!(dashed.root, std::path::PathBuf::from("--site"));
    }

    #[test]
    fn a_bad_flag_or_value_is_a_usage_error_that_names_it() {
        assert!(refused(&["--bogus"]).contains("--bogus"));
        assert!(refused(&["--threads"]).contains("--threads needs a value"));
        assert!(refused(&["--threads", "0"]).contains("from 1 to 128"));
        let over = (MAX_THREADS + 1).to_string();
        assert!(refused(&["--threads", over.as_str()]).contains("--threads"));
        assert!(refused(&["--threads", "two"]).contains("\"two\""));
        assert!(refused(&["--drain", "-1"]).contains("--drain"));
        assert!(refused(&["--drain", "1.5"]).contains("whole number of seconds"));
        assert!(refused(&["--drain", "18446744073709551615"]).contains("--drain"));
        assert!(refused(&["--drain", "9223372036854775807"]).contains("--drain"));
        let over = (MAX_DRAIN.as_secs() + 1).to_string();
        assert!(refused(&["--drain", over.as_str()]).contains("from 0 to 86400"));
        let longest = MAX_DRAIN.as_secs().to_string();
        assert_eq!(
            serve_with(&["--drain", longest.as_str()]).unwrap().drain,
            MAX_DRAIN
        );
        assert!(refused(&["--cert=", "--key=k.pem", "--name=localhost"]).contains("--cert"));
        assert!(refused(&["--cert", "c.pem", "--key", "", "--name=localhost"]).contains("--key"));
        assert!(refused(&[""]).contains("DIRECTORY"));
        assert!(refused(&["--", ""]).contains("DIRECTORY"));
        assert!(refused(&["--listen", "localhost:80"]).contains("--listen"));
        assert!(refused(&["--listen", "127.0.0.1"]).contains("--listen"));
        assert!(refused(&["--drain", "1", "--drain", "2"]).contains("given twice"));
        assert!(refused(&["one", "two"]).contains("one DIRECTORY"));
        assert!(refused(&["--name="]).contains("empty"));
        assert!(parse(Vec::<String>::new())
            .unwrap_err()
            .to_string()
            .contains("no command"));
        assert!(parse(["start"]).unwrap_err().to_string().contains("start"));
        assert!(parse(["--bogus"])
            .unwrap_err()
            .to_string()
            .contains("--bogus"));
        assert!(parse(["version", "extra"]).is_err());
        for args in [
            &["help", "--threads", "0"][..],
            &["--help", "serve"],
            &["-h", "x"],
        ] {
            let error = parse(args.iter().copied()).unwrap_err().to_string();
            assert!(
                error.contains("help takes no arguments"),
                "{args:?}: {error}"
            );
        }
    }

    #[test]
    fn cert_and_key_go_together_and_the_certificate_serves_at_least_one_name() {
        assert!(refused(&["--cert", "c.pem"]).contains("--cert needs --key"));
        assert!(refused(&["--key", "k.pem"]).contains("--key needs --cert"));
        assert!(refused(&["--cert", "c.pem", "--key", "k.pem"]).contains("--name"));
        assert!(refused(&["--name", "localhost"]).contains("--name needs --cert"));
    }

    #[test]
    fn help_and_version_are_taken_as_commands_and_as_flags() {
        for args in [&["help"][..], &["--help"], &["-h"], &["serve", "--help"]] {
            assert_eq!(parse(args.iter().copied()), Ok(Command::Help), "{args:?}");
        }
        for args in [&["version"][..], &["--version"], &["-V"]] {
            assert_eq!(
                parse(args.iter().copied()),
                Ok(Command::Version),
                "{args:?}"
            );
        }
        for flag in [
            "--listen",
            "--threads",
            "--drain",
            "--cert",
            "--key",
            "--name",
        ] {
            assert!(USAGE.contains(flag), "{flag}");
        }
        assert!(USAGE.contains(&format!("1 to {MAX_THREADS}")));
        assert!(USAGE.contains(&format!("(default {})", DEFAULT_DRAIN.as_secs())));
        assert!(USAGE.contains(&format!("0 to {}", MAX_DRAIN.as_secs())));
        assert!(USAGE.contains(&format!("at most {} seconds", CLOSE_DRAIN.as_secs())));
        assert!(USAGE.contains(&format!("(default {DEFAULT_LISTEN})")));
    }

    /// HandlerRoutine, Timeouts: "CTRL_CLOSE_EVENT any system parameter
    /// SPI_GETHUNGAPPTIMEOUT, 5000ms"; the system ends the process when it passes.
    #[test]
    fn a_console_close_drains_for_less_than_the_ctrl_close_event_timeout_of_5000_ms() {
        let close_timeout = Duration::from_millis(5000);
        assert!(CLOSE_DRAIN < close_timeout);
        assert_eq!(drain_after(StopSignal::Close, DEFAULT_DRAIN), CLOSE_DRAIN);
        assert_eq!(drain_after(StopSignal::Close, MAX_DRAIN), CLOSE_DRAIN);
        assert_eq!(
            drain_after(StopSignal::Close, Duration::from_secs(2)),
            Duration::from_secs(2),
            "a shorter --drain stays as given"
        );
        for signal in [
            StopSignal::Interrupt,
            StopSignal::Terminate,
            StopSignal::Break,
        ] {
            assert_eq!(
                drain_after(signal, DEFAULT_DRAIN),
                DEFAULT_DRAIN,
                "{signal}"
            );
        }
    }

    /// The supervisor waits for the limit the signal thread reports, not for `--drain`,
    /// and a sooner limit cuts short a drain already running. The supervisor runs on a
    /// thread of its own, so a drain that waits for `--drain` fails the test.
    #[test]
    fn the_drain_ends_at_the_limit_the_stop_signal_reports() {
        let (events, reports) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        std::thread::spawn(move || {
            let shutdown = ShutdownHandle::new();
            let _ = done.send(supervise(&reports, &shutdown, Duration::from_secs(600)));
        });
        events
            .send(Message::Draining(Duration::from_secs(600)))
            .unwrap();
        events
            .send(Message::Draining(Duration::from_millis(1)))
            .unwrap();
        let outcome = finished
            .recv_timeout(Duration::from_secs(30))
            .expect("the drain ended at the reported limit");
        assert_eq!(outcome, Ok(()));
        drop(events);
    }

    #[test]
    fn a_directory_that_does_not_exist_or_is_a_file_fails_before_anything_starts() {
        let missing =
            std::env::temp_dir().join(format!("zero-serve-missing-{}", std::process::id()));
        let failure = serve(&Serve {
            root: missing,
            ..Serve::default()
        })
        .unwrap_err();
        assert!(failure.to_string().contains("does not exist"), "{failure}");
        let file = std::env::temp_dir().join(format!("zero-serve-file-{}", std::process::id()));
        std::fs::write(&file, b"not a directory").unwrap();
        let failure = serve(&Serve {
            root: file.clone(),
            ..Serve::default()
        })
        .unwrap_err();
        let _ = std::fs::remove_file(&file);
        assert!(
            failure.to_string().contains("is not a directory"),
            "{failure}"
        );
    }

    #[test]
    fn an_unreadable_certificate_or_key_fails_naming_the_file() {
        let missing =
            std::env::temp_dir().join(format!("zero-serve-absent-{}.pem", std::process::id()));
        let failure = load_identity(&Tls {
            cert: missing.clone(),
            key: missing.clone(),
            names: vec!["localhost".to_owned()],
        })
        .unwrap_err()
        .to_string();
        assert!(failure.contains("certificate file"), "{failure}");
        assert!(
            failure.contains(&missing.display().to_string()),
            "{failure}"
        );
        let fixtures =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../zero-tls/tests/fixtures");
        let failure = load_identity(&Tls {
            cert: fixtures.join("localhost.pem"),
            key: missing.clone(),
            names: vec!["localhost".to_owned()],
        })
        .unwrap_err()
        .to_string();
        assert!(failure.contains("private key file"), "{failure}");
        let mismatched = load_identity(&Tls {
            cert: fixtures.join("localhost.pem"),
            key: fixtures.join("other.test.key"),
            names: vec!["localhost".to_owned()],
        });
        assert!(
            mismatched.is_err(),
            "a key that does not match the certificate"
        );
        let loaded = load_identity(&Tls {
            cert: fixtures.join("localhost.pem"),
            key: fixtures.join("localhost.key"),
            names: vec!["localhost".to_owned()],
        });
        assert!(loaded.is_ok(), "{:?}", loaded.err());
    }

    /// RFC 6797 Section 7.2: "An HSTS Host MUST NOT include the STS header field in HTTP
    /// responses conveyed over non-secure transport."
    #[test]
    fn an_hsts_host_must_not_include_the_sts_header_field_over_non_secure_transport_section_7_2() {
        let headers = Headers::render().unwrap();
        let names = |secure| -> Vec<&[u8]> {
            headers
                .for_transport(secure)
                .iter()
                .map(|(name, _)| *name)
                .collect()
        };
        assert!(!names(false).contains(&&b"Strict-Transport-Security"[..]));
        assert!(names(true).contains(&&b"Strict-Transport-Security"[..]));
        for secure in [false, true] {
            assert!(names(secure).contains(&&b"X-Content-Type-Options"[..]));
            assert!(names(secure).contains(&&b"X-Frame-Options"[..]));
        }
    }
}
