using System.Reflection;

using ZeroServer.Core;
using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>
/// Every import of the generated declarations, called through reflection with NULL or
/// invalid arguments, against the status the header documents: an id above
/// <c>ZERO_ID_MAX</c> (rule 1) and a NULL output (rule 3) are <c>InvalidArgument</c>, a
/// refusal records a message (rule 12), and the functions over owned handles take NULL as
/// no handle (rule 7). An import the library does not export fails here when it is bound.
/// </summary>
internal static unsafe class Refusals
{
    private const ulong Wide = 1UL << 53;

    private static readonly HashSet<string> Ids = ["app", "child", "server", "slot", "conn", "target", "except_conn"];

    private static readonly string[] ValueImports =
    [
        "zero_abi_version",
        "zero_buffer_data",
        "zero_buffer_free",
        "zero_buffer_len",
        "zero_last_error_message",
        "zero_string_data",
        "zero_string_free",
        "zero_string_len",
        "zero_version",
    ];

    /// <summary>Calls every import.</summary>
    /// <returns>How many imports refused with <c>InvalidArgument</c>.</returns>
    public static int Run()
    {
        MethodInfo[] imports = typeof(NativeMethods).GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly);
        int refused = 0;
        foreach (MethodInfo import in imports.Where(method => method.ReturnType == typeof(ZeroStatus)))
        {
            object?[] arguments = import.GetParameters().Select(Placeholder).ToArray();
            ZeroStatus status = (ZeroStatus)import.Invoke(null, arguments)!;
            Check.Equal(ZeroStatus.InvalidArgument, status, $"{import.Name} with NULL outputs and ids above ZERO_ID_MAX");
            string? message = Status.LastError();
            Check.That(!string.IsNullOrEmpty(message), $"{import.Name} records the message of its refusal");
            refused++;
        }

        Check.Equal(
            string.Join(", ", ValueImports),
            string.Join(", ", imports.Where(method => method.ReturnType != typeof(ZeroStatus)).Select(method => method.Name).Order(StringComparer.Ordinal)),
            "the imports that return a value rather than a status");

        Check.Equal(Native.AbiVersion, NativeMethods.zero_abi_version(), "zero_abi_version");
        Check.That(NativeMethods.zero_version() != IntPtr.Zero, "zero_version returns the static version string");
        Check.That(ZeroServerCore.Version.Length > 0, "ZeroServerCore.Version reads the version");

        ulong app;
        Check.Equal(ZeroStatus.InvalidArgument, NativeMethods.zero_app_free(Wide), "zero_app_free of an id above ZERO_ID_MAX");
        nint message1 = NativeMethods.zero_last_error_message();
        nint message2 = NativeMethods.zero_last_error_message();
        Check.That(message1 != IntPtr.Zero && message2 != IntPtr.Zero && message1 != message2, "each read of the last error is a new owned string");
        string first = OwnedString.Read(message1);
        Check.Equal(first, OwnedString.Read(message2), "reading the last error does not clear it");
        Check.Ok(NativeMethods.zero_app_new(&app), "zero_app_new");
        Check.Equal(first, Status.LastError(), "a call that succeeds leaves the last error as it was");
        Check.Ok(NativeMethods.zero_app_free(app), "zero_app_free");
        Check.Equal(ZeroStatus.Closed, NativeMethods.zero_app_free(app), "zero_app_free of a freed app");

        Check.Equal(IntPtr.Zero, NativeMethods.zero_string_data(IntPtr.Zero), "zero_string_data(NULL)");
        Check.Equal((nuint)0, NativeMethods.zero_string_len(IntPtr.Zero), "zero_string_len(NULL)");
        NativeMethods.zero_string_free(IntPtr.Zero);
        Check.Equal(IntPtr.Zero, NativeMethods.zero_buffer_data(IntPtr.Zero), "zero_buffer_data(NULL)");
        Check.Equal((nuint)0, NativeMethods.zero_buffer_len(IntPtr.Zero), "zero_buffer_len(NULL)");
        NativeMethods.zero_buffer_free(IntPtr.Zero);
        Check.Equal((string?)null, OwnedString.ReadOrNull(IntPtr.Zero), "OwnedString.ReadOrNull(NULL)");

        return refused;
    }

    /// <summary>The argument a refusal case passes for one parameter.</summary>
    /// <param name="parameter">The parameter.</param>
    /// <returns>NULL for a pointer, an id above <c>ZERO_ID_MAX</c> for an id, and 0 otherwise.</returns>
    private static object? Placeholder(ParameterInfo parameter)
    {
        Type type = parameter.ParameterType;
        string name = parameter.Name ?? string.Empty;
        if (type.IsPointer)
        {
            return Pointer.Box(null, type);
        }

        if (type == typeof(ulong))
        {
            return Ids.Contains(name) ? Wide : 0UL;
        }

        if (type == typeof(byte))
        {
            return name == "worker" ? (byte)128 : (byte)0;
        }

        if (type == typeof(ushort))
        {
            return (ushort)0;
        }

        if (type == typeof(uint))
        {
            return 0U;
        }

        if (type == typeof(nuint))
        {
            return (nuint)0;
        }

        if (type == typeof(nint))
        {
            return IntPtr.Zero;
        }

        throw new SmokeFailure($"no refusal argument for {name} of type {type}");
    }
}
