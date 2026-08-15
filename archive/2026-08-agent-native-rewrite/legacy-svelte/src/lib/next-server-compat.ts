export type NextRequest = Request & { nextUrl: URL };

export class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit) {
    return Response.json(body, init);
  }

  static redirect(url: string | URL, init: number | ResponseInit = 307) {
    return Response.redirect(url, typeof init === 'number' ? init : init.status ?? 307);
  }

  static next(init?: ResponseInit) {
    return new Response(null, init);
  }
}
