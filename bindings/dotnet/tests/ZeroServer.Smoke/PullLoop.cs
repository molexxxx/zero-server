using System.Collections.Concurrent;
using System.Text;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>
/// The pull loop of one target on a dedicated thread, not the pool: it blocks in
/// <c>zero_target_poll</c>, runs the handler for each leased slot inside the batch window,
/// answers a handler that throws with <c>zero_res_error(500)</c>, and acknowledges every
/// batch with <c>zero_batch_complete</c>. It ends when the poll returns anything but a
/// batch or a timeout.
/// </summary>
internal sealed unsafe class PullLoop
{
    private readonly ulong _target;
    private readonly Action<ulong, uint> _onRequest;
    private readonly Action<ZeroEvent> _onEvent;
    private readonly Thread _thread;
    private volatile bool _polling;
    private volatile int _osThread;
    private long _batches;

    /// <summary>Creates the loop; <see cref="Start"/> runs it.</summary>
    /// <param name="name">The thread's name.</param>
    /// <param name="target">The target the loop polls; its first poll binds it to the loop's thread.</param>
    /// <param name="onRequest">Answers one leased slot, given its id and route.</param>
    /// <param name="onEvent">Takes one WebSocket or event stream occurrence.</param>
    public PullLoop(string name, ulong target, Action<ulong, uint> onRequest, Action<ZeroEvent> onEvent)
    {
        _target = target;
        _onRequest = onRequest;
        _onEvent = onEvent;
        _thread = new Thread(Run) { IsBackground = true, Name = name };
    }

    /// <summary>Gets the status the last poll returned once the loop ended.</summary>
    public ZeroStatus Exit { get; private set; } = ZeroStatus.Ok;

    /// <summary>Gets the failures of the loop itself, which the run asserts are none.</summary>
    public ConcurrentQueue<string> Faults { get; } = new();

    /// <summary>Gets the exceptions handlers threw, each answered 500.</summary>
    public ConcurrentQueue<Exception> Thrown { get; } = new();

    /// <summary>Gets the batches the loop acknowledged.</summary>
    public long Batches => Interlocked.Read(ref _batches);

    /// <summary>
    /// Gets whether the loop is inside <c>zero_target_poll</c> and, on Linux, its thread is
    /// asleep there.
    /// </summary>
    public bool BlockedInPoll => _polling && (!OperatingSystem.IsLinux() || OsThreadState() == 'S');

    /// <summary>Starts the loop's thread.</summary>
    public void Start() => _thread.Start();

    /// <summary>Waits for the loop to end.</summary>
    /// <returns>Whether it ended within the run's patience.</returns>
    public bool Join() => _thread.Join(Check.Patience);

    /// <summary>Fails when the loop recorded a failure of its own.</summary>
    /// <param name="what">The step that ran.</param>
    public void AssertSound(string what) =>
        Check.That(Faults.IsEmpty, $"{what}: the pull loop failed: {string.Join("; ", Faults)}");

    private void Run()
    {
        if (OperatingSystem.IsLinux())
        {
            string? task = new FileInfo("/proc/thread-self").LinkTarget;
            _osThread = task is null ? 0 : int.Parse(task[(task.LastIndexOf('/') + 1)..]);
        }

        ulong* slots = stackalloc ulong[Native.MaxBatch];
        uint* routes = stackalloc uint[Native.MaxBatch];
        ZeroEvent* events = stackalloc ZeroEvent[Native.MaxBatch];
        ZeroStatus* results = stackalloc ZeroStatus[Native.MaxBatch];
        while (true)
        {
            ZeroBatch batch = default;
            batch.size = (uint)sizeof(ZeroBatch);
            _polling = true;
            ZeroStatus status = NativeMethods.zero_target_poll(
                _target, Native.None, &batch, slots, routes, events, (nuint)sizeof(ZeroEvent), Native.MaxBatch);
            _polling = false;
            if (status == ZeroStatus.Timeout)
            {
                continue;
            }

            if (status != ZeroStatus.Ok)
            {
                if (status != ZeroStatus.Closed)
                {
                    Faults.Enqueue($"zero_target_poll: {status}: {Status.LastError()}");
                }

                Exit = status;
                return;
            }

            if (batch.kind == Native.BatchRequests)
            {
                for (int i = 0; i < batch.count; i++)
                {
                    Answer(slots[i], routes[i]);
                }

                ZeroStatus done = NativeMethods.zero_batch_complete(batch.worker, slots, batch.count, batch.epoch, results);
                if (done != ZeroStatus.Ok)
                {
                    Faults.Enqueue($"zero_batch_complete: {done}: {Status.LastError()}");
                }

                for (int i = 0; i < batch.count; i++)
                {
                    if (results[i] != ZeroStatus.Ok)
                    {
                        Faults.Enqueue($"zero_batch_complete refused slot {slots[i]}: {results[i]}");
                    }
                }
            }
            else
            {
                for (int i = 0; i < batch.count; i++)
                {
                    try
                    {
                        _onEvent(events[i]);
                    }
                    catch (Exception error)
                    {
                        Faults.Enqueue($"event {events[i].kind}: {error.Message}");
                    }
                }

                ZeroStatus done = NativeMethods.zero_batch_complete(batch.worker, null, 0, batch.epoch, null);
                if (done != ZeroStatus.Ok)
                {
                    Faults.Enqueue($"zero_batch_complete of an event batch: {done}: {Status.LastError()}");
                }
            }

            Interlocked.Increment(ref _batches);
        }
    }

    private void Answer(ulong slot, uint route)
    {
        try
        {
            _onRequest(slot, route);
        }
        catch (Exception error)
        {
            Thrown.Enqueue(error);
            byte[] code = "HANDLER_FAILED"u8.ToArray();
            byte[] message = Encoding.UTF8.GetBytes(error.Message);
            ZeroStatus status;
            fixed (byte* codePtr = code)
            fixed (byte* messagePtr = message)
            {
                status = NativeMethods.zero_res_error(slot, 500, codePtr, (nuint)code.Length, messagePtr, (nuint)message.Length, null, 0);
            }

            if (status != ZeroStatus.Ok)
            {
                Faults.Enqueue($"zero_res_error after {error.Message}: {status}: {Status.LastError()}");
            }
        }
    }

    private char OsThreadState()
    {
        int task = _osThread;
        if (task == 0)
        {
            return '?';
        }

        string stat = File.ReadAllText($"/proc/self/task/{task}/stat");
        int end = stat.LastIndexOf(')');
        return end >= 0 && end + 2 < stat.Length ? stat[end + 2] : '?';
    }
}
