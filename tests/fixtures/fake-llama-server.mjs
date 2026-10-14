import http from 'node:http';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);

if (process.env.FAKE_LLAMA_MODE === 'crash') {
  console.error('error: failed to load model');
  process.exit(1);
}

const readyAt = Date.now() + 400;
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.statusCode = Date.now() < readyAt ? 503 : 200;
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(port, '127.0.0.1');
