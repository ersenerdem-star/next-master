import assert from "node:assert/strict";
import {
  parseMotorserviceFitmentSnapshot,
  parseMotorserviceGuestSnapshot,
} from "../_shared/motorservice-guest-parser.mjs";

const detail = parseMotorserviceGuestSnapshot(
  {
    url: "https://onlineshop.ms-motorservice.com/msi/MSICD?lang=E&page=showVEDetail&ksnr=22316",
    bodyText: [
      "Product group valve 22316",
      "DENNIS / DEUTZ / LAMBORGHINI / PLAXTON / RENAULT TRUCKS (RVI) / SAME / VOLVO",
      "Product description",
      "EAN 4028977680670",
      "Weight [g] 640",
      "Country of origin Germany",
      "HS code 8409 99 00",
      "Replaced by 22317",
      "Alternative 22318",
      "Dimensions",
      "Suitable for vehicles …",
      "Suitable for engines …",
    ].join("\n"),
    links: [
      {
        text: "Suitable for vehicles …",
        href: "https://onlineshop.ms-motorservice.com/msi/MSICD?ksnr=22316&page=showVehToNum",
      },
      {
        text: "Suitable for engines …",
        href: "https://onlineshop.ms-motorservice.com/msi/MSICD?ksnr=22316&page=showMotToNum",
      },
    ],
    images: [
      {
        alt: "",
        src: "https://onlineshop.ms-motorservice.com/msi/html/page/claim.png",
      },
      {
        alt: "",
        src: "https://onlineshop.ms-motorservice.com/msi/html/page/marken/marke_trw.gif",
      },
      {
        alt: "TRW 22316 product image",
        src: "https://onlineshop.ms-motorservice.com/media/products/22316.jpg",
      },
    ],
  },
  { brandName: "TRW Engine Components", requestedCode: "22 316" },
);

assert.equal(detail.status, "accepted");
assert.equal(detail.product_code, "22316");
assert.equal(detail.normalized_code, "22316");
assert.equal(detail.ean, "4028977680670");
assert.equal(detail.source_type, "official_motorservice_guest");
assert.equal(detail.raw_capture_retained, false);
assert.equal(detail.weight_kg, 0.64);
assert.equal(detail.origin, "DE");
assert.equal(detail.hs_code, "84099900");
assert.deepEqual(detail.superseded_by_codes, ["22317"]);
assert.deepEqual(detail.alternative_codes, ["22318"]);
assert.equal(detail.image_url, "https://onlineshop.ms-motorservice.com/media/products/22316.jpg");
assert.equal(detail.vehicle, "");
assert.equal(detail.vehicle_model, "");
assert.equal(detail.fitment_links.length, 2);

const vehicles = parseMotorserviceFitmentSnapshot(
  {
    url: "https://onlineshop.ms-motorservice.com/msi/MSICD?page=showVehToNum&ksnr=22316",
    bodyText: "Suitable for vehicles",
    tables: [
      [
        ["Manufacturer", "Model", "Engine"],
        ["VOLVO", "FH 12", "D12A420"],
        ["RENAULT TRUCKS", "KERAX", "DXi 11"],
        ["type of fuel", "D", "diesel"],
        ["D", "diesel"],
        ["G", "Other types of gas engines"],
        ["NA", "Not charged"],
        ["LA", "Charge intercooling"],
      ],
    ],
  },
  { kind: "vehicles" },
);

assert.equal(vehicles.status, "accepted");
assert.equal(vehicles.kind, "vehicles");
assert.deepEqual(vehicles.entries, [
  "VOLVO | FH 12 | D12A420",
  "RENAULT TRUCKS | KERAX | DXi 11",
]);
assert.equal(vehicles.raw_capture_retained, false);

const pierburg = parseMotorserviceGuestSnapshot(
  {
    url: "https://onlineshop.ms-motorservice.com/msi/MSICD?page=showABGDSDetail&ksnr=7.12477.00.0",
    bodyText: [
      "Product group exhaust gas pressure sensor 7.12477.00.0",
      "Product description",
      "EAN 4028977975967",
    ].join("\n"),
    links: [],
  },
  { brandName: "Pierburg", requestedCode: "7.12477.00.0" },
);

assert.equal(pierburg.product_code, "7.12477.00.0");
assert.equal(pierburg.normalized_code, "7.12477.00.0");
assert.equal(pierburg.description, "exhaust gas pressure sensor");

const blocked = parseMotorserviceGuestSnapshot(
  {
    url: "https://onlineshop.ms-motorservice.com/msi/MSICD?page=checkUser",
    bodyText: "Security query Enter characters shown in the image",
    links: [],
  },
  { brandName: "BF", requestedCode: "20100520136" },
);

assert.equal(blocked.status, "blocked");
assert.equal(blocked.reason, "SECURITY_QUERY_REQUIRES_MANUAL_COMPLETION");

console.log("motorservice guest parser tests passed");
