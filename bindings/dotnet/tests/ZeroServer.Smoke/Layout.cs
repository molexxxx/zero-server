using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>
/// The struct layouts of the generated declarations against the numbers zero-ffi asserts at
/// compile time for a 64-bit target (<c>crates/zero-ffi/src/abi/layout.rs</c>), where no
/// struct has a padding byte: every field, its offset, and the size.
/// </summary>
internal static class Layout
{
    private static readonly (Type Type, int Size, (string Field, int Offset)[] Fields)[] Expected =
    [
        (typeof(ZeroBytes), 16, [("ptr", 0), ("len", 8)]),
        (typeof(ZeroSpan), 8, [("start", 0), ("len", 4)]),
        (typeof(ZeroField), 20, [("name", 0), ("value", 8), ("id", 16)]),
        (typeof(ZeroRequestView), 120,
        [
            ("size", 0), ("method", 4), ("version", 5), ("flags", 6), ("route", 8),
            ("miss_status", 12), ("allow", 14), ("head", 16), ("head_len", 24),
            ("field_count", 28), ("method_token", 32), ("target", 40), ("path", 48),
            ("query", 56), ("authority", 64), ("fields", 72), ("route_path", 80),
            ("route_path_len", 88), ("param_count", 92), ("body", 96), ("body_len", 104),
            ("field_size", 112), ("reserved", 116),
        ]),
        (typeof(ZeroPeer), 52,
        [
            ("size", 0), ("family", 4), ("secure", 5), ("transport", 6), ("alpn", 7),
            ("port", 8), ("client_port", 10), ("client_family", 12), ("reserved", 13),
            ("address", 20), ("client_address", 36),
        ]),
        (typeof(ZeroHeaderPair), 32, [("name", 0), ("value", 16)]),
        (typeof(ZeroResponseSpec), 48,
        [
            ("size", 0), ("status", 4), ("reserved", 6), ("field_size", 8), ("reserved2", 12),
            ("fields", 16), ("field_count", 24), ("body", 32),
        ]),
        (typeof(ZeroStats), 128,
        [
            ("size", 0), ("reserved", 4), ("dispatched", 8), ("batches", 16), ("acks", 24),
            ("late_readers", 32), ("queue_full", 40), ("refused_503", 48), ("closed_leases", 56),
            ("panics", 64), ("pinned", 72), ("quarantined_peak", 80), ("in_flight", 88),
            ("leased", 96), ("refused_acks", 104), ("abandoned_batches", 112), ("retained", 120),
        ]),
        (typeof(ZeroBatch), 24,
        [
            ("size", 0), ("worker", 4), ("kind", 5), ("flags", 6), ("count", 8), ("reserved", 12),
            ("epoch", 16),
        ]),
        (typeof(ZeroEvent), 32,
        [
            ("conn", 0), ("route", 8), ("kind", 12), ("opcode", 13), ("close_code", 14), ("data", 16),
        ]),
        (typeof(ZeroPluginVTable), 32,
        [
            ("abi_version", 0), ("size", 4), ("ctx", 8), ("handle", 16), ("unload", 24),
        ]),
        (typeof(ZeroHostApi), 56,
        [
            ("abi_version", 0), ("size", 4), ("req_view", 8), ("req_header", 16), ("req_body", 24),
            ("res_respond", 32), ("res_body_alloc", 40), ("res_send", 48),
        ]),
    ];

    /// <summary>Checks every struct of the generated declarations.</summary>
    /// <returns>How many structs were checked.</returns>
    public static int Run()
    {
        Check.That(Environment.Is64BitProcess, "the layout numbers are those of a 64-bit target");
        MethodInfo sizeOf = typeof(Unsafe).GetMethod(nameof(Unsafe.SizeOf))!;
        Type[] declared = typeof(NativeMethods).Assembly
            .GetTypes()
            .Where(type => type.IsValueType && !type.IsEnum && !type.IsByRefLike && type.IsPublic && type.Namespace == typeof(NativeMethods).Namespace)
            .ToArray();
        Check.Equal(
            string.Join(", ", Expected.Select(item => item.Type.Name).Order(StringComparer.Ordinal)),
            string.Join(", ", declared.Select(type => type.Name).Order(StringComparer.Ordinal)),
            "the structs of the generated declarations");

        foreach ((Type type, int size, (string Field, int Offset)[] fields) in Expected)
        {
            Check.Equal(size, Marshal.SizeOf(type), $"Marshal.SizeOf({type.Name})");
            Check.Equal(size, (int)sizeOf.MakeGenericMethod(type).Invoke(null, null)!, $"sizeof({type.Name})");
            string[] names = type.GetFields(BindingFlags.Instance | BindingFlags.Public).Select(field => field.Name).ToArray();
            Check.Equal(
                string.Join(", ", fields.Select(field => field.Field)),
                string.Join(", ", names),
                $"the fields of {type.Name}");
            foreach ((string field, int offset) in fields)
            {
                Check.Equal((nint)offset, Marshal.OffsetOf(type, field), $"Marshal.OffsetOf({type.Name}, {field})");
            }
        }

        return Expected.Length;
    }
}
