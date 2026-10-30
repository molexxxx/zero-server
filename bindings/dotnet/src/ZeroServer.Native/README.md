# ZeroServer.Native

The compiled zero-server core for .NET and the P/Invoke contract every `ZeroServer` package builds on. It is installed as a dependency of `ZeroServer.Core`, not directly.

`Interop/NativeMethods.g.cs`, generated from `crates/zero-ffi/include/zero.h` by `cargo xtask ffi-mirror`, declares its exports, and the package carries the `zero_ffi` cdylib under `runtimes/<rid>/native/` for each published runtime identifier.
