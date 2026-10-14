import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmClient } from '../../src/core/llm/client';

let server: http.Server;
let baseUrl: string;
let handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;
let requests: { url: string; body: string }[];

beforeEach(async () => {
  requests = [];
  handler = (_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
  };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const client = (over = {}) => new LlmClient({ baseUrl, backoffMs: 1, ...over });
const messages = [{ role: 'user' as const, content: 'hi' }];

describe('LlmClient', () => {
  it('posts the chat request and returns the content', async () => {
    expect(await client().chat(messages, { temperature: 0.1, maxTokens: 50 })).toBe('hello');
    const sent = JSON.parse(requests[0].body);
    expect(requests[0].url).toBe('/v1/chat/completions');
    expect(sent).toMatchObject({
      messages,
      temperature: 0.1,
      max_tokens: 50,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('strips reasoning blocks from the reply', async () => {
    handler = (_r, _b, res) => res.end(JSON.stringify({ choices: [{ message: { content: '<think>x</think>Answer' } }] }));
    expect(await client().chat(messages)).toBe('Answer');
  });

  it('retries a 500 and then succeeds', async () => {
    let calls = 0;
    handler = (_r, _b, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    };
    expect(await client().chat(messages)).toBe('ok');
    expect(calls).toBe(2);
  });

  it('fails with LlmFailed after the retries are used up', async () => {
    handler = (_r, _b, res) => {
      res.statusCode = 503;
      res.end('nope');
    };
    await expect(client({ retries: 1 }).chat(messages)).rejects.toMatchObject({ code: 'LlmFailed' });
    expect(requests).toHaveLength(2);
  });

  it('does not retry a 400', async () => {
    handler = (_r, _b, res) => {
      res.statusCode = 400;
      res.end('bad request');
    };
    await expect(client().chat(messages)).rejects.toMatchObject({ code: 'LlmFailed' });
    expect(requests).toHaveLength(1);
  });

  it('rejects with the abort reason when aborted', async () => {
    handler = () => {
      /* never answers */
    };
    const controller = new AbortController();
    const pending = client({ timeoutMs: 10_000 }).chat(messages, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('treats a missing message content as a failure', async () => {
    handler = (_r, _b, res) => res.end(JSON.stringify({ choices: [] }));
    await expect(client({ retries: 0 }).chat(messages)).rejects.toMatchObject({ code: 'LlmFailed' });
  });
});
