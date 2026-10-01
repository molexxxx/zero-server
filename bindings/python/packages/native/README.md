# zero-server-native

The compiled zero-server core for Python and the generated contract every `zero-server` package builds on. It is installed as a dependency of `zero-server-core`, not directly; the facade packages are the entry point.

The extension is imported as `zero_server._native` and re-exported verbatim at `zero_server.raw`. Its type stub `zero_server/_native/__init__.pyi` is written by the `stub_gen` binary from the Rust source and drift-checked in CI.
