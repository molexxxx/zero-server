using System.Diagnostics;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>The assertions of the smoke run; each failure throws with what was checked.</summary>
internal static class Check
{
    /// <summary>The longest any wait of the run lasts before it fails.</summary>
    public static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    /// <summary>Fails unless <paramref name="condition"/> holds.</summary>
    /// <param name="condition">The expectation.</param>
    /// <param name="what">What the expectation states.</param>
    public static void That(bool condition, string what)
    {
        if (!condition)
        {
            throw new SmokeFailure(what);
        }
    }

    /// <summary>Fails unless the two values are equal.</summary>
    /// <typeparam name="T">The type of the values.</typeparam>
    /// <param name="expected">The value expected.</param>
    /// <param name="actual">The value found.</param>
    /// <param name="what">What the values are.</param>
    public static void Equal<T>(T expected, T actual, string what)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new SmokeFailure($"{what}: expected {expected}, got {actual}");
        }
    }

    /// <summary>Fails unless a native call succeeded, naming the refusal it recorded.</summary>
    /// <param name="status">The status the call returned.</param>
    /// <param name="what">The call.</param>
    public static void Ok(ZeroStatus status, string what)
    {
        if (status != ZeroStatus.Ok)
        {
            throw new SmokeFailure($"{what}: {status}: {Status.LastError()}");
        }
    }

    /// <summary>Polls <paramref name="done"/> every millisecond until it holds.</summary>
    /// <param name="done">The condition.</param>
    /// <param name="what">What is awaited, for the failure.</param>
    public static void WaitFor(Func<bool> done, string what)
    {
        Stopwatch clock = Stopwatch.StartNew();
        while (!done())
        {
            if (clock.Elapsed > Patience)
            {
                throw new SmokeFailure($"timed out waiting for {what}");
            }

            Thread.Sleep(1);
        }
    }
}

/// <summary>A smoke expectation that did not hold.</summary>
/// <param name="message">What was expected and what was found.</param>
internal sealed class SmokeFailure(string message) : Exception(message);
