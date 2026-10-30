// The smoke run of the .NET binding over the C ABI: the ABI version, the native library
// resolver, the struct layouts, every import against its documented refusal, every codec
// section of the conformance vectors, and a live server served by a pull loop on a
// dedicated thread. The native library is loaded only from ZERO_SERVER_NATIVE_LIBRARY_PATH.
using System.Runtime.CompilerServices;
using System.Text.Json;

using ZeroServer.Native.Interop;
using ZeroServer.Smoke;

if (args is [Loader.ChildArgument])
{
    return Loader.Child();
}

string? library = Environment.GetEnvironmentVariable(NativeMethods.LibraryPathVariable);
if (string.IsNullOrEmpty(library))
{
    Console.Error.WriteLine($"smoke test: set {NativeMethods.LibraryPathVariable} to the absolute path of the zero_ffi library, such as target/release/libzero_ffi.so");
    return 2;
}

return Run(library);

// The first native call skips the GC transition, so it can be bound while this method is
// compiled; it resolves only if the module initializer registered the resolver first.
[MethodImpl(MethodImplOptions.NoInlining)]
static int Run(string library)
{
    uint abi = NativeMethods.zero_abi_version();
    try
    {
        Check.Equal(Native.AbiVersion, abi, "zero_abi_version");
        Console.WriteLine($"abi version {abi}");
        Console.WriteLine($"loader: {Loader.Run(library)} child processes bind an absolute path and refuse a relative or missing one");
        Console.WriteLine($"layout: {Layout.Run()} structs match zero-ffi's sizes and offsets");
        Console.WriteLine($"refusals: {Refusals.Run()} imports refuse NULL outputs and wide ids with InvalidArgument");

        using JsonDocument vectors = Conformance.Load();
        JsonElement root = vectors.RootElement;
        Console.WriteLine($"conformance: {Conformance.Run(vectors)} sections computed again equal vectors.json");

        EchoServer echo = new(root);
        Console.WriteLine($"http1Parser: {echo.Http1Parser(root.GetProperty("http1Parser"))} cases end to end");
        Console.WriteLine($"responseSplitting: {echo.ResponseSplitting(root.GetProperty("responseSplitting"))} cases through zero_res_header");
        echo.WebSocket(root);
        Console.WriteLine("ws: handshake, echo and close end to end");
        echo.ThrowingHandler();
        Console.WriteLine("a handler that throws is answered 500 and the next request succeeds");
        echo.CollectionWhilePolling();
        Console.WriteLine("a full collection returns while the pull loop blocks in zero_target_poll");
        echo.DetachAndStop();
        Console.WriteLine("zero_target_detach ends the blocked poll with Closed");

        JsonElement router = root.GetProperty("router");
        RouterServer routes = new(router.GetProperty("table"));
        Console.WriteLine($"router: {routes.Run(router.GetProperty("cases"))} cases end to end");
        routes.Stop();
    }
    catch (SmokeFailure failure)
    {
        Console.Error.WriteLine($"smoke test failed: {failure.Message}");
        return 1;
    }

    Console.WriteLine("ok");
    return 0;
}
