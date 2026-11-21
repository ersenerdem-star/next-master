import { useEffect, useRef, useState } from "react";

/** Refresh on each opening, and ignore results from an earlier opening. */
export function useSupplierUploadRefresh<T>(open: boolean, load: () => Promise<T>, onLoaded: (value: T) => void, timeoutMs = 15_000) {
  const loadRef = useRef(load);
  const onLoadedRef = useRef(onLoaded);
  loadRef.current = load;
  onLoadedRef.current = onLoaded;
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const timer = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      setLoading(false);
      setFailed(true);
    }, timeoutMs);
    void loadRef.current().then((result) => {
      if (!cancelled) onLoadedRef.current(result);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    }).finally(() => {
      clearTimeout(timer);
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, retry, timeoutMs]);

  return { loading, failed, retry: () => setRetry((value) => value + 1) };
}
