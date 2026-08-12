import { createServer, type Server } from 'node:http';

export interface HealthChecks {
  ready: () => Promise<Record<string, boolean>>;
}

/**
 * Minimal HTTP surface for the worker: liveness, readiness, startup probes.
 * (Prometheus metrics are served separately on CDFIR_METRICS_PORT.)
 */
export function startHealthServer(port: number, checks: HealthChecks): Server {
  const startedAt = Date.now();
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/healthz' || req.url === '/livez') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptimeMs: Date.now() - startedAt }));
        return;
      }
      if (req.url === '/readyz' || req.url === '/startupz') {
        try {
          const results = await checks.ready();
          const ok = Object.values(results).every(Boolean);
          res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', checks: results }));
        } catch {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'degraded' }));
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    })();
  });
  server.listen(port, '0.0.0.0');
  return server;
}
