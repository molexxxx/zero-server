# zero-core workflows. Run `just` to list available recipes.

# show all recipes
default:
    @just --list

# install required toolchain components
setup:
    rustup component add rustfmt clippy

# format the whole workspace
fmt:
    cargo fmt --all

# check formatting without writing changes
fmt-check:
    cargo fmt --all -- --check

# type-check the workspace
check:
    cargo check --workspace --all-targets

# lint with clippy, warnings treated as errors
lint:
    cargo clippy --workspace --all-targets -- -D warnings

# verify every member manifest carries the lint table its capability row names
lints-check:
    cargo xtask lints --check

# run the test suite
test:
    cargo test --workspace

# build the workspace
build:
    cargo build --workspace

# build the no_std crates without std, as CI does
nostd:
    cargo build --no-default-features -p zero-core -p zero-limits -p zero-simd -p zero-http-types -p zero-date -p zero-http1 -p zero-router -p zero-uri -p zero-qs -p zero-mime -p zero-base64 -p zero-json -p zero-ws -p zero-sse -p zero-qpack -p zero-h3

# report what each named feature set of the zero-server crate compiles, and the built engine sizes
builds:
    cargo xtask builds

# verify the generated crate READMEs and the doc regions are in sync
docs-check:
    cargo xtask docs --check

# verify every standards row at or below the current release has its test
standards-check:
    cargo xtask standards --check

# render the documentation site into target/site (the four references are generated separately)
site:
    cargo xtask site

# check every link of the finished site in target/site, the references included
site-verify:
    cargo xtask site --verify

# run the guide examples in every language (the code the documentation site shows)
guides:
    cargo test -p zero-examples --test guides
    cd bindings/node && npm run test:guides
    cd bindings/python && python -m pytest tests/test_guides.py
    dotnet run --project bindings/dotnet/samples/ZeroServer.Guides -c Release

# audit the shipped dependency graph against deny.toml (needs cargo-deny installed)
deny:
    cargo deny check

# audit the io-compio and http3 feature graphs against their addenda in deny/
deny-features:
    cargo deny --config deny/io-compio.toml --manifest-path crates/zero-io/Cargo.toml --features io-compio check
    cargo deny --config deny/http3.toml --manifest-path crates/zero-server/Cargo.toml --features http3 check

# verify every third-party crate is covered by an audit, an import, or an exemption (needs cargo-vet installed)
vet:
    cargo vet --locked

# verify every manifest, lockfile, and generated loader carries the workspace version
version-check:
    cargo xtask version --check

# run everything the main CI job runs
ci: fmt-check lint lints-check nostd test docs-check standards-check version-check release-plan

# set the workspace version everywhere and refresh the lockfiles (just bump 0.2.0)
bump version:
    cargo xtask version {{version}}

# print the crates.io publish order derived from cargo metadata
release-plan:
    cargo xtask release --plan

# publish every workspace crate to crates.io in dependency order
release:
    cargo xtask release

# package and verify every crate without uploading
release-dry:
    cargo xtask release --dry-run

# run one benchmark entry in release mode (just bench plaintext)
bench entry:
    cargo run -p zero-bench --release -- {{entry}}

# run every fuzz target for one minute each (Linux only; needs cargo-fuzz and a nightly toolchain)
fuzz-smoke:
    for target in $(cargo fuzz list); do cargo fuzz run "$target" -- -max_total_time=60; done

# rerun the three binding probes inside Linux containers and write the rerun reports
probes:
    cargo xtask probes

# start a local PostgreSQL server for the driver tests, on the port they expect
db:
    docker rm -f zero-core-db 2>/dev/null || true
    docker run -d --name zero-core-db -p 5432:5432 \
        -e POSTGRES_USER=zero -e POSTGRES_PASSWORD=zero -e POSTGRES_DB=zero \
        postgres:18

# stop the local PostgreSQL server
db-stop:
    docker rm -f zero-core-db
