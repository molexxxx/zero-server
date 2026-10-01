namespace ZeroServer;

/// <summary>The exception thrown when a zero-server operation fails.</summary>
public class ZeroServerException : Exception
{
    /// <summary>Creates an exception with the given message.</summary>
    /// <param name="message">A human-readable description of the failure.</param>
    public ZeroServerException(string message)
        : base(message)
    {
    }

    /// <summary>Creates an exception with the given message and underlying cause.</summary>
    /// <param name="message">A human-readable description of the failure.</param>
    /// <param name="innerException">The underlying cause.</param>
    public ZeroServerException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
