/// <reference types="node" />

import { Worker } from 'cluster';

export interface ClusterOptions {
    /** Number of worker processes (default: CPU count). */
    workers?: number;
    /** Automatically respawn crashed workers (default: true). */
    respawn?: boolean;
    /** Initial delay (ms) before respawning (default: 1000). */
    respawnDelay?: number;
    /** Maximum respawn delay after backoff (default: 30000). */
    maxRespawnDelay?: number;
    /** Multiplier for exponential backoff (default: 2). */
    backoffFactor?: number;
}

export declare class ClusterManager {
    constructor(opts?: ClusterOptions);

    /** Whether this is the primary (master) process. */
    readonly isPrimary: boolean;

    /** Whether this is a worker process. */
    readonly isWorker: boolean;

    /** Configured number of workers. */
    readonly workerCount: number;

    /** IDs of currently active workers. */
    readonly workerIds: number[];

    /** Number of currently alive workers. */
    readonly activeWorkers: number;

    /** Fork all worker processes. */
    fork(): ClusterManager;

    /** Broadcast a typed message to all workers. */
    broadcast(type: string, data: any): void;

    /** Send a typed message to a specific worker. */
    sendTo(workerId: number, type: string, data: any): void;

    /** Send a typed message from a worker to the primary. */
    sendToPrimary(type: string, data: any): void;

    /** Register a handler for a typed IPC message. */
    onMessage(type: string, fn: (data: any, worker?: Worker) => void): ClusterManager;

    /** Perform a rolling restart of all workers. */
    reload(): Promise<void>;

    /** Shut down the entire cluster gracefully. */
    shutdown(opts?: { timeout?: number }): Promise<void>;

    /** Enable automatic per-worker metrics aggregation. */
    enableMetrics(registry: import('./observe').MetricsRegistry, opts?: { interval?: number }): ClusterManager;

    /** Stop the per-worker metrics reporting timer. */
    disableMetrics(): void;

    /** Enable sticky sessions by hashing client IPs to workers. */
    enableSticky(server: import('http').Server | import('https').Server, opts?: {
        hash?: (ip: string, workerCount: number) => number;
    }): ClusterManager;
}

/**
 * High-level clustering helper.
 */
export declare function cluster(
    workerFn: (mgr: ClusterManager) => void,
    opts?: ClusterOptions
): ClusterManager;
