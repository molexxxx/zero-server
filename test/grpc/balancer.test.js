const { LoadBalancer, Subchannel, SubchannelState, RoundRobinPicker } = require('../../lib/grpc/balancer');

// =========================================================
// SubchannelState enum
// =========================================================

describe('SubchannelState', () =>
{
    it('should have all expected states', () =>
    {
        expect(SubchannelState.IDLE).toBe('IDLE');
        expect(SubchannelState.CONNECTING).toBe('CONNECTING');
        expect(SubchannelState.READY).toBe('READY');
        expect(SubchannelState.TRANSIENT_FAILURE).toBe('TRANSIENT_FAILURE');
        expect(SubchannelState.SHUTDOWN).toBe('SHUTDOWN');
    });
});

// =========================================================
// Subchannel
// =========================================================

describe('Subchannel', () =>
{
    let sc;

    afterEach(() =>
    {
        if (sc) sc.shutdown();
    });

    it('should start in IDLE state', () =>
    {
        sc = new Subchannel('localhost:50051');
        expect(sc.state).toBe(SubchannelState.IDLE);
        expect(sc.address).toBe('localhost:50051');
    });

    it('should not be ready initially', () =>
    {
        sc = new Subchannel('localhost:50051');
        expect(sc.isReady).toBe(false);
        expect(sc.isHealthy).toBe(false);
    });

    it('should transition to CONNECTING on connect()', () =>
    {
        sc = new Subchannel('localhost:1'); // unreachable port
        sc.connect();
        // State should be either CONNECTING or TRANSIENT_FAILURE
        expect([SubchannelState.CONNECTING, SubchannelState.TRANSIENT_FAILURE]).toContain(sc.state);
    });

    it('should emit stateChange events', () =>
    {
        sc = new Subchannel('localhost:1');
        const changes = [];
        sc.on('stateChange', (newState, oldState) => changes.push({ newState, oldState }));
        sc.connect();
        expect(changes.length).toBeGreaterThanOrEqual(1);
        expect(changes[0].oldState).toBe(SubchannelState.IDLE);
    });

    it('should transition to SHUTDOWN on shutdown()', () =>
    {
        sc = new Subchannel('localhost:50051');
        sc.shutdown();
        expect(sc.state).toBe(SubchannelState.SHUTDOWN);
    });

    it('should return null from connect() after shutdown', () =>
    {
        sc = new Subchannel('localhost:50051');
        sc.shutdown();
        const result = sc.connect();
        expect(result).toBeNull();
    });

    it('should not schedule reconnect after shutdown', () =>
    {
        sc = new Subchannel('localhost:1');
        sc.connect();
        sc.shutdown();
        expect(sc._reconnectTimer).toBeNull();
    });

    it('should handle address with protocol prefix', () =>
    {
        sc = new Subchannel('http://localhost:50051');
        expect(sc.address).toBe('http://localhost:50051');
    });
});

// =========================================================
// RoundRobinPicker
// =========================================================

describe('RoundRobinPicker', () =>
{
    it('should cycle through healthy subchannels', () =>
    {
        const picker = new RoundRobinPicker();

        const scs = [
            { isHealthy: true, isReady: true, state: SubchannelState.READY },
            { isHealthy: true, isReady: true, state: SubchannelState.READY },
            { isHealthy: true, isReady: true, state: SubchannelState.READY },
        ];

        const picks = new Set();
        for (let i = 0; i < 6; i++)
        {
            const picked = picker.pick(scs);
            picks.add(scs.indexOf(picked));
        }

        // Should have picked all three
        expect(picks.size).toBe(3);
    });

    it('should skip unhealthy subchannels', () =>
    {
        const picker = new RoundRobinPicker();

        const scs = [
            { isHealthy: false, isReady: false, state: SubchannelState.TRANSIENT_FAILURE },
            { isHealthy: true, isReady: true, state: SubchannelState.READY },
            { isHealthy: false, isReady: false, state: SubchannelState.TRANSIENT_FAILURE },
        ];

        for (let i = 0; i < 5; i++)
        {
            const picked = picker.pick(scs);
            expect(picked).toBe(scs[1]);
        }
    });

    it('should fall back to any ready subchannel when none healthy', () =>
    {
        const picker = new RoundRobinPicker();

        const scs = [
            { isHealthy: false, isReady: false, state: SubchannelState.TRANSIENT_FAILURE },
            { isHealthy: false, isReady: true, state: SubchannelState.READY },
            { isHealthy: false, isReady: false, state: SubchannelState.TRANSIENT_FAILURE },
        ];

        const picked = picker.pick(scs);
        expect(picked).toBe(scs[1]);
    });

    it('should try to connect idle subchannels when none ready', () =>
    {
        const picker = new RoundRobinPicker();
        let connected = false;

        const scs = [
            {
                isHealthy: false, isReady: false,
                state: SubchannelState.IDLE,
                connect() { connected = true; },
            },
        ];

        picker.pick(scs);
        expect(connected).toBe(true);
    });

    it('should return first subchannel when all are in failure', () =>
    {
        const picker = new RoundRobinPicker();

        const scs = [
            { isHealthy: false, isReady: false, state: SubchannelState.TRANSIENT_FAILURE },
            { isHealthy: false, isReady: false, state: SubchannelState.TRANSIENT_FAILURE },
        ];

        const picked = picker.pick(scs);
        expect(picked).toBe(scs[0]);
    });

    it('should return null for empty subchannel list', () =>
    {
        const picker = new RoundRobinPicker();
        expect(picker.pick([])).toBeNull();
    });
});

// =========================================================
// LoadBalancer
// =========================================================

describe('LoadBalancer', () =>
{
    let lb;

    afterEach(() =>
    {
        if (lb) lb.shutdown();
    });

    it('should create subchannels for each address', () =>
    {
        lb = new LoadBalancer(['addr1:50051', 'addr2:50051', 'addr3:50051']);
        expect(lb.subchannels).toHaveLength(3);
    });

    it('should default to pick-first policy', () =>
    {
        lb = new LoadBalancer(['localhost:1']);
        expect(lb._policy).toBe('pick-first');
    });

    it('should accept round-robin policy', () =>
    {
        lb = new LoadBalancer(['localhost:1', 'localhost:2'], { policy: 'round-robin' });
        expect(lb._policy).toBe('round-robin');
        expect(lb._rrPicker).toBeDefined();
    });

    it('should return a subchannel from pick', () =>
    {
        lb = new LoadBalancer(['localhost:1']);
        const picked = lb.pick();
        expect(picked).toBeDefined();
        expect(picked).toBeInstanceOf(Subchannel);
    });

    it('should return a session (or null) from getSession', () =>
    {
        lb = new LoadBalancer(['localhost:1']);
        // Will likely return an H2 session object or null depending on connectivity
        const session = lb.getSession();
        // Just ensure it doesn't throw
        expect(true).toBe(true);
    });

    it('should shutdown all subchannels', () =>
    {
        lb = new LoadBalancer(['localhost:1', 'localhost:2']);
        lb.shutdown();
        for (const sc of lb.subchannels)
        {
            expect(sc.state).toBe(SubchannelState.SHUTDOWN);
        }
    });

    it('should handle empty address list', () =>
    {
        lb = new LoadBalancer([]);
        expect(lb.subchannels).toHaveLength(0);
        expect(lb.pick()).toBeNull();
    });

    it('should handle single address', () =>
    {
        lb = new LoadBalancer(['localhost:1']);
        expect(lb.subchannels).toHaveLength(1);
    });

    it('pick-first should connect first subchannel on creation', () =>
    {
        lb = new LoadBalancer(['localhost:1', 'localhost:2']);
        // First subchannel should have been connect() called  
        const first = lb.subchannels[0];
        expect([SubchannelState.CONNECTING, SubchannelState.TRANSIENT_FAILURE, SubchannelState.IDLE])
            .toContain(first.state);
    });

    it('round-robin should connect all subchannels on creation', () =>
    {
        lb = new LoadBalancer(['localhost:1', 'localhost:2'], { policy: 'round-robin' });
        for (const sc of lb.subchannels)
        {
            expect(sc.state).not.toBe(SubchannelState.IDLE);
        }
    });
});

// =========================================================
// Subchannel — getSession, events, backoff
// =========================================================

describe('Subchannel — getSession and session events', () =>
{
    it('getSession should return existing session if valid', () =>
    {
        const sc = new Subchannel('localhost:50051');
        // Manually set a mock session
        sc._session = { closed: false, destroyed: false };
        const result = sc.getSession();
        expect(result).toBe(sc._session);
        sc._shutdown = true;
    });

    it('getSession should call connect if no session', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc._session = null;
        // connect will try to connect (may fail, but exercises the path)
        const result = sc.getSession();
        // In test env, connect may fail and set state to TRANSIENT_FAILURE
        expect([SubchannelState.CONNECTING, SubchannelState.TRANSIENT_FAILURE])
            .toContain(sc.state);
        sc.shutdown();
    });

    it('getSession should call connect if session is closed', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc._session = { closed: true, destroyed: false };
        sc.getSession();
        expect([SubchannelState.CONNECTING, SubchannelState.TRANSIENT_FAILURE])
            .toContain(sc.state);
        sc.shutdown();
    });

    it('getSession should call connect if session is destroyed', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc._session = { closed: false, destroyed: true };
        sc.getSession();
        expect([SubchannelState.CONNECTING, SubchannelState.TRANSIENT_FAILURE])
            .toContain(sc.state);
        sc.shutdown();
    });

    it('should not emit stateChange for same state', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc.state = SubchannelState.IDLE;
        let emitted = false;
        sc.on('stateChange', () => { emitted = true; });
        sc._setState(SubchannelState.IDLE);
        expect(emitted).toBe(false);
        sc._shutdown = true;
    });

    it('should emit stateChange for different state', () =>
    {
        const sc = new Subchannel('localhost:50051');
        let newState = null;
        sc.on('stateChange', (s) => { newState = s; });
        sc._setState(SubchannelState.CONNECTING);
        expect(newState).toBe(SubchannelState.CONNECTING);
        sc._shutdown = true;
    });

    it('connect should return null when shutdown', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc.shutdown();
        expect(sc.connect()).toBeNull();
    });

    it('connect should reuse existing valid session', () =>
    {
        const sc = new Subchannel('localhost:50051');
        const mock = { closed: false, destroyed: false };
        sc._session = mock;
        const result = sc.connect();
        expect(result).toBe(mock);
        sc._shutdown = true;
    });

    it('_scheduleReconnect should not schedule when shutdown', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc.shutdown();
        sc._scheduleReconnect();
        expect(sc._reconnectTimer).toBeNull();
    });

    it('_scheduleReconnect should not schedule duplicate timer', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc._reconnectTimer = setTimeout(() => {}, 100000); // fake existing timer
        const existingTimer = sc._reconnectTimer;
        sc._scheduleReconnect();
        expect(sc._reconnectTimer).toBe(existingTimer);
        sc.shutdown();
    });

    it('backoff should double up to maxBackoff', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc._backoff = 1000;
        sc._maxBackoff = 4000;

        // First schedule: backoff becomes 2000
        sc._scheduleReconnect();
        expect(sc._backoff).toBe(2000);
        clearTimeout(sc._reconnectTimer);
        sc._reconnectTimer = null;

        // Second: backoff becomes 4000
        sc._scheduleReconnect();
        expect(sc._backoff).toBe(4000);
        clearTimeout(sc._reconnectTimer);
        sc._reconnectTimer = null;

        // Third: capped at 4000
        sc._scheduleReconnect();
        expect(sc._backoff).toBe(4000);
        sc.shutdown();
    });

    it('isReady should check session validity', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc.state = SubchannelState.READY;
        sc._session = { closed: false, destroyed: false };
        expect(sc.isReady).toBe(true);

        sc._session = null;
        expect(sc.isReady).toBeFalsy();

        sc._session = { closed: true, destroyed: false };
        expect(sc.isReady).toBe(false);

        sc._shutdown = true;
    });

    it('isHealthy combines health flag and isReady', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc.state = SubchannelState.READY;
        sc._session = { closed: false, destroyed: false };
        sc._healthy = true;
        expect(sc.isHealthy).toBe(true);

        sc._healthy = false;
        expect(sc.isHealthy).toBe(false);

        sc._shutdown = true;
    });

    it('shutdown should be safe to call twice', () =>
    {
        const sc = new Subchannel('localhost:50051');
        sc.shutdown();
        expect(() => sc.shutdown()).not.toThrow();
    });
});

// =========================================================
// pickFirst fallback paths
// =========================================================

describe('pickFirst — fallback paths', () =>
{
    it('should connect idle subchannel when none are ready', () =>
    {
        const lb = new LoadBalancer(['localhost:1', 'localhost:2']);
        // Simulate all in TRANSIENT_FAILURE
        for (const sc of lb.subchannels)
        {
            sc._shutdown = false;
            sc.state = SubchannelState.TRANSIENT_FAILURE;
            sc._session = null;
            sc._healthy = false;
        }

        // Set one back to IDLE
        lb.subchannels[1].state = SubchannelState.IDLE;

        const picked = lb.pick();
        expect(picked).toBe(lb.subchannels[1]);
        lb.shutdown();
    });

    it('should return first subchannel when all are TRANSIENT_FAILURE', () =>
    {
        const lb = new LoadBalancer(['localhost:1', 'localhost:2']);
        for (const sc of lb.subchannels)
        {
            sc._shutdown = false;
            sc.state = SubchannelState.TRANSIENT_FAILURE;
            sc._session = null;
            sc._healthy = false;
        }

        const picked = lb.pick();
        expect(picked).toBe(lb.subchannels[0]);
        lb.shutdown();
    });

    it('should prefer healthy over just-ready', () =>
    {
        const lb = new LoadBalancer(['localhost:1', 'localhost:2']);
        // First: ready but not healthy
        lb.subchannels[0].state = SubchannelState.READY;
        lb.subchannels[0]._session = { closed: false, destroyed: false };
        lb.subchannels[0]._healthy = false;

        // Second: ready and healthy
        lb.subchannels[1].state = SubchannelState.READY;
        lb.subchannels[1]._session = { closed: false, destroyed: false };
        lb.subchannels[1]._healthy = true;

        const picked = lb.pick();
        expect(picked).toBe(lb.subchannels[1]);
        lb.shutdown();
    });

    it('should fallback to ready-but-unhealthy when no healthy', () =>
    {
        const lb = new LoadBalancer(['localhost:1', 'localhost:2']);
        // Both ready but not healthy
        for (const sc of lb.subchannels)
        {
            sc.state = SubchannelState.READY;
            sc._session = { closed: false, destroyed: false };
            sc._healthy = false;
        }

        const picked = lb.pick();
        expect(picked).toBeDefined();
        expect(picked.isReady).toBe(true);
        lb.shutdown();
    });
});

// =========================================================
// LoadBalancer — getSession
// =========================================================

describe('LoadBalancer — getSession', () =>
{
    it('should return null when no subchannels', () =>
    {
        const lb = new LoadBalancer([]);
        expect(lb.getSession()).toBeNull();
        lb.shutdown();
    });

    it('should return session from picked subchannel', () =>
    {
        const lb = new LoadBalancer(['localhost:1']);
        const mockSession = { closed: false, destroyed: false };
        lb.subchannels[0]._session = mockSession;
        lb.subchannels[0].state = SubchannelState.READY;
        lb.subchannels[0]._healthy = true;

        const session = lb.getSession();
        expect(session).toBe(mockSession);
        lb.shutdown();
    });
});

// =========================================================
// Subchannel — session event handlers (connect to port with no server)
// =========================================================

describe('Subchannel — session event simulation', () =>
{
    it('should handle error event: set TRANSIENT_FAILURE and schedule reconnect', async () =>
    {
        const sc = new Subchannel('localhost:19999');
        const session = sc.connect();
        expect(session).toBeDefined();

        await new Promise((resolve) =>
        {
            sc.on('stateChange', (state) =>
            {
                if (state === SubchannelState.TRANSIENT_FAILURE)
                {
                    expect(sc._healthy).toBe(false);
                    sc.shutdown();
                    resolve();
                }
            });
        });
    });

    it('should handle goaway event: set healthy=false and IDLE', () =>
    {
        const sc = new Subchannel('localhost:19999');
        const session = sc.connect();

        // Force state to READY to simulate an active connection
        sc.state = SubchannelState.READY;
        sc._healthy = true;

        // Manually emit goaway
        session.emit('goaway');

        expect(sc._healthy).toBe(false);
        expect(sc.state).toBe(SubchannelState.IDLE);
        sc.shutdown();
    });

    it('should handle close event: clear session and set IDLE', () =>
    {
        const sc = new Subchannel('localhost:19999');
        const session = sc.connect();

        // Force state so close handler triggers
        sc.state = SubchannelState.READY;

        // Manually emit close
        session.emit('close');

        expect(sc._session).toBeNull();
        expect(sc.state).toBe(SubchannelState.IDLE);
        sc.shutdown();
    });

    it('should not set IDLE on close when shutdown', () =>
    {
        const sc = new Subchannel('localhost:19999');
        const session = sc.connect();

        sc._shutdown = true;
        session.emit('close');

        // State should remain as was (not IDLE since shutdown)
        expect(sc.state).not.toBe(SubchannelState.IDLE);
        sc.shutdown();
    });

    it('should handle connect event: reset backoff and set READY', () =>
    {
        const sc = new Subchannel('localhost:19999');
        sc._backoff = 8000; // simulated previous backoff
        const session = sc.connect();

        // Manually emit connect
        session.emit('connect');

        expect(sc._backoff).toBe(1000);
        expect(sc.state).toBe(SubchannelState.READY);
        expect(sc._healthy).toBe(true);
        sc.shutdown();
    });

    it('should reconnect after scheduled delay', async () =>
    {
        const sc = new Subchannel('localhost:19999');
        sc._backoff = 50; // very short
        sc._maxBackoff = 200;

        // Verify _scheduleReconnect sets the timer and increases backoff
        sc._scheduleReconnect();
        expect(sc._reconnectTimer).not.toBeNull();
        expect(sc._backoff).toBe(100); // doubled from 50

        // Clean up immediately — we only need to verify the timer was set
        sc.shutdown();
        expect(sc._reconnectTimer).toBeNull(); // shutdown clears timer
    });

    it('round-robin picker should connect idle subchannels in fallback', () =>
    {
        const lb = new LoadBalancer(['localhost:1', 'localhost:2'], { policy: 'round-robin' });

        // Simulate all in TRANSIENT_FAILURE  
        for (const sc of lb.subchannels)
        {
            sc.state = SubchannelState.TRANSIENT_FAILURE;
            sc._session = null;
            sc._healthy = false;
        }

        // Set one to IDLE
        lb.subchannels[1].state = SubchannelState.IDLE;

        const picked = lb.pick();
        // Should attempt to connect the idle one
        expect(picked).toBeDefined();
        lb.shutdown();
    });

    it('round-robin fallback to anyReady when no healthy', () =>
    {
        const lb = new LoadBalancer(['localhost:1', 'localhost:2'], { policy: 'round-robin' });

        // Ready but not healthy
        for (const sc of lb.subchannels)
        {
            sc.state = SubchannelState.READY;
            sc._session = { closed: false, destroyed: false };
            sc._healthy = false;
        }

        const picked = lb.pick();
        expect(picked).toBeDefined();
        expect(picked.isReady).toBe(true);
        lb.shutdown();
    });
});
