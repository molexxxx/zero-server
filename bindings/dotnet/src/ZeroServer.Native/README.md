# ZeroServer.Native

The compiled zero-server core for .NET and the P/Invoke contract every `ZeroServer` package builds on. It is installed as a dependency of `ZeroServer.Core`, not directly; the facade packages are the entry point.

`Interop/NativeMethods.cs` mirrors `crates/zero-ffi/include/zero.h` one-to-one with source-generated `[LibraryImport]` declarations, and the package carries the `zero_ffi` cdylib under `runtimes/<rid>/native/` for each published runtime identifier.
