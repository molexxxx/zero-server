/**
 * @module ws/room
 * @description WebSocket room/channel manager.
 *              Provides broadcast, room-based messaging, and connection
 *              registry for WebSocket connections.
 */

/**
 * Manages a pool of WebSocket connections with room-based grouping.
 *
 * @example
 *   const pool = new WebSocketPool();
 *   app.ws('/chat', (ws, req) => {
 *       pool.add(ws);
 *       pool.join(ws, 'general');
 *       ws.on('message', msg => pool.toRoom('general', msg));
 *       ws.on('close', () => pool.remove(ws));
 *   });
 */
class WebSocketPool
{
    /** @constructor */
    constructor()
    {
        /** @type {Set<import('./connection')>} All active connections. */
        this._connections = new Set();
        /** @type {Map<string, Set<import('./connection')>>} Room → connection sets. */
        this._rooms = new Map();
    }

    /**
     * Add a connection to the pool.
     * @param {import('./connection')} ws - WebSocket connection.
     * @returns {WebSocketPool} this
     */
    add(ws)
    {
        this._connections.add(ws);

        // Auto-remove on close
        ws.once('close', () => this.remove(ws));

        return this;
    }

    /**
     * Remove a connection from the pool and all rooms.
     * @param {import('./connection')} ws - WebSocket connection.
     * @returns {WebSocketPool} this
     */
    remove(ws)
    {
        this._connections.delete(ws);
        for (const [room, members] of this._rooms)
        {
            members.delete(ws);
            if (members.size === 0) this._rooms.delete(room);
        }
        return this;
    }

    /**
     * Join a connection to a room.
     * @param {import('./connection')} ws - WebSocket connection.
     * @param {string} room - Room name.
     * @returns {WebSocketPool} this
     */
    join(ws, room)
    {
        if (!this._rooms.has(room)) this._rooms.set(room, new Set());
        this._rooms.get(room).add(ws);
        return this;
    }

    /**
     * Remove a connection from a room.
     * @param {import('./connection')} ws - WebSocket connection.
     * @param {string} room - Room name.
     * @returns {WebSocketPool} this
     */
    leave(ws, room)
    {
        const members = this._rooms.get(room);
        if (members)
        {
            members.delete(ws);
            if (members.size === 0) this._rooms.delete(room);
        }
        return this;
    }

    /**
     * Get all rooms a connection belongs to.
     * @param {import('./connection')} ws - WebSocket connection.
     * @returns {string[]} Room names the connection belongs to.
     */
    roomsOf(ws)
    {
        const result = [];
        for (const [room, members] of this._rooms)
        {
            if (members.has(ws)) result.push(room);
        }
        return result;
    }

    /**
     * Broadcast a message to ALL connected clients.
     * @param {string|Buffer} data   - Payload.
     * @param {import('./connection')} [exclude] - Optional connection to exclude (e.g. the sender).
     */
    broadcast(data, exclude)
    {
        for (const ws of this._connections)
        {
            if (ws !== exclude && ws.readyState === 1) ws.send(data);
        }
    }

    /**
     * Broadcast a JSON message to ALL connected clients.
     * @param {*} obj - Value to serialise.
     * @param {import('./connection')} [exclude] - Connection(s) to exclude.
     */
    broadcastJSON(obj, exclude)
    {
        const msg = JSON.stringify(obj);
        this.broadcast(msg, exclude);
    }

    /**
     * Send a message to all connections in a specific room.
     * @param {string} room          - Room name.
     * @param {string|Buffer} data   - Payload.
     * @param {import('./connection')} [exclude] - Connection(s) to exclude.
     */
    toRoom(room, data, exclude)
    {
        const members = this._rooms.get(room);
        if (!members) return;
        for (const ws of members)
        {
            if (ws !== exclude && ws.readyState === 1) ws.send(data);
        }
    }

    /**
     * Send a JSON message to all connections in a specific room.
     * @param {string} room - Room name.
     * @param {*}      obj - Data object to send.
     * @param {import('./connection')} [exclude] - Connection(s) to exclude.
     */
    toRoomJSON(room, obj, exclude)
    {
        this.toRoom(room, JSON.stringify(obj), exclude);
    }

    /**
     * Get all connections in a room.
     * @param {string} room - Room name.
     * @returns {import('./connection')[]} Connections in the room (empty array if the room does not exist).
     */
    in(room)
    {
        const members = this._rooms.get(room);
        return members ? Array.from(members) : [];
    }

    /**
     * Total number of active connections.
     * @type {number}
     */
    get size()
    {
        return this._connections.size;
    }

    /**
     * Number of connections in a specific room.
     * @param {string} room - Room name.
     * @returns {number} Number of connections in the room.
     */
    roomSize(room)
    {
        const members = this._rooms.get(room);
        return members ? members.size : 0;
    }

    /**
     * List all active room names.
     * @returns {string[]} Array of room names.
     */
    get rooms()
    {
        return Array.from(this._rooms.keys());
    }

    /**
     * Get all active connections.
     * @returns {import('./connection')[]} Array of connections in the pool.
     */
    get clients()
    {
        return Array.from(this._connections);
    }

    /**
     * Close all connections gracefully.
     * @param {number} [code=1001] - Close code.
     * @param {string} [reason]    - Close reason.
     */
    closeAll(code = 1001, reason = 'Server shutdown')
    {
        for (const ws of this._connections)
        {
            ws.close(code, reason);
        }
        this._connections.clear();
        this._rooms.clear();
    }
}

module.exports = WebSocketPool;
