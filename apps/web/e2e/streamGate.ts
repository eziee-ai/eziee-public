import type { Page } from "@playwright/test";

/**
 * Holds the page's first chat reply at two points, so a test can see the in-between states the scripted model
 * otherwise streams straight through: before its first byte (the request is pending), and right after its first
 * text arrives (the reply is streaming). Each `releaseChatStream` lets it past the next point. Nothing on the
 * server changes; the page's own fetch is wrapped, and every other request passes untouched.
 */
export async function holdChatStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let allowed = 0;
    const waiting: Array<{ stage: number; go: () => void }> = [];
    const until = (stage: number) => (allowed >= stage ? Promise.resolve() : new Promise<void>((go) => waiting.push({ stage, go })));
    (window as unknown as { __chatGate: { release: () => void } }).__chatGate = {
      release() {
        allowed += 1;
        for (const waiter of waiting.splice(0)) {
          if (waiter.stage <= allowed) waiter.go();
          else waiting.push(waiter);
        }
      },
    };

    let gated = false;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (gated || init?.method !== "POST" || new URL(url, location.href).pathname !== "/api/chat" || !response.ok || !response.body) return response;
      gated = true;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          await until(1);
          let buffer = "";
          let sawText = false;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Split on server-sent-event boundaries, not network reads: the whole reply may arrive in one read.
            for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
              const event = buffer.slice(0, end + 2);
              buffer = buffer.slice(end + 2);
              controller.enqueue(encoder.encode(event));
              if (!sawText && event.includes('"type":"text-delta"')) {
                sawText = true;
                await until(2);
              }
            }
          }
          if (buffer) controller.enqueue(encoder.encode(buffer));
          controller.close();
        },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  });
}

export async function releaseChatStream(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __chatGate: { release: () => void } }).__chatGate.release());
}
