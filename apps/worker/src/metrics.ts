import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics for the worker. Scraped from EV_METRICS_PORT at /metrics.
 *
 * Documented alert conditions (wire in your Prometheus rules):
 *  - ev_outbox_pending > 1000 for 10m         → dispatcher stalled/backlogged
 *  - rate(ev_jobs_failed_total[5m]) > 1       → sustained job failures
 *  - ev_dead_letter_total increasing          → poisoned messages need triage
 *  - rate(ev_rate_limit_wait_ms_total[5m]) high → provider throttling collections
 *  - absence of ev_worker_heartbeat           → worker down
 */
export class WorkerMetrics {
  readonly registry = new Registry();
  readonly jobsProcessed: Counter<'queue' | 'outcome'>;
  readonly jobDuration: Histogram<'queue'>;
  readonly deadLettered: Counter<'queue'>;
  readonly outboxPending: Gauge;
  readonly rateLimitWaitMs: Counter<'provider'>;
  readonly heartbeat: Gauge;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'ev_' });
    this.jobsProcessed = new Counter({
      name: 'ev_jobs_total',
      help: 'Jobs processed by queue and outcome',
      labelNames: ['queue', 'outcome'],
      registers: [this.registry],
    });
    this.jobDuration = new Histogram({
      name: 'ev_job_duration_seconds',
      help: 'Job processing duration',
      labelNames: ['queue'],
      buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900],
      registers: [this.registry],
    });
    this.deadLettered = new Counter({
      name: 'ev_dead_letter_total',
      help: 'Jobs moved to the dead-letter queue',
      labelNames: ['queue'],
      registers: [this.registry],
    });
    this.outboxPending = new Gauge({
      name: 'ev_outbox_pending',
      help: 'Outbox rows in pending status (sampled)',
      registers: [this.registry],
    });
    this.rateLimitWaitMs = new Counter({
      name: 'ev_rate_limit_wait_ms_total',
      help: 'Cumulative provider rate-limit wait in milliseconds',
      labelNames: ['provider'],
      registers: [this.registry],
    });
    this.heartbeat = new Gauge({
      name: 'ev_worker_heartbeat',
      help: 'Unix time of the last worker heartbeat',
      registers: [this.registry],
    });
  }

  serve(port: number): Server {
    const server = createServer((req, res) => {
      if (req.url === '/metrics') {
        this.heartbeat.set(Date.now() / 1000);
        void this.registry.metrics().then((body) => {
          res.writeHead(200, { 'content-type': this.registry.contentType });
          res.end(body);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(port, '0.0.0.0');
    return server;
  }
}
