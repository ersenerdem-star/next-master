import { callAppRpc } from "./appRpcApi";
import type { QuoteDetail, QuoteSummary } from "../../types/quotes";

export async function fetchCloudQuotes(search: string): Promise<QuoteSummary[]> {
  const data = await callAppRpc<QuoteSummary[]>("list_cloud_quotes", {
    input_limit: 50,
    input_search: search,
    input_customer: "",
    input_status: "",
  });

  return (data || []) as QuoteSummary[];
}

export async function fetchCloudQuoteDetail(quoteId: string): Promise<QuoteDetail> {
  const data = await callAppRpc<QuoteDetail | null>("get_cloud_quote", {
    input_quote_id: quoteId,
  });

  const payload = (data || null) as QuoteDetail | null;

  return {
    quote: payload?.quote || null,
    lines: payload?.lines || [],
  };
}
