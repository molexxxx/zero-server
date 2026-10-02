# ZeroServer.Native

The compiled zero-server core for .NET and the P/Invoke contract every `ZeroServer` package builds on. It is installed as a dependency of `ZeroServer.Core`, not directly.

`Interop/NativeMethods.cs` declares the exports of `crates/zero-ffi/include/zero.h`, and the package carries the `zero_ffi` cdylib under `runtimes/<rid>/native/` for each published runtime identifier.
