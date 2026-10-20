export type RouteHandler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
/* * [method, path pattern relative to /api, handler]. `:name` segments become params. */
export type Route = [method: string, pattern: string, handler: RouteHandler];
