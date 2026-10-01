# ZeroServer.Core

The zero-server core's surface for .NET: the runtime version of the compiled core. This is the counterpart of the `zero-core` crate, and like it, it is small. The compiled core it loads is `ZeroServer.Native`.

## Install

```sh
dotnet add package ZeroServer.Core
```

## Use

```csharp
using ZeroServer.Core;

Console.WriteLine(ZeroServerCore.Version);
```
