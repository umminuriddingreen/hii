import { getTerminalSnapshot, localTerminalAllowed } from '@/lib/server/hii-terminal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!localTerminalAllowed(request)) {
    return new Response('HII terminal stream is local-only.', { status: 403 });
  }

  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | null = null;

  const stream = new ReadableStream({
    start(controller) {
      async function sendSnapshot() {
        try {
          const snapshot = await getTerminalSnapshot();
          controller.enqueue(
            encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
          );
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                message: error instanceof Error ? error.message : 'Snapshot failed.'
              })}\n\n`
            )
          );
        }
      }

      void sendSnapshot();
      timer = setInterval(sendSnapshot, 3000);

      request.signal.addEventListener('abort', () => {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          // The stream may already be closed by the client.
        }
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  });
}
