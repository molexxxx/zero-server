//! The measurement harness.
//!
//! `zero-bench load --addr 127.0.0.1:8080 --path /plaintext --connections 256
//! --threads 2 --pipeline 16 --duration 10 --warmup 2` runs the pipelined load
//! generator and prints requests per second, errors and batch latencies.
//!
//! `zero-bench idle --addr 127.0.0.1:8080 --pid <server pid> --connections 10000
//! --path /plaintext` opens idle keep-alive connections to a running server and
//! prints the resident bytes it grew by per connection.
//!
//! `zero-bench miss --routes 400 --iterations 1000000 --batches 5` times a route
//! miss against a table of that many routes and prints the median per miss.

use std::net::SocketAddr;
use std::process::ExitCode;
use std::time::Duration;

use zero_bench::args::Args;
use zero_bench::{idle, load, miss};

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("zero-bench: {message}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let args = Args::parse(std::env::args().skip(1));
    let command = args.positional().first().map(String::as_str).unwrap_or("");
    let addr: SocketAddr = match args.value("addr").unwrap_or("127.0.0.1:8080").parse() {
        Ok(addr) => addr,
        Err(err) => return fail(format!("--addr: {err}")),
    };
    let path = args.value("path").unwrap_or("/plaintext").to_owned();
    match command {
        "load" => {
            let plan = load::Plan {
                addr,
                host: args.value("host").unwrap_or("localhost").to_owned(),
                path,
                connections: match args.parsed("connections", 256) {
                    Ok(value) => value,
                    Err(message) => return fail(message),
                },
                threads: match args.parsed("threads", 1) {
                    Ok(value) => value,
                    Err(message) => return fail(message),
                },
                pipeline: match args.parsed("pipeline", 16) {
                    Ok(value) => value,
                    Err(message) => return fail(message),
                },
                duration: Duration::from_secs(match args.parsed("duration", 10) {
                    Ok(value) => value,
                    Err(message) => return fail(message),
                }),
                warmup: Duration::from_secs(match args.parsed("warmup", 2) {
                    Ok(value) => value,
                    Err(message) => return fail(message),
                }),
            };
            match load::run(&plan) {
                Ok(report) => {
                    println!(
                        "load {} {} connections={} threads={} pipeline={} duration={:.1}s",
                        plan.addr,
                        plan.path,
                        plan.connections,
                        plan.threads,
                        plan.pipeline,
                        report.elapsed.as_secs_f64()
                    );
                    println!(
                        "requests={} errors={} bytes={} rate={:.0} req/s",
                        report.requests,
                        report.errors,
                        report.bytes,
                        report.rate()
                    );
                    println!(
                        "batch latency us: p50={} p90={} p99={} max={}",
                        report.latency_us(50.0).unwrap_or(0),
                        report.latency_us(90.0).unwrap_or(0),
                        report.latency_us(99.0).unwrap_or(0),
                        report.latency_us(100.0).unwrap_or(0)
                    );
                    ExitCode::SUCCESS
                }
                Err(err) => fail(err),
            }
        }
        "idle" => {
            let pid: u32 = match args.parsed("pid", 0) {
                Ok(0) => return fail("--pid names the server process"),
                Ok(pid) => pid,
                Err(message) => return fail(message),
            };
            let connections: usize = match args.parsed("connections", 10_000) {
                Ok(value) => value,
                Err(message) => return fail(message),
            };
            let settle = Duration::from_secs(match args.parsed("settle", 2) {
                Ok(value) => value,
                Err(message) => return fail(message),
            });
            match idle::measure(pid, addr, &path, connections, settle) {
                Ok(measurement) => {
                    println!(
                        "idle pid={pid} connections={} rss_before={} rss_after={} bytes_per_connection={}",
                        measurement.connections,
                        measurement.rss_before,
                        measurement.rss_after,
                        measurement.bytes_per_connection()
                    );
                    ExitCode::SUCCESS
                }
                Err(err) => fail(err),
            }
        }
        "miss" => {
            let routes: usize = match args.parsed("routes", 400) {
                Ok(value) => value,
                Err(message) => return fail(message),
            };
            let iterations: u32 = match args.parsed("iterations", 1_000_000) {
                Ok(value) => value,
                Err(message) => return fail(message),
            };
            let batches: usize = match args.parsed("batches", 5) {
                Ok(value) => value,
                Err(message) => return fail(message),
            };
            match miss::measure(routes, iterations, batches) {
                Ok(miss) => {
                    println!(
                        "miss routes={} iterations={} batches={batches} per_miss_ns={}",
                        miss.routes,
                        miss.iterations,
                        miss.per_miss.as_nanos()
                    );
                    ExitCode::SUCCESS
                }
                Err(err) => fail(err),
            }
        }
        other => fail(format!(
            "unknown command `{other}`; the commands are load, idle and miss"
        )),
    }
}
