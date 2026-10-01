//! The Platform TechEmpower entry: `zero-server-plt [--port 8080] [--threads 0] [--handoff]`.

use std::net::SocketAddr;
use std::process::ExitCode;

use zero_bench::args::Args;
use zero_bench::entries::{config, start_platform};

fn main() -> ExitCode {
    let args = Args::parse(std::env::args().skip(1));
    let port: u16 = match args.parsed("port", 8080) {
        Ok(port) => port,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let threads: usize = match args.parsed("threads", 0) {
        Ok(threads) => threads,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    match start_platform(addr, config(threads, args.flag("handoff"))) {
        Ok(workers) => {
            println!(
                "zero-server-plt listening on {} with {} core(s), pid {}",
                workers.local_addr(),
                workers.count(),
                std::process::id()
            );
            match workers.join() {
                Ok(()) => ExitCode::SUCCESS,
                Err(err) => {
                    eprintln!("zero-server-plt stopped: {err}");
                    ExitCode::FAILURE
                }
            }
        }
        Err(err) => {
            eprintln!("zero-server-plt could not start: {err}");
            ExitCode::FAILURE
        }
    }
}
