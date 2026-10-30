using System.Diagnostics;
using System.Runtime.CompilerServices;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>
/// The resolver's handling of <see cref="NativeMethods.LibraryPathVariable"/>, in child
/// processes of this executable, since a process binds the library once: an absolute path
/// loads, and a relative path or a path that does not load throws
/// <see cref="DllNotFoundException"/> at the first call instead of falling back to another
/// copy.
/// </summary>
internal static class Loader
{
    /// <summary>The argument that makes this executable a child that only binds the library.</summary>
    public const string ChildArgument = "--bind-only";

    /// <summary>The exit code of a child whose first call could not bind the library.</summary>
    public const int NotBound = 3;

    /// <summary>Runs the child's part: one native call, reported on standard output.</summary>
    /// <returns>0 when the library was bound, <see cref="NotBound"/> otherwise.</returns>
    public static int Child()
    {
        try
        {
            Console.WriteLine($"bound abi {Bind()}");
            return 0;
        }
        catch (DllNotFoundException error)
        {
            Console.WriteLine($"not bound: {error.Message}");
            return NotBound;
        }
    }

    /// <summary>Starts children with each kind of path.</summary>
    /// <param name="library">The absolute path of the library this process loaded.</param>
    /// <returns>How many children ran.</returns>
    public static int Run(string library)
    {
        (int code, string output) = Spawn(library);
        Check.Equal(0, code, $"a child given the absolute path {library}: {output}");

        string relative = Path.GetRelativePath(Environment.CurrentDirectory, library);
        (code, output) = Spawn(relative);
        Check.Equal(NotBound, code, $"a child given the relative path {relative}: {output}");
        Check.That(output.Contains("absolute path", StringComparison.Ordinal), $"the refusal of a relative path names the rule: {output}");

        string missing = Path.Combine(Path.GetTempPath(), $"zero-smoke-{Environment.ProcessId}", Path.GetFileName(library));
        (code, output) = Spawn(missing);
        Check.Equal(NotBound, code, $"a child given the path of no file {missing}: {output}");
        Check.That(output.Contains(missing, StringComparison.Ordinal), $"the refusal of a missing file names it: {output}");
        return 3;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static uint Bind() => NativeMethods.zero_abi_version();

    private static (int Code, string Output) Spawn(string library)
    {
        string executable = Environment.ProcessPath ?? throw new SmokeFailure("no path of this process");
        ProcessStartInfo start = new(executable)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        if (Path.GetFileNameWithoutExtension(executable) == "dotnet")
        {
            start.ArgumentList.Add(typeof(Loader).Assembly.Location);
        }

        start.ArgumentList.Add(ChildArgument);
        start.Environment[NativeMethods.LibraryPathVariable] = library;
        using Process child = Process.Start(start) ?? throw new SmokeFailure("the child did not start");
        Task<string> output = child.StandardOutput.ReadToEndAsync();
        Task<string> errors = child.StandardError.ReadToEndAsync();
        Check.That(child.WaitForExit(Check.Patience), "the child exits");
        return (child.ExitCode, (output.Result + errors.Result).Trim());
    }
}
