using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

internal static partial class Native
{
    private const string Library = "zero_ffi";

    [LibraryImport(Library, EntryPoint = "zero_version")]
    public static partial IntPtr Version();

    [LibraryImport(Library, EntryPoint = "zero_version")]
    [SuppressGCTransition]
    public static partial IntPtr VersionNoTransition();
}

internal static unsafe partial class Probe
{
    private const string Library = "ffi_probe";

    [StructLayout(LayoutKind.Sequential)]
    public struct View
    {
        public byte Method;
        public byte* PathPtr;
        public nuint PathLen;
    }

    [LibraryImport(Library, EntryPoint = "probe_call_n")]
    public static partial double CallN(delegate* unmanaged[Cdecl]<uint, uint> cb, uint n);

    [LibraryImport(Library, EntryPoint = "probe_call_n_thread")]
    public static partial double CallNThread(delegate* unmanaged[Cdecl]<uint, uint> cb, uint n);

    [LibraryImport(Library, EntryPoint = "probe_fill_view")]
    public static partial void FillView(View* view);

    [LibraryImport(Library, EntryPoint = "probe_fill_view")]
    [SuppressGCTransition]
    public static partial void FillViewNoTransition(View* view);
}

internal static unsafe class Program
{
    private static int counter;

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int Callback(int value) => value + 1;

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static uint ProbeCallback(uint value) => value + 1;

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static IntPtr Managed() => (IntPtr)(++counter);

    private static void Bench(string label, Func<IntPtr> call, int iterations)
    {
        for (int i = 0; i < 200_000; i++) call();
        long sink = 0;
        var watch = Stopwatch.StartNew();
        for (int i = 0; i < iterations; i++) sink += (long)call();
        watch.Stop();
        double ns = watch.Elapsed.TotalMilliseconds * 1_000_000.0 / iterations;
        Console.WriteLine($"{label}: {ns:F1} ns/call (sink {sink})");
    }

    private static void Main()
    {
        NativeLibrary.SetDllImportResolver(typeof(Native).Assembly, (name, assembly, path) =>
        {
            if (name != "zero_ffi" && name != "ffi_probe") return IntPtr.Zero;
            string file = OperatingSystem.IsWindows() ? name + ".dll"
                : OperatingSystem.IsMacOS() ? "lib" + name + ".dylib"
                : "lib" + name + ".so";
            string candidate = Path.Combine(AppContext.BaseDirectory, file);
            return File.Exists(candidate) ? NativeLibrary.Load(candidate) : IntPtr.Zero;
        });

        const int n = 20_000_000;
        Console.WriteLine("version: " + Marshal.PtrToStringUTF8(Native.Version()));
        Bench("managed static method returning nint", Managed, n);
        Bench("LibraryImport zero_version() -> IntPtr", Native.Version, n);
        Bench("LibraryImport zero_version() -> IntPtr, SuppressGCTransition", Native.VersionNoTransition, n);

        delegate* unmanaged[Cdecl]<int, int> pointer = &Callback;
        for (int i = 0; i < 200_000; i++) pointer(i);
        var watch = Stopwatch.StartNew();
        long total = 0;
        for (int i = 0; i < n; i++) total += pointer(i);
        watch.Stop();
        Console.WriteLine($"managed -> UnmanagedCallersOnly through delegate* unmanaged (reverse transition, no native hop): {watch.Elapsed.TotalMilliseconds * 1_000_000.0 / n:F1} ns/call (sink {total})");
        RunProbe(n);
        Console.WriteLine($".NET {Environment.Version} {RuntimeInformation.ProcessArchitecture} {RuntimeInformation.OSDescription}");
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunProbe(int n)
    {
        delegate* unmanaged[Cdecl]<uint, uint> probeCb = &ProbeCallback;
        Probe.CallN(probeCb, 200_000);
        double ns = Probe.CallN(probeCb, 20_000_000);
        Console.WriteLine($"native -> managed reverse P/Invoke, calling thread: {ns:F1} ns/call");
        ns = Probe.CallNThread(probeCb, 20_000_000);
        Console.WriteLine($"native -> managed reverse P/Invoke, fresh native thread (first attach amortized over 20M): {ns:F1} ns/call");
        ns = Probe.CallNThread(probeCb, 1);
        Console.WriteLine($"native -> managed reverse P/Invoke, fresh native thread, single call (thread attach cost): {ns:F0} ns");

        Probe.View view;
        for (int i = 0; i < 200_000; i++) Probe.FillView(&view);
        var sw = Stopwatch.StartNew();
        long lenSum = 0;
        for (int i = 0; i < n; i++)
        {
            Probe.FillView(&view);
            lenSum += (long)view.PathLen;
        }
        sw.Stop();
        Console.WriteLine($"request view fill (struct by pointer, ReadOnlySpan over Rust memory): {sw.Elapsed.TotalMilliseconds * 1_000_000.0 / n:F1} ns/call (sink {lenSum})");
        sw = Stopwatch.StartNew();
        lenSum = 0;
        for (int i = 0; i < n; i++)
        {
            Probe.FillViewNoTransition(&view);
            lenSum += new ReadOnlySpan<byte>(view.PathPtr, (int)view.PathLen).Length;
        }
        sw.Stop();
        Console.WriteLine($"request view fill, SuppressGCTransition, span construct: {sw.Elapsed.TotalMilliseconds * 1_000_000.0 / n:F1} ns/call (sink {lenSum})");
        sw = Stopwatch.StartNew();
        lenSum = 0;
        for (int i = 0; i < 2_000_000; i++)
        {
            Probe.FillViewNoTransition(&view);
            lenSum += System.Text.Encoding.UTF8.GetString(view.PathPtr, (int)view.PathLen).Length;
        }
        sw.Stop();
        Console.WriteLine($"request view fill + UTF8 decode of the path to string: {sw.Elapsed.TotalMilliseconds * 1_000_000.0 / 2_000_000:F1} ns/call (sink {lenSum})");
    }
}
