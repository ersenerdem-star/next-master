#!/usr/bin/env node

const term = String(process.argv[2] || "").trim();
const filters = String(process.argv[3] || "").trim();
const ipp = Number.parseInt(process.argv[4] || "5", 10) || 5;
const country = String(process.argv[5] || "TR").trim() || "TR";
const language = String(process.argv[6] || "tr").trim() || "tr";

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const url = new URL("https://aftermarket.zf.com/api/search");
url.searchParams.set("country", country);
url.searchParams.set("language", language);
url.searchParams.set("expand", "extended,special");
url.searchParams.set("ipp", String(ipp));
url.searchParams.set("offset", "0");
if (term) url.searchParams.set("term", term);
if (filters) url.searchParams.set("filters", filters);

const response = await fetch(url, { headers: requestHeaders });
const text = await response.text();

console.log(JSON.stringify({ status: response.status, url: url.toString() }, null, 2));
console.log(text.slice(0, 4000));
