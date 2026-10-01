FROM rust:latest

ADD ./ /zero-server
WORKDIR /zero-server

RUN cargo clean
RUN RUSTFLAGS="-C target-cpu=native" cargo build --release -p zero-bench --bin zero-server-plt

EXPOSE 8080

CMD ./target/release/zero-server-plt --port 8080
