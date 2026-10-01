using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

// Every declaration is a source-generated LibraryImport over C-compatible types, so
// the runtime's own marshalling layer is never needed and is switched off, which is
// what lets a trivial accessor be inlined at its call site.
[assembly: DisableRuntimeMarshalling]

namespace ZeroServer.Native.Interop;

/// <summary>
/// The P/Invoke declarations for the zero-server C ABI, mirroring <c>zero.h</c>
/// one-to-one.
/// </summary>
/// <remarks>
/// This is the low-level escape hatch (the .NET analog of <c>@zero-server/native</c>
/// and <c>zero_server.raw</c>). The hand-written facades are the default entry
/// point; anything they do not surface is reachable here. All pointers are passed as
/// <see cref="IntPtr"/>; the caller owns lifetime and string encoding, exactly as the
/// C header specifies.
/// </remarks>
public static partial class NativeMethods
{
    private const string Library = "zero_ffi";

    /// <summary>Returns the version string of the native zero-server core.</summary>
    [LibraryImport(Library)]
    public static partial IntPtr zero_version();

    /// <summary>Returns the calling thread's most recent error message, or null.</summary>
    [LibraryImport(Library)]
    public static partial IntPtr zero_last_error_message();

    /// <summary>Returns a pointer to an owned string's null-terminated UTF-8 text.</summary>
    [LibraryImport(Library)]
    public static partial IntPtr zero_string_data(IntPtr text);

    /// <summary>Releases an owned string. Passing null is a no-op.</summary>
    [LibraryImport(Library)]
    public static partial void zero_string_free(IntPtr text);

    /// <summary>Returns the length in bytes of an owned buffer.</summary>
    [LibraryImport(Library)]
    public static partial nuint zero_buffer_len(IntPtr buffer);

    /// <summary>Returns a pointer to an owned buffer's bytes.</summary>
    [LibraryImport(Library)]
    public static partial IntPtr zero_buffer_data(IntPtr buffer);

    /// <summary>Releases an owned buffer. Passing null is a no-op.</summary>
    [LibraryImport(Library)]
    public static partial void zero_buffer_free(IntPtr buffer);
}
