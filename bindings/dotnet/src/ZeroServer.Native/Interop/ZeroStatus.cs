namespace ZeroServer.Native.Interop;

/// <summary>
/// The result of a fallible native call, mirroring <c>ZeroStatus</c> in
/// <c>zero.h</c>.
/// </summary>
/// <remarks>
/// A value of <see cref="Ok"/> means success; any other value indicates a failure
/// whose message is available from
/// <see cref="NativeMethods.zero_last_error_message"/> on the same thread.
/// </remarks>
public enum ZeroStatus
{
    /// <summary>The call succeeded.</summary>
    Ok = 0,

    /// <summary>A peer violated the protocol it spoke.</summary>
    Protocol = 1,

    /// <summary>An operating-system input/output operation failed.</summary>
    Io = 2,

    /// <summary>A payload could not be encoded or decoded.</summary>
    Codec = 3,

    /// <summary>The operation targeted a connection or slot that is closed or stale.</summary>
    Closed = 4,

    /// <summary>A security check failed, such as an invalid token or a bad signature.</summary>
    Auth = 5,

    /// <summary>The requested capability is not compiled into this build.</summary>
    Unsupported = 6,

    /// <summary>The operation did not complete within its deadline.</summary>
    Timeout = 7,

    /// <summary>A configured limit was reached, such as a body size or a rate.</summary>
    Limit = 8,

    /// <summary>An argument was null or otherwise invalid, such as non-UTF-8 text.</summary>
    InvalidArgument = 9,

    /// <summary>A native panic was caught at the boundary; the call had no effect.</summary>
    Panic = 10,
}
