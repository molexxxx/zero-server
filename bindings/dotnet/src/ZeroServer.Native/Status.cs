namespace ZeroServer.Native.Interop;

/// <summary>The thread-local error slot every native call reports through.</summary>
public static class Status
{
    /// <summary>
    /// Reads the calling thread's most recent native error message.
    /// </summary>
    /// <returns>The message, or <c>null</c> if none has been recorded.</returns>
    /// <remarks>
    /// The native last-error slot is thread-local, so this must be read on the same
    /// thread that made the failing call. The library hands the message over as a new
    /// owned string, which is copied out and released here; reading it does not clear it.
    /// </remarks>
    public static string? LastError() => OwnedString.ReadOrNull(NativeMethods.zero_last_error_message());

    /// <summary>Throws a <see cref="ZeroServerException"/> when <paramref name="status"/> is not OK.</summary>
    /// <param name="status">The status returned by a native call.</param>
    /// <exception cref="ZeroServerException"><paramref name="status"/> is not <see cref="ZeroStatus.Ok"/>.</exception>
    /// <remarks>Call this on the same thread as the native call so the last-error message resolves.</remarks>
    public static void ThrowIfError(ZeroStatus status)
    {
        if (status != ZeroStatus.Ok)
        {
            throw new ZeroServerException(LastError() ?? $"zero-server call failed with status {status}");
        }
    }
}
