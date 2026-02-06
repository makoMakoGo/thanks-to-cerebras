type Handler = (
  req: Request,
  params: Record<string, string>,
) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, pathname: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new URLPattern({ pathname }),
      handler,
    });
    return this;
  }

  get(pathname: string, handler: Handler): this {
    return this.on("GET", pathname, handler);
  }

  post(pathname: string, handler: Handler): this {
    return this.on("POST", pathname, handler);
  }

  put(pathname: string, handler: Handler): this {
    return this.on("PUT", pathname, handler);
  }

  patch(pathname: string, handler: Handler): this {
    return this.on("PATCH", pathname, handler);
  }

  delete(pathname: string, handler: Handler): this {
    return this.on("DELETE", pathname, handler);
  }

  match(
    method: string,
    url: string,
  ): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const result = route.pattern.exec(url);
      if (result) {
        const groups = result.pathname.groups as Record<string, string>;
        return { handler: route.handler, params: groups };
      }
    }
    return null;
  }
}
