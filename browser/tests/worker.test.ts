// SPDX-License-Identifier: LicenseRef-BSL-1.1

//! Proves browser mechanics against a deterministic local reality fixture.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { ProtocolFailure } from "../src/protocol.js";
import { BrowserWorker } from "../src/worker.js";

let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/items") {
      html(response, `
        <title>Items</title>
        <main>
          <h1>Available items</h1>
          <button aria-label="Open Alpha details | $12.00 | available" onclick="location.href='/details/alpha'">Alpha</button>
          <button aria-label="Open Beta details | $8.00 | available" onclick="location.href='/details/beta'">Beta</button>
          <button aria-label="Open Gamma details | $5.00 | unavailable" disabled>Gamma</button>
        </main>`);
      return;
    }
    if (path === "/stale") {
      html(response, `
        <title>Changing items</title>
        <main><button id="target" aria-label="Open Alpha details | $9.00 | available" onclick="location.href='/details/alpha'">Alpha</button></main>
        <script>setTimeout(() => document.querySelector('#target').setAttribute('aria-label', 'Open Beta details | $7.00 | available'), 100)</script>`);
      return;
    }
    if (path === "/network") {
      html(response, `<title>Network</title><main>Loading</main><script>fetch('/api/items').then(r => r.json()).then(v => document.querySelector('main').textContent = v[0].name)</script>`);
      return;
    }
    if (path === "/api/items") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ name: "Beta", price: 8 }]));
      return;
    }
    const detail = path.match(/^\/details\/(alpha|beta)$/)?.[1];
    if (detail) {
      html(response, `<title>${title(detail)}</title><main><h1>Item details ${title(detail)}</h1></main>`);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test("semantic observation selects and opens the least expensive available item", async () => {
  const worker = new BrowserWorker();
  try {
    const { sessionId, pageId } = await open(worker);
    await dispatch(worker, "web.navigate", { session_id: sessionId, page_id: pageId, url: `${baseUrl}/items` });
    const observed = await dispatch(worker, "web.observe", { session_id: sessionId, page_id: pageId });
    const observation = observed.observation as Observation;
    assert.equal(observation.interactiveElements.length, 3);
    assert.equal(observation.ariaSnapshot.includes("Available items"), true);
    const beta = observation.interactiveElements.find(element => element.name.includes("Beta"));
    assert.ok(beta);
    const clicked = await dispatch(worker, "web.click", {
      session_id: sessionId,
      page_id: pageId,
      target: beta.elementRef,
      expected_page_revision: observation.revision,
    });
    const result = clicked.observation as Observation;
    assert.equal(result.visibleText.includes("Item details Beta"), true);
    assert.equal((clicked.evidence as { mechanicalSuccess: boolean }).mechanicalSuccess, true);
  } finally {
    await worker.close();
  }
});

test("stale revision rejects an action without navigation", async () => {
  const worker = new BrowserWorker();
  try {
    const { sessionId, pageId } = await open(worker);
    await dispatch(worker, "web.navigate", { session_id: sessionId, page_id: pageId, url: `${baseUrl}/stale` });
    const observed = await dispatch(worker, "web.observe", { session_id: sessionId, page_id: pageId });
    const observation = observed.observation as Observation;
    await dispatch(worker, "web.wait", { session_id: sessionId, page_id: pageId, milliseconds: 150 });
    await assert.rejects(
      dispatch(worker, "web.click", {
        session_id: sessionId,
        page_id: pageId,
        target: observation.interactiveElements[0].elementRef,
        expected_page_revision: observation.revision,
      }),
      error => error instanceof ProtocolFailure && error.detail.code === "stale_observation",
    );
    const current = await dispatch(worker, "web.observe", { session_id: sessionId, page_id: pageId });
    assert.equal((current.observation as Observation).url, `${baseUrl}/stale`);
  } finally {
    await worker.close();
  }
});

test("unknown targets and unregistered capabilities do not mutate the page", async () => {
  const worker = new BrowserWorker();
  try {
    const { sessionId, pageId } = await open(worker);
    await dispatch(worker, "web.navigate", { session_id: sessionId, page_id: pageId, url: `${baseUrl}/items` });
    const observed = await dispatch(worker, "web.observe", { session_id: sessionId, page_id: pageId });
    const observation = observed.observation as Observation;
    await assert.rejects(
      dispatch(worker, "web.click", { session_id: sessionId, page_id: pageId, target: "e_missing", expected_page_revision: observation.revision }),
      error => error instanceof ProtocolFailure && error.detail.code === "unknown_element",
    );
    await assert.rejects(
      dispatch(worker, "playwright.evaluate", { session_id: sessionId, page_id: pageId }),
      error => error instanceof ProtocolFailure && error.detail.code === "capability_not_registered",
    );
    const current = await dispatch(worker, "web.observe", { session_id: sessionId, page_id: pageId });
    assert.equal((current.observation as Observation).url, `${baseUrl}/items`);
  } finally {
    await worker.close();
  }
});

test("network bodies require bounded explicit retrieval", async () => {
  const worker = new BrowserWorker();
  try {
    const { sessionId, pageId } = await open(worker);
    await dispatch(worker, "web.navigate", { session_id: sessionId, page_id: pageId, url: `${baseUrl}/network` });
    await dispatch(worker, "web.wait", { session_id: sessionId, page_id: pageId, milliseconds: 100 });
    const network = await dispatch(worker, "web.network.observe", { session_id: sessionId, page_id: pageId });
    const request = (network.requests as Array<{ requestId: string; url: string }>).find(item => item.url.endsWith("/api/items"));
    assert.ok(request);
    const body = await dispatch(worker, "web.network.body", {
      session_id: sessionId,
      page_id: pageId,
      network_request_id: request.requestId,
      max_bytes: 32,
    });
    assert.deepEqual(JSON.parse(String(body.body)), [{ name: "Beta", price: 8 }]);
    assert.equal(body.truncated, false);
  } finally {
    await worker.close();
  }
});

interface Observation {
  url: string;
  revision: number;
  visibleText: string;
  ariaSnapshot: string;
  interactiveElements: Array<{ elementRef: string; name: string }>;
}

async function open(worker: BrowserWorker): Promise<{ sessionId: string; pageId: string }> {
  const result = await dispatch(worker, "web.session.open", { isolated: true });
  return result as { sessionId: string; pageId: string };
}

async function dispatch(worker: BrowserWorker, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return worker.dispatch({ id: `req_${method}`, method, params });
}

function html(response: import("node:http").ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body>${body}</body></html>`);
}

function title(value: string): string {
  return value[0].toUpperCase() + value.slice(1);
}
