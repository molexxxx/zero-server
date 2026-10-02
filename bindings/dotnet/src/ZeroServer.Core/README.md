# ZeroServer.Core

The zero-server core's surface for .NET: the runtime version of the compiled core. This is the counterpart of the `zero-core` crate, and like it, it is small. The compiled core it loads is `ZeroServer.Native`. It has no server API yet.

## Install

```sh
dotnet add package ZeroServer.Core --prerelease
```

## Use

```csharp
using ZeroServer.Core;

Console.WriteLine(ZeroServerCore.Version);
```
