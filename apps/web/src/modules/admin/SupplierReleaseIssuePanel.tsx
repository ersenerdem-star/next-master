import { useEffect, useState } from "react";
import { fetchSupplierReleaseIssuePage, type ReleaseIssueCursor } from "../../infrastructure/api/supplierReleaseReviewApi";
import type { ReleaseIssueRow, ReleaseReviewRow } from "../../shared/supplierReleaseReview";
import { SectionCard } from "../../presentation/components/common/SectionCard";
import { Button } from "../../presentation/components/common/Button";
import { SupplierReleaseIssues } from "./SupplierReleaseReviewCard";

// Keyed by release ID at the caller. Effect cleanup prevents another release's
// late response from appearing under the currently selected release heading.
export function SupplierReleaseIssuePanel({ release, tr, onClose }: { release: ReleaseReviewRow; tr: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<ReleaseIssueRow[]>([]);
  const [cursor, setCursor] = useState<ReleaseIssueCursor | null>(null);
  const [next, setNext] = useState<ReleaseIssueCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setError(false);
    const timer = window.setTimeout(() => controller.abort(), 12_000);
    void fetchSupplierReleaseIssuePage(release.id, cursor, controller.signal).then((page) => {
      if (!current || controller.signal.aborted) return;
      setRows((previous) => cursor ? [...previous, ...page.rows] : page.rows);
      setNext(page.next);
    }).catch(() => { if (current) setError(true); }).finally(() => {
      window.clearTimeout(timer);
      if (current) setLoading(false);
    });
    return () => { current = false; controller.abort(); window.clearTimeout(timer); };
  }, [release.id, cursor, retry]);
  return <SectionCard title={`${tr ? "Sorunlu satırlar" : "Problematic rows"} — ${release.brand} / ${release.supplier}`} actions={
    <Button variant="secondary" onClick={onClose}>{tr ? "Kapat" : "Close"}</Button>
  }>
    <SupplierReleaseIssues rows={rows} tr={tr} loading={loading} error={error} next={Boolean(next) && !error} onLoadMore={() => setCursor(next)} />
    {error ? <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>{tr ? "Yeniden dene" : "Retry"}</Button> : null}
  </SectionCard>;
}
