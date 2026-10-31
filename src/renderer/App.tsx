import { useEffect, useState } from 'react';
import type { AppInfo, SftpClientBridge } from '../shared/ipc-contract';

declare global {
  interface Window {
    sftpClient: SftpClientBridge;
  }
}

/** Placeholder window for milestone 1 (transport + packaging only). */
export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void window.sftpClient.app.getInfo().then((r) => {
      if (r.ok) setInfo(r.value);
    });
  }, []);
  return (
    <main>
      <h1>SimpleSFTP</h1>
      <p>Transport milestone build. Profiles and browsing arrive in the next milestone.</p>
      {info && (
        <p data-testid="app-info">
          {info.name} {info.version} · Electron {info.electron} · {info.platform}/{info.arch}
        </p>
      )}
    </main>
  );
}
