FROM rust:latest

ADD ./ /zero-server
WORKDIR /zero-server

RUN cargo clean
RUN RUSTFLAGS="-C target-cpu=native" cargo build --release -p zero-bench --bin zero-server

EXPOSE 8080

CMD ./target/release/zero-server --port 8080
