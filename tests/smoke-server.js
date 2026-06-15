const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'smoke-fixture.html');
const script = path.join(root, 'zhihu-auto-scroll.js');

http.createServer((request, response) => {
  const file = request.url === '/zhihu-auto-scroll.js' ? script : fixture;
  response.setHeader('Content-Type', file === script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  fs.createReadStream(file).pipe(response);
}).listen(51999, '127.0.0.1');
