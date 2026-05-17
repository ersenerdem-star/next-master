import { supabaseClient } from "./supabaseClient";
import type { QuoteDetail, QuoteSummary } from "../../types/quotes";

export async function fetchCloudQuotes(search: string): Promise<QuoteSummary[]> {
  const { data, error } = await supabaseClient.rpc("list_cloud_quotes", {
    input_limit: 50,
    input_search: search,
    input_customer: "",
    input_status: "",
  });

  if (error) {
    throw new Error(error.message || "Failed to load quotes");
  }

  return (data || []) as QuoteSummary[];
}

export async function fetchCloudQuoteDetail(quoteId: string): Promise<QuoteDetail> {
  const { data, error } = await supabaseClient.rpc("get_cloud_quote", {
    input_quote_id: quoteId,
  });

  if (error) {
    throw new Error(error.message || "Failed to load quote detail");
  }

  const payload = (data || null) as QuoteDetail | null;

  return {
    quote: payload?.quote || null,
    lines: payload?.lines || [],
  };
}
