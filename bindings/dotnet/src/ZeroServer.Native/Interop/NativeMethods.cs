using System.Diagnostics.CodeAnalysis;
using System.Reflection;
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
/// <para>
/// This is the low-level escape hatch (the .NET analog of <c>@zero-server/native</c>
/// and <c>zero_server.raw</c>). The imports and the structs are generated from the
/// header into <c>NativeMethods.g.cs</c> by <c>cargo xtask ffi-mirror --write</c>; this
/// part holds the library name and its resolver. Pointers are typed as the header types
/// them, and the caller owns lifetime and string encoding, exactly as the C header
/// specifies.
/// </para>
/// <para>
/// The library is loaded from the path in the <see cref="LibraryPathVariable"/>
/// environment variable when it is set, and otherwise where the runtime finds a native
/// asset of the application: beside it, or under <c>runtimes/&lt;rid&gt;/native/</c> of
/// this package.
/// </para>
/// </remarks>
public static partial class NativeMethods
{
    /// <summary>The environment variable that names the native library file to load.</summary>
    /// <remarks>
    /// The absolute path of a <c>zero_ffi</c> build, such as the output of
    /// <c>cargo build -p zero-ffi --release</c>. A relative path is refused, so the library
    /// is never taken from whatever directory the process happens to run in, and a path
    /// that does not load throws <see cref="DllNotFoundException"/> at the first native
    /// call rather than falling back to another copy.
    /// </remarks>
    public const string LibraryPathVariable = "ZERO_SERVER_NATIVE_LIBRARY_PATH";

    private const string Library = "zero_ffi";

    /// <summary>Registers the native library resolver when the assembly loads.</summary>
    /// <remarks>
    /// <para>
    /// The four imports that skip the GC transition can be bound while the method that
    /// calls them is compiled, before any statement of that method runs, so a resolver an
    /// application registers from its own code can come too late. A module initializer
    /// runs before any code of this assembly, which makes the resolver the first attempt
    /// for every import.
    /// </para>
    /// <para>
    /// CA2255 advises against a module initializer in a library because it can interfere
    /// with the application's own initialization. This one registers a resolver for this
    /// assembly only, which answers for the <c>zero_ffi</c> library alone, so no other
    /// assembly's loading changes.
    /// </para>
    /// </remarks>
    /// <seealso href="https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.suppressgctransitionattribute?view=net-10.0#remarks"/>
    /// <seealso href="https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2255"/>
    [ModuleInitializer]
    [SuppressMessage(
        "Usage",
        "CA2255:The 'ModuleInitializer' attribute should not be used in libraries",
        Justification = "The resolver must be in place before a SuppressGCTransition import is bound, and it answers for this assembly's own library only.")]
    internal static void RegisterResolver()
    {
        NativeLibrary.SetDllImportResolver(typeof(NativeMethods).Assembly, Resolve);
    }

    /// <summary>Loads the library <see cref="LibraryPathVariable"/> names.</summary>
    /// <param name="libraryName">The library an import names.</param>
    /// <param name="assembly">The assembly whose import is being bound.</param>
    /// <param name="searchPath">The search path the import asks for.</param>
    /// <returns>
    /// The handle of the loaded library, or <see cref="IntPtr.Zero"/> to let the runtime
    /// load it the default way.
    /// </returns>
    /// <exception cref="DllNotFoundException">
    /// The variable holds a relative path, or names a file that does not load.
    /// </exception>
    private static IntPtr Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (libraryName != Library)
        {
            return IntPtr.Zero;
        }

        string? path = Environment.GetEnvironmentVariable(LibraryPathVariable);
        if (string.IsNullOrEmpty(path))
        {
            return IntPtr.Zero;
        }

        if (!Path.IsPathFullyQualified(path))
        {
            throw new DllNotFoundException($"{LibraryPathVariable} must hold an absolute path, not {path}");
        }

        return NativeLibrary.Load(path);
    }
}
