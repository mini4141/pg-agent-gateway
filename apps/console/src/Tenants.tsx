import { useEffect, useState } from 'react';

interface Stat {
  rps: number;
  p95Ms: number;
  rateLimited: number;
  errors5xx: number;
  pool: { inUse: number; waiting: number; total: number };
}

export function Tenants({ prefix }: { prefix: string }) {
  const [stats, setStats] = useState<Record<string, Stat>>({});
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      const res = await fetch('/v1/admin/stats', { headers: { 'x-api-key': `${prefix}-admin` } }).catch(() => null);
      if (!res?.ok) return setError(`stats unavailable (${res?.status ?? 'network'})`);
      setError('');
      setStats((await res.json()).tenants);
    };
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [prefix]);

  return (
    <section>
      <h2>Live tenant metrics <small>(last 10 s, this gateway instance)</small></h2>
      {error && <p className="err">{error}</p>}
      <table>
        <thead>
          <tr><th>tenant</th><th>RPS</th><th>p95 ms</th><th>429 (10 s)</th><th>5xx (10 s)</th><th>pool in use</th><th>pool waiting</th></tr>
        </thead>
        <tbody>
          {Object.entries(stats).map(([t, s]) => (
            <tr key={t} className={s.rateLimited > 0 ? 'hot' : ''}>
              <td>{t}</td><td>{s.rps}</td><td>{s.p95Ms}</td><td>{s.rateLimited}</td><td>{s.errors5xx}</td>
              <td>{s.pool.inUse}/{s.pool.total}</td><td>{s.pool.waiting}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
