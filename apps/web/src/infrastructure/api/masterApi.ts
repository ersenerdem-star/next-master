import { supabaseClient } from "./supabaseClient";
import type { MasterRow } from "../../types/master";

type MasterParams = {
  search: string;
  brand: string;
  scope: string;
  page?: number;
  pageSize?: number;
  marginA?: number;
  marginB?: number;
};

export async function fetchCloudMaster({
  search,
  brand,
  scope,
  page = 1,
  pageSize = 50,
  marginA = 0.1,
  marginB = 0.15,
}: MasterParams): Promise<MasterRow[]> {
  const { data, error } = await supabaseClient.rpc("cloud_master_page", {
    input_search: search,
    input_brand: brand,
    input_page: page,
    input_page_size: pageSize,
    input_margin_a: marginA,
    input_margin_b: marginB,
    input_scope: scope,
  });

  if (error) {
    throw new Error(error.message || "Failed to load master rows");
  }

  return (data || []) as MasterRow[];
}

export async function fetchAllCloudMaster(params: Omit<MasterParams, "page" | "pageSize">): Promise<MasterRow[]> {
  const pageSize = 1000;
  let page = 1;
  const allRows: MasterRow[] = [];

  while (true) {
    const rows = await fetchCloudMaster({
      ...params,
      page,
      pageSize,
    });
    allRows.push(...rows);
    if (rows.length < pageSize) break;
    page += 1;
  }

  return allRows;
}
