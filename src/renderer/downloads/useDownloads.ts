import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_DOWNLOADS, type DownloadsSnapshot } from '../../shared/downloads';
import { api } from '../api';

/** Latest downloads snapshot from main; out-of-order events are dropped (spec 9.4). */
export function useDownloads(): DownloadsSnapshot {
  const [snap, setSnap] = useState<DownloadsSnapshot>(EMPTY_DOWNLOADS);
  const rev = useRef(-1);
  const apply = useCallback((s: DownloadsSnapshot) => {
    if (s.revision <= rev.current) return;
    rev.current = s.revision;
    setSnap(s);
  }, []);
  useEffect(() => {
    const off = api().downloads.onChange(apply);
    void api()
      .downloads.list()
      .then((r) => r.ok && apply(r.value));
    return off;
  }, [apply]);
  return snap;
}
