import { useRef, useState } from 'react';

const SHOWN_ROWS = 200;
const DEFAULT_SQL = 'select id, customer_id, product_id, total, status from orders order by id';

type Row = Record<string, unknown>;

export function Console({ prefix }: { prefix: string }) {
  const [tenant, setTenant] = useState('tenant_a');
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [stream, setStream] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const abort = useRef<AbortController | null>(null);

  async function run() {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const started = performance.now();
    setStatus('running');
    setMessage('');
    setRows([]);
    setCount(0);
    setDurationMs(null);

    const res = await fetch(`/v1/tenants/${tenant}/query`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': `${prefix}-${tenant.slice(-1)}-console`,
        'x-caller-type': 'console',
      },
      body: JSON.stringify({ sql, stream }),
    }).catch((e: Error) => e);
    if (res instanceof Error) {
      setStatus('error');
      setMessage(res.message);
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus('error');
      setMessage(`${res.status} ${body.error?.code ?? ''}: ${body.error?.message ?? res.statusText}`);
      return;
    }

    if (!stream) {
      const body = await res.json();
      setRows(body.rows.slice(0, SHOWN_ROWS));
      setCount(body.rowCount);
      setDurationMs(body.durationMs);
      setMessage(body.truncated ? 'truncated at maxRows' : '');
      setStatus('done');
      return;
    }

    // NDJSON: read chunks, count every row, keep only the first rows for display.
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const shown: Row[] = [];
    let n = 0;
    let buf = '';
    let lastPaint = 0;
    const paint = () => {
      setRows(shown.slice());
      setCount(n);
      setDurationMs(Math.round(performance.now() - started));
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        const parts = buf.split('\n');
        buf = parts.pop()!;
        for (const line of parts) {
          const obj = JSON.parse(line);
          if (obj._meta) setMessage(obj._meta.truncated ? 'truncated at maxRows' : '');
          else if (obj._error) {
            setStatus('error');
            setMessage(`${obj._error.code}: ${obj._error.message}`);
          } else {
            n++;
            if (shown.length < SHOWN_ROWS) shown.push(obj);
          }
        }
        if (performance.now() - lastPaint > 100) {
          lastPaint = performance.now();
          paint();
        }
      }
      paint();
      setStatus((s) => (s === 'error' ? s : 'done'));
    } catch {
      setStatus('error');
      setMessage('stream aborted');
    }
  }

  const columns = rows[0] ? Object.keys(rows[0]) : [];
  return (
    <section>
      <div className="toolbar">
        <label>
          tenant
          <select value={tenant} onChange={(e) => setTenant(e.target.value)} aria-label="tenant">
            {['tenant_a', 'tenant_b', 'tenant_c'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} /> stream (NDJSON)
        </label>
        <button onClick={run} disabled={status === 'running'}>Run</button>
        <span data-testid="counter">
          rows: {count} · {durationMs ?? '–'} ms · {status}
        </span>
      </div>
      <textarea aria-label="sql" value={sql} onChange={(e) => setSql(e.target.value)} rows={5} spellCheck={false} />
      {message && <p className={status === 'error' ? 'err' : 'note'}>{message}</p>}
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((c) => <td key={c}>{String(r[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {count > SHOWN_ROWS && <p className="note">showing the first {SHOWN_ROWS} of {count} rows</p>}
    </section>
  );
}
