import { Request } from './request';
import { Response } from './response';
import { MiddlewareFunction, NextFunction } from './middleware';

export interface RouteOptions {
    /** When `true`, route matches only HTTPS; when `false`, only HTTP. */
    secure?: boolean;
}

export type RouteHandler = (req: Request, res: Response, next?: NextFunction) => void | Promise<void>;

export interface RouteEntry {
    method: string;
    path: string;
    regex: RegExp;
    keys: string[];
    handlers: RouteHandler[];
    secure?: boolean;
}

export interface RouteInfo {
    method: string;
    path: string;
    secure?: boolean;
    maxPayload?: number;
    pingInterval?: number;
}

export interface RouteChain {
    get(...handlers: (RouteOptions | RouteHandler)[]): RouteChain;
    post(...handlers: (RouteOptions | RouteHandler)[]): RouteChain;
    put(...handlers: (RouteOptions | RouteHandler)[]): RouteChain;
    delete(...handlers: (RouteOptions | RouteHandler)[]): RouteChain;
    patch(...handlers: (RouteOptions | RouteHandler)[]): RouteChain;
    options(...handlers: (RouteOptions | RouteHandler)[]): RouteChain;
    head(...handlers: (RouteOptions | RouteHandler)[]): RouteChain;
    all(...handlers: (RouteOptions | RouteHandler)[]): RouteChain;
}

export interface RouterInstance {
    /** Registered routes. */
    routes: RouteEntry[];

    /**
     * Register a route.
     */
    add(method: string, path: string, handlers: RouteHandler[], options?: RouteOptions): void;

    /**
     * Mount a child router under a path prefix.
     */
    use(prefix: string, router: RouterInstance): void;

    /**
     * Match and handle request.
     */
    handle(req: Request, res: Response): void;

    /**
     * Chainable route builder.
     */
    route(path: string): RouteChain;

    /**
     * Return a flat list of all registered routes.
     */
    inspect(prefix?: string): RouteInfo[];

    // HTTP method shortcuts
    get(path: string, ...handlers: (RouteOptions | RouteHandler)[]): RouterInstance;
    post(path: string, ...handlers: (RouteOptions | RouteHandler)[]): RouterInstance;
    put(path: string, ...handlers: (RouteOptions | RouteHandler)[]): RouterInstance;
    delete(path: string, ...handlers: (RouteOptions | RouteHandler)[]): RouterInstance;
    patch(path: string, ...handlers: (RouteOptions | RouteHandler)[]): RouterInstance;
    options(path: string, ...handlers: (RouteOptions | RouteHandler)[]): RouterInstance;
    head(path: string, ...handlers: (RouteOptions | RouteHandler)[]): RouterInstance;
    all(path: string, ...handlers: (RouteOptions | RouteHandler)[]): RouterInstance;
}
