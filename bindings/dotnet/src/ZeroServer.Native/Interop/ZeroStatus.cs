namespace ZeroServer.Native.Interop;

/// <summary>
/// What a native call ended with, mirroring <c>ZeroStatus</c> in <c>zero.h</c>. The
/// library only ever returns a status, and never reads one from the host.
/// </summary>
/// <remarks>
/// A value of <see cref="Ok"/> means success; any other value is a refusal whose message
/// is available from <see cref="NativeMethods.zero_last_error_message"/> on the same
/// thread. <c>cargo xtask surface --check</c> holds every member and value to the header.
/// </remarks>
public enum ZeroStatus
{
    /// <summary>The call succeeded.</summary>
    Ok = 0,

    /// <summary>A protocol rule refused the input.</summary>
    Protocol = 1,

    /// <summary>The operating system refused: a bind failure, TLS material that cannot be read.</summary>
    Io = 2,

    /// <summary>An option document is malformed; the last error names the key or the position.</summary>
    Codec = 3,

    /// <summary>
    /// The id is stale or unknown, the slot is not in a state the call accepts, the response
    /// is sealed, the connection is gone, the target is detached or the server is stopped.
    /// </summary>
    Closed = 4,

    /// <summary>An authentication rule refused the input.</summary>
    Auth = 5,

    /// <summary>
    /// The capability is compiled out, the call needs a feature that has not shipped, or the
    /// conformance section is unknown.
    /// </summary>
    Unsupported = 6,

    /// <summary>A poll or a wait timed out, or a poll was woken.</summary>
    Timeout = 7,

    /// <summary>
    /// A bound is reached: the pins of a thread, the readers of a slot, the response limit,
    /// an outbox limit, the free worker indexes, a target already attached, a server still
    /// running at its free, or an array too short for its count.
    /// </summary>
    Limit = 8,

    /// <summary>
    /// An argument is out of its range or its set, a pointer is NULL or misaligned, a size is
    /// below its version 1 size, or the call is made from a thread that may not make it.
    /// </summary>
    InvalidArgument = 9,

    /// <summary>A panic was caught inside the export, or a panic poisoned the state the call needs.</summary>
    Panic = 10,
}
