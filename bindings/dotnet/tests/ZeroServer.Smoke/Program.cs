// Smoke test: confirms the facade loads and the native core is reachable.
using ZeroServer.Core;

string version = ZeroServerCore.Version;
Console.WriteLine($"zero-server version: {version}");
Assert(!string.IsNullOrEmpty(version), "version should be a non-empty string");

Console.WriteLine("ok");
return 0;

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        Console.Error.WriteLine($"smoke test failed: {message}");
        Environment.Exit(1);
    }
}
