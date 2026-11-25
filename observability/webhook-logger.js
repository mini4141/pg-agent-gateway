// Stand-in for a pager: logs every Alertmanager webhook as one JSON line on stdout.
import http from 'node:http';

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      for (const a of JSON.parse(body || '{}').alerts ?? []) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), status: a.status, alert: a.labels.alertname, labels: a.labels, summary: a.annotations.summary }));
      }
      res.end('ok');
    });
  })
  .listen(9095);
