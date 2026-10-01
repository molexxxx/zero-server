using System.Runtime.InteropServices;

using ZeroServer.Native.Interop;

namespace ZeroServer.Core;

/// <summary>The core's own surface: what the runtime is, rather than what it can do.</summary>
public static class ZeroServerCore
{
    /// <summary>The version of the native zero-server core.</summary>
    /// <remarks>
    /// The native string is owned by the library for the life of the process; a null
    /// pointer means the call panicked inside the core and reads as an empty string.
    /// </remarks>
    public static string Version =>
        Marshal.PtrToStringUTF8(NativeMethods.zero_version()) ?? string.Empty;
}
