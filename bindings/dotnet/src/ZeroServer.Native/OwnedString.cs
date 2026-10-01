using System.Runtime.InteropServices;

namespace ZeroServer.Native.Interop;

/// <summary>Reads and releases the owned strings the C ABI produces.</summary>
public static class OwnedString
{
    /// <summary>Copies an owned string out and releases it.</summary>
    /// <param name="text">The native string handle.</param>
    /// <returns>The string.</returns>
    /// <exception cref="ZeroServerException">The native call produced no string.</exception>
    public static string Read(IntPtr text)
    {
        string? read = ReadOrNull(text);
        return read ?? throw new ZeroServerException(
            Status.LastError() ?? "the call produced no string");
    }

    /// <summary>Copies an owned string out and releases it, allowing none.</summary>
    /// <param name="text">The native string handle, which may be null.</param>
    /// <returns>The string, or <c>null</c> when the call produced none.</returns>
    public static string? ReadOrNull(IntPtr text)
    {
        if (text == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            return Marshal.PtrToStringUTF8(NativeMethods.zero_string_data(text));
        }
        finally
        {
            NativeMethods.zero_string_free(text);
        }
    }
}
