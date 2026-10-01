// The smallest program over the binding: load the compiled core and print its version.
using ZeroServer.Core;

namespace Guides;

/// <summary>The version guide: the core is loaded and reports its version.</summary>
public static class VersionGuide
{
    /// <summary>Runs the guide.</summary>
    public static void Run()
    {
        // ANCHOR: version
        string core = ZeroServerCore.Version;
        Console.WriteLine($"zero-server core {core}");
        // ANCHOR_END: version

        Guide.Expect(core.Length > 0, "Version should be a non-empty string");
    }
}
