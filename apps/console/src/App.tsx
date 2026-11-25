import { useState } from 'react';
import { Console } from './Console';
import { Tenants } from './Tenants';

/** Demo keys follow the seed convention `<prefix>-<tenant letter>-console` and `<prefix>-admin`. */
export function App() {
  const [prefix, setPrefix] = useState(() => localStorage.getItem('keyPrefix') ?? 'dev');
  const onTenants = location.pathname.startsWith('/tenants');
  return (
    <>
      <header>
        <strong>PG Agent Gateway</strong>
        <a href="/console" className={onTenants ? '' : 'active'}>Console</a>
        <a href="/tenants" className={onTenants ? 'active' : ''}>Tenants</a>
        <a href="/docs">API docs</a>
        <label className="right">
          demo key prefix
          <input
            value={prefix}
            onChange={(e) => {
              setPrefix(e.target.value);
              localStorage.setItem('keyPrefix', e.target.value);
            }}
          />
        </label>
      </header>
      <main>{onTenants ? <Tenants prefix={prefix} /> : <Console prefix={prefix} />}</main>
    </>
  );
}
