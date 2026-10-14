# The image the local checks run in: the pinned Rust toolchain's base with rustfmt and
# clippy, plus Node for the binding packages. Build it from this directory so the
# context stays small: docker build -f .docker/lint.Dockerfile -t zero-server-lint .docker
#
# rust:1.99.0-trixie is the Docker Hub tag for the toolchain rust-toolchain.toml pins,
# pushed 2026-10-12 (https://hub.docker.com/_/rust/tags?name=1.99.0, read 2026-10-14).
# Node 24.22.0 is the newest release of the Active LTS line on 2026-10-14
# (https://nodejs.org/dist/index.json; its checksum from
# https://nodejs.org/dist/v24.22.0/SHASUMS256.txt).
FROM rust:1.99.0-trixie@sha256:d3ba1ad5d5b5a180ca8428b4fab8543a1b3933b32a8a7ad90a7ebbaf5497203a

ARG NODE_VERSION=24.22.0
ARG NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008

RUN rustup component add rustfmt clippy

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends xz-utils; \
    rm -rf /var/lib/apt/lists/*; \
    archive="node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"; \
    echo "${NODE_SHA256}  ${archive}" | sha256sum -c -; \
    tar -xJf "${archive}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "${archive}"; \
    node --version; \
    npm --version
