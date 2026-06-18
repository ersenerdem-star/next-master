import * as QRCode from "qrcode";
import { getAppLanguageLocale, translateAppText, type AppLanguage } from "../app/i18n";

type WarehousePackingLine = {
  code: string;
  brand: string;
  description: string;
  shelfAddress: string;
  sectionCode: string;
  origin: string;
  hsCode: string;
  netWeightKg: number | null;
  orderQty: number;
  packedQty: number;
  packageLabel: string;
};

type WarehousePackingPackage = {
  label: string;
  packageType: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  orientation: string;
  netWeightKg: number;
  grossWeightKg: number;
  volumeM3: number;
  itemCount: number;
  notes: string;
  assignedLines: Array<{
    code: string;
    packedQty: number;
  }>;
};

type WarehouseLoadingRow = {
  sequence: number;
  packageLabel: string;
  packageType: string;
  orientation: string;
  volumeM3: number;
  grossWeightKg: number;
  itemQty: number;
};

export type WarehousePackingTheme = {
  displayName: string;
  eyebrow: string;
  accent: string;
  accentSoft: string;
  accentInk: string;
  accentBorder: string;
  footerNote: string;
};

type BuildWarehousePackingHtmlInput = {
  orderNo: string;
  invoiceNo: string;
  customerName: string;
  sellerCompany: string;
  shipDate: string;
  packingNotes: string;
  stockFlowNote: string;
  vehicleLabel: string;
  vehicleReference: string;
  vehicleNotes: string;
  totalOrderQty: number;
  totalPackedQty: number;
  packageCount: number;
  usedVolumeM3: number;
  remainingVolumeM3: number;
  loadedGrossWeightKg: number;
  remainingWeightKg: number;
  maxVolumeM3: number;
  maxGrossWeightKg: number;
  packages: WarehousePackingPackage[];
  shipmentLines: WarehousePackingLine[];
  loadingRows: WarehouseLoadingRow[];
};

export type WarehousePackingWorkbook = {
  rows: Array<Array<string | number | null | undefined>>;
  numericColumns: number[];
};

export type WarehouseLabelLayout = "a4_single" | "a6" | "a4_2up" | "a4_4up";
export type WarehouseLabelCodeMode = "barcode" | "qr" | "both";

export type BuildWarehousePackageLabelsOptions = {
  packageLabels?: string[];
  layout?: WarehouseLabelLayout;
  codeMode?: WarehouseLabelCodeMode;
};

const CODE39_PATTERNS: Record<string, string> = {
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  "$": "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
};

type WarehousePackingTranslator = (
  key: Parameters<typeof translateAppText>[1],
  variables?: Record<string, string | number>,
) => string;

type WarehousePackingPrintCopy = {
  packingPlanTitle: string;
  packageStickersTitle: string;
  fallbackSeller: string;
  packageBreakdownTitle: string;
  packageBreakdownNote: string;
  packingNotesTitle: string;
  packingNotesHelp: string;
  orderPackingTitle: string;
  noPackingNote: string;
  vehicleLoadingTitle: string;
  noVehicleLoadingNote: string;
  stockLifecycleTitle: string;
  defaultStockFlowNote: string;
  shipmentLinesNote: string;
  packageSummaryNote: string;
  loadingSequenceNote: string;
  noShipmentLines: string;
  noAssignedLines: string;
  noPackageShell: string;
  noLoadingSequence: string;
  noPackageBreakdown: string;
  noPackageNote: string;
  generatedBy: string;
  contents: string;
  dimensions: string;
  type: string;
  itemCount: string;
  scanCode: string;
  barcode: string;
  qr: string;
  packageSticker: string;
  noPackage: string;
  createPackageShellsFirst: string;
  stickOnOuterFace: string;
  fitsInsideVehicle: (remainingWeight: string, remainingVolume: string) => string;
  exceedsVehicleCapacity: (remainingWeight: string, remainingVolume: string) => string;
  templateTag: (displayName: string) => string;
};

type WarehousePackingCommonLabel =
  | "order"
  | "invoice"
  | "customer"
  | "seller"
  | "shipDate"
  | "reference"
  | "packageCount"
  | "stockFlow"
  | "template"
  | "assignedCodes"
  | "hsCode"
  | "netWeightKg"
  | "packageGrossKg"
  | "packageVolumeM3";

function createWarehousePackingTranslator(language: AppLanguage): WarehousePackingTranslator {
  return (key, variables) => translateAppText(language, key, variables);
}

function getWarehousePackingPrintCopy(language: AppLanguage): WarehousePackingPrintCopy {
  switch (language) {
    case "tr":
      return {
        packingPlanTitle: "Paketleme Listesi ve Yükleme Planı",
        packageStickersTitle: "Paket Etiketleri",
        fallbackSeller: "Next Master",
        packageBreakdownTitle: "Paket İçerik Dökümü",
        packageBreakdownNote: "Bu tablo her paketin içinde ne olduğunu, ölçülerini ve notlarını açıkça gösterir.",
        packingNotesTitle: "Paketleme Notları",
        packingNotesHelp: "Operasyon notları depo personeli ve admin incelemesi için görünür kalır.",
        orderPackingTitle: "Sipariş Paketleme",
        noPackingNote: "Paketleme notu yok.",
        vehicleLoadingTitle: "Araç Yükleme",
        noVehicleLoadingNote: "Araç yükleme notu yok.",
        stockLifecycleTitle: "Stok Yaşam Döngüsü",
        defaultStockFlowNote: "Paketlenen adet, fatura kesilene kadar geçici depoda rezerve kalır.",
        shipmentLinesNote: "Stok lokasyonu, origin, GTIP/HS code, net ağırlık ve paket atamasını içerir.",
        packageSummaryNote: "Her paketin ölçüsü, net ve brüt ağırlığı, hacmi, yönü ve içeriği burada görünür.",
        loadingSequenceNote: "Paketler yükleme akışını yansıtacak şekilde hacim ve brüt ağırlığa göre sıralanır.",
        noShipmentLines: "Henüz sevkiyat satırı atanmadı.",
        noAssignedLines: "Henüz atanmış satır yok.",
        noPackageShell: "Henüz paket kabuğu oluşturulmadı.",
        noLoadingSequence: "Henüz yükleme sırası oluşmadı.",
        noPackageBreakdown: "Henüz paket içerik dökümü yok.",
        noPackageNote: "Paket notu yok.",
        generatedBy: "Next Master depo planlama motoru tarafından üretildi",
        contents: "İçerik",
        dimensions: "Ölçüler",
        type: "Tip",
        itemCount: "Ürün Adedi",
        scanCode: "Tarama Kodu",
        barcode: "Barkod",
        qr: "QR",
        packageSticker: "Paket Etiketi",
        noPackage: "Paket yok",
        createPackageShellsFirst: "Önce paket kabuklarını oluşturun.",
        stickOnOuterFace: "Yüklemeden önce dış yüzeye yapıştırın.",
        fitsInsideVehicle: (remainingWeight, remainingVolume) =>
          `Yük seçilen araca sığıyor. Kalan ağırlık ${remainingWeight} ve kalan hacim ${remainingVolume} olarak kullanılabilir durumda.`,
        exceedsVehicleCapacity: (remainingWeight, remainingVolume) =>
          `Yük seçilen araç kapasitesini aşıyor. Kalan ağırlık ${remainingWeight} ve kalan hacim ${remainingVolume} taşmayı gösteriyor.`,
        templateTag: (displayName) => `${displayName} şablonu`,
      };
    case "ru":
      return {
        packingPlanTitle: "Упаковочный лист и план загрузки",
        packageStickersTitle: "Этикетки пакетов",
        fallbackSeller: "Next Master",
        packageBreakdownTitle: "Состав пакетов",
        packageBreakdownNote: "В этой таблице показано точное содержимое каждого пакета, его размеры и примечания.",
        packingNotesTitle: "Примечания по упаковке",
        packingNotesHelp: "Операционные примечания остаются видимыми для склада и для проверки администратором.",
        orderPackingTitle: "Упаковка заказа",
        noPackingNote: "Нет примечания по упаковке.",
        vehicleLoadingTitle: "Погрузка транспорта",
        noVehicleLoadingNote: "Нет примечания по погрузке.",
        stockLifecycleTitle: "Жизненный цикл запаса",
        defaultStockFlowNote: "Упакованное количество остается зарезервированным на временном складе до проведения счета.",
        shipmentLinesNote: "Включает место хранения, страну происхождения, HS-код, нетто-вес и назначенный пакет.",
        packageSummaryNote: "Для каждого пакета отображаются размеры, вес нетто и брутто, объем, ориентация и вложенные товары.",
        loadingSequenceNote: "Пакеты упорядочены по объему и весу брутто, чтобы отражать реальный порядок загрузки.",
        noShipmentLines: "Строки отгрузки еще не назначены.",
        noAssignedLines: "Назначенных строк пока нет.",
        noPackageShell: "Шаблон пакета еще не создан.",
        noLoadingSequence: "Последовательность загрузки пока недоступна.",
        noPackageBreakdown: "Состав пакетов пока недоступен.",
        noPackageNote: "Нет примечания к пакету.",
        generatedBy: "Сформировано системой планирования склада Next Master",
        contents: "Содержимое",
        dimensions: "Размеры",
        type: "Тип",
        itemCount: "Кол-во товаров",
        scanCode: "Код для сканирования",
        barcode: "Штрихкод",
        qr: "QR",
        packageSticker: "Этикетка пакета",
        noPackage: "Нет пакета",
        createPackageShellsFirst: "Сначала создайте шаблоны пакетов.",
        stickOnOuterFace: "Приклейте на внешнюю сторону перед загрузкой.",
        fitsInsideVehicle: (remainingWeight, remainingVolume) =>
          `Груз помещается в выбранное транспортное средство. Оставшийся вес ${remainingWeight}, оставшийся объем ${remainingVolume} еще доступны.`,
        exceedsVehicleCapacity: (remainingWeight, remainingVolume) =>
          `Груз превышает вместимость выбранного транспорта. Оставшийся вес ${remainingWeight} и объем ${remainingVolume} показывают переполнение.`,
        templateTag: (displayName) => `Шаблон ${displayName}`,
      };
    case "ar":
      return {
        packingPlanTitle: "قائمة التعبئة وخطة التحميل",
        packageStickersTitle: "ملصقات الطرود",
        fallbackSeller: "Next Master",
        packageBreakdownTitle: "تفصيل محتويات الطرود",
        packageBreakdownNote: "يوضح هذا الجدول ما يوجد داخل كل طرد مع الأبعاد والملاحظات.",
        packingNotesTitle: "ملاحظات التعبئة",
        packingNotesHelp: "تبقى ملاحظات التشغيل ظاهرة لموظفي المستودع ولمراجعة الإدارة.",
        orderPackingTitle: "تعبئة الطلب",
        noPackingNote: "لا توجد ملاحظة تعبئة.",
        vehicleLoadingTitle: "تحميل المركبة",
        noVehicleLoadingNote: "لا توجد ملاحظة تحميل.",
        stockLifecycleTitle: "دورة المخزون",
        defaultStockFlowNote: "تبقى الكمية المعبأة محجوزة في المستودع المؤقت حتى يتم ترحيل الفاتورة.",
        shipmentLinesNote: "يشمل موقع التخزين وبلد المنشأ ورمز HS والوزن الصافي والطرد المخصص.",
        packageSummaryNote: "يعرض كل طرد الأبعاد والوزن الصافي والإجمالي والحجم والاتجاه والعناصر المخصصة له.",
        loadingSequenceNote: "يتم ترتيب الطرود حسب الحجم والوزن الإجمالي ليعكس سير التحميل الفعلي.",
        noShipmentLines: "لا توجد بنود شحنة مخصصة بعد.",
        noAssignedLines: "لا توجد بنود مخصصة بعد.",
        noPackageShell: "لم يتم إنشاء غلاف طرد بعد.",
        noLoadingSequence: "لا يوجد تسلسل تحميل متاح بعد.",
        noPackageBreakdown: "لا يوجد تفصيل للطرود بعد.",
        noPackageNote: "لا توجد ملاحظة للطرد.",
        generatedBy: "تم الإنشاء بواسطة محرك تخطيط المستودع في Next Master",
        contents: "المحتويات",
        dimensions: "الأبعاد",
        type: "النوع",
        itemCount: "عدد القطع",
        scanCode: "رمز المسح",
        barcode: "باركود",
        qr: "QR",
        packageSticker: "ملصق الطرد",
        noPackage: "لا يوجد طرد",
        createPackageShellsFirst: "أنشئ هياكل الطرود أولاً.",
        stickOnOuterFace: "يُلصق على الجهة الخارجية قبل التحميل.",
        fitsInsideVehicle: (remainingWeight, remainingVolume) =>
          `الحمولة ضمن سعة المركبة المحددة. الوزن المتبقي ${remainingWeight} والحجم المتبقي ${remainingVolume} ما زالا متاحين.`,
        exceedsVehicleCapacity: (remainingWeight, remainingVolume) =>
          `الحمولة تتجاوز سعة المركبة المحددة. الوزن المتبقي ${remainingWeight} والحجم المتبقي ${remainingVolume} يدلان على تجاوز السعة.`,
        templateTag: (displayName) => `قالب ${displayName}`,
      };
    case "fa":
      return {
        packingPlanTitle: "فهرست بسته بندی و برنامه بارگیری",
        packageStickersTitle: "برچسب بسته ها",
        fallbackSeller: "Next Master",
        packageBreakdownTitle: "جزئیات محتویات بسته",
        packageBreakdownNote: "این جدول دقیقا نشان می دهد داخل هر بسته چه چیزی قرار دارد، همراه با ابعاد و یادداشت ها.",
        packingNotesTitle: "یادداشت های بسته بندی",
        packingNotesHelp: "یادداشت های عملیاتی برای کارکنان انبار و بازبینی ادمین قابل مشاهده می ماند.",
        orderPackingTitle: "بسته بندی سفارش",
        noPackingNote: "یادداشت بسته بندی وجود ندارد.",
        vehicleLoadingTitle: "بارگیری وسیله",
        noVehicleLoadingNote: "یادداشت بارگیری وجود ندارد.",
        stockLifecycleTitle: "چرخه موجودی",
        defaultStockFlowNote: "تعداد بسته بندی شده تا زمان ثبت فاکتور در انبار موقت رزرو می ماند.",
        shipmentLinesNote: "شامل محل موجودی، مبدا، کد HS، وزن خالص و بسته تخصیص داده شده است.",
        packageSummaryNote: "برای هر بسته ابعاد، وزن خالص و ناخالص، حجم، جهت و اقلام تخصیص داده شده نمایش داده می شود.",
        loadingSequenceNote: "بسته ها بر اساس حجم و وزن ناخالص مرتب می شوند تا روند واقعی بارگیری را نشان دهند.",
        noShipmentLines: "هنوز ردیف محموله ای تخصیص داده نشده است.",
        noAssignedLines: "هنوز ردیفی تخصیص داده نشده است.",
        noPackageShell: "هنوز قالب بسته ایجاد نشده است.",
        noLoadingSequence: "هنوز توالی بارگیری در دسترس نیست.",
        noPackageBreakdown: "هنوز جزئیات بسته در دسترس نیست.",
        noPackageNote: "یادداشت بسته وجود ندارد.",
        generatedBy: "تولید شده توسط موتور برنامه ریزی انبار Next Master",
        contents: "محتویات",
        dimensions: "ابعاد",
        type: "نوع",
        itemCount: "تعداد کالا",
        scanCode: "کد اسکن",
        barcode: "بارکد",
        qr: "QR",
        packageSticker: "برچسب بسته",
        noPackage: "بسته ای نیست",
        createPackageShellsFirst: "ابتدا قالب های بسته را ایجاد کنید.",
        stickOnOuterFace: "پیش از بارگیری روی سطح بیرونی بچسبانید.",
        fitsInsideVehicle: (remainingWeight, remainingVolume) =>
          `بار در وسیله انتخاب شده جا می گیرد. وزن باقیمانده ${remainingWeight} و حجم باقیمانده ${remainingVolume} هنوز قابل استفاده است.`,
        exceedsVehicleCapacity: (remainingWeight, remainingVolume) =>
          `بار از ظرفیت وسیله انتخاب شده بیشتر است. وزن باقیمانده ${remainingWeight} و حجم باقیمانده ${remainingVolume} اضافه بار را نشان می دهد.`,
        templateTag: (displayName) => `قالب ${displayName}`,
      };
    case "de":
      return {
        packingPlanTitle: "Packliste und Ladeplan",
        packageStickersTitle: "Paketetiketten",
        fallbackSeller: "Next Master",
        packageBreakdownTitle: "Paketinhalt",
        packageBreakdownNote: "Diese Tabelle zeigt genau, was sich in jedem Paket befindet, inklusive Abmessungen und Notizen.",
        packingNotesTitle: "Packhinweise",
        packingNotesHelp: "Betriebsnotizen bleiben sowohl für Lagerpersonal als auch für die Admin-Prüfung sichtbar.",
        orderPackingTitle: "Auftragsverpackung",
        noPackingNote: "Keine Packnotiz.",
        vehicleLoadingTitle: "Fahrzeugverladung",
        noVehicleLoadingNote: "Keine Verlade-Notiz.",
        stockLifecycleTitle: "Bestandszyklus",
        defaultStockFlowNote: "Die gepackte Menge bleibt im temporären Lager reserviert, bis die Rechnung gebucht wird.",
        shipmentLinesNote: "Enthält Lagerort, Ursprung, HS-Code, Nettogewicht und Paketzuordnung.",
        packageSummaryNote: "Jedes Paket zeigt Abmessungen, Netto- und Bruttogewicht, Volumen, Orientierung und zugewiesene Artikel.",
        loadingSequenceNote: "Pakete sind nach Volumen und Bruttogewicht sortiert, um den realen Verladeablauf abzubilden.",
        noShipmentLines: "Noch keine Sendungszeilen zugewiesen.",
        noAssignedLines: "Noch keine Zeilen zugewiesen.",
        noPackageShell: "Es wurde noch keine Pakethülle erstellt.",
        noLoadingSequence: "Noch keine Ladereihenfolge verfügbar.",
        noPackageBreakdown: "Noch kein Paketinhalt verfügbar.",
        noPackageNote: "Keine Paketnotiz.",
        generatedBy: "Erstellt von der Next Master Lagerplanungs-Engine",
        contents: "Inhalt",
        dimensions: "Abmessungen",
        type: "Typ",
        itemCount: "Artikelmenge",
        scanCode: "Scancode",
        barcode: "Barcode",
        qr: "QR",
        packageSticker: "Paketetikett",
        noPackage: "Kein Paket",
        createPackageShellsFirst: "Erstellen Sie zuerst Pakethüllen.",
        stickOnOuterFace: "Vor dem Verladen auf die Außenseite kleben.",
        fitsInsideVehicle: (remainingWeight, remainingVolume) =>
          `Die Ladung passt in das gewählte Fahrzeug. Verbleibendes Gewicht ${remainingWeight} und verbleibendes Volumen ${remainingVolume} sind noch verfügbar.`,
        exceedsVehicleCapacity: (remainingWeight, remainingVolume) =>
          `Die Ladung überschreitet die Kapazität des gewählten Fahrzeugs. Verbleibendes Gewicht ${remainingWeight} und verbleibendes Volumen ${remainingVolume} zeigen eine Überlastung an.`,
        templateTag: (displayName) => `${displayName} Vorlage`,
      };
    case "en":
    default:
      return {
        packingPlanTitle: "Packing List & Loading Plan",
        packageStickersTitle: "Package Stickers",
        fallbackSeller: "Next Master",
        packageBreakdownTitle: "Package Breakdown",
        packageBreakdownNote: "This table shows exactly what is inside each package, with dimensions and notes.",
        packingNotesTitle: "Packing Notes",
        packingNotesHelp: "Operational notes stay visible for both warehouse staff and admin review.",
        orderPackingTitle: "Order Packing",
        noPackingNote: "No packing note.",
        vehicleLoadingTitle: "Vehicle Loading",
        noVehicleLoadingNote: "No vehicle loading note.",
        stockLifecycleTitle: "Stock Lifecycle",
        defaultStockFlowNote: "Packed qty stays reserved in the temporary depot until invoice posting.",
        shipmentLinesNote: "Includes stock location, origin, HS code, net weight, and package assignment.",
        packageSummaryNote: "Each package shows dimensions, gross and net weight, volume, orientation, and assigned items.",
        loadingSequenceNote: "Packages are ordered by volume and gross weight to mirror the loading workflow.",
        noShipmentLines: "No shipment lines assigned yet.",
        noAssignedLines: "No assigned lines",
        noPackageShell: "No package shell created yet.",
        noLoadingSequence: "No loading sequence available yet.",
        noPackageBreakdown: "No package breakdown available yet.",
        noPackageNote: "No package note.",
        generatedBy: "Generated by Next Master warehouse planning engine",
        contents: "Contents",
        dimensions: "Dimensions",
        type: "Type",
        itemCount: "Item Count",
        scanCode: "Scan Code",
        barcode: "Barcode",
        qr: "QR",
        packageSticker: "Package Sticker",
        noPackage: "No package",
        createPackageShellsFirst: "Create package shells first.",
        stickOnOuterFace: "Stick on outer face before loading.",
        fitsInsideVehicle: (remainingWeight, remainingVolume) =>
          `Load fits inside the selected vehicle. Remaining weight ${remainingWeight} and remaining volume ${remainingVolume} are still available.`,
        exceedsVehicleCapacity: (remainingWeight, remainingVolume) =>
          `Load exceeds selected vehicle capacity. Remaining weight ${remainingWeight} and remaining volume ${remainingVolume} indicate overflow.`,
        templateTag: (displayName) => `${displayName} template`,
      };
  }
}

function translateWarehousePackingCommonLabel(language: AppLanguage, key: WarehousePackingCommonLabel) {
  switch (language) {
    case "tr": {
      const labels: Record<WarehousePackingCommonLabel, string> = {
        order: "Sipariş",
        invoice: "Fatura",
        customer: "Müşteri",
        seller: "Satıcı",
        shipDate: "Sevk Tarihi",
        reference: "Referans",
        packageCount: "Paket Sayısı",
        stockFlow: "Stok Akışı",
        template: "Şablon",
        assignedCodes: "Atanan Kodlar",
        hsCode: "GTİP / HS Kod",
        netWeightKg: "Net Ağırlık Kg",
        packageGrossKg: "Paket Brüt Kg",
        packageVolumeM3: "Paket Hacim m3",
      };
      return labels[key];
    }
    case "ru": {
      const labels: Record<WarehousePackingCommonLabel, string> = {
        order: "Заказ",
        invoice: "Счет",
        customer: "Клиент",
        seller: "Продавец",
        shipDate: "Дата отгрузки",
        reference: "Референс",
        packageCount: "Кол-во пакетов",
        stockFlow: "Движение запаса",
        template: "Шаблон",
        assignedCodes: "Назначенные коды",
        hsCode: "HS-код",
        netWeightKg: "Нетто кг",
        packageGrossKg: "Брутто пакета кг",
        packageVolumeM3: "Объем пакета м3",
      };
      return labels[key];
    }
    case "ar": {
      const labels: Record<WarehousePackingCommonLabel, string> = {
        order: "الطلب",
        invoice: "الفاتورة",
        customer: "العميل",
        seller: "البائع",
        shipDate: "تاريخ الشحن",
        reference: "المرجع",
        packageCount: "عدد الطرود",
        stockFlow: "حركة المخزون",
        template: "القالب",
        assignedCodes: "الأكواد المخصصة",
        hsCode: "رمز HS",
        netWeightKg: "الوزن الصافي كغ",
        packageGrossKg: "الوزن الإجمالي للطرد كغ",
        packageVolumeM3: "حجم الطرد م3",
      };
      return labels[key];
    }
    case "fa": {
      const labels: Record<WarehousePackingCommonLabel, string> = {
        order: "سفارش",
        invoice: "فاکتور",
        customer: "مشتری",
        seller: "فروشنده",
        shipDate: "تاریخ ارسال",
        reference: "مرجع",
        packageCount: "تعداد بسته",
        stockFlow: "جریان موجودی",
        template: "قالب",
        assignedCodes: "کدهای تخصیص یافته",
        hsCode: "کد HS",
        netWeightKg: "وزن خالص کیلو",
        packageGrossKg: "وزن ناخالص بسته کیلو",
        packageVolumeM3: "حجم بسته m3",
      };
      return labels[key];
    }
    case "de": {
      const labels: Record<WarehousePackingCommonLabel, string> = {
        order: "Auftrag",
        invoice: "Rechnung",
        customer: "Kunde",
        seller: "Verkäufer",
        shipDate: "Versanddatum",
        reference: "Referenz",
        packageCount: "Paketanzahl",
        stockFlow: "Bestandsfluss",
        template: "Vorlage",
        assignedCodes: "Zugewiesene Codes",
        hsCode: "HS-Code",
        netWeightKg: "Nettogewicht Kg",
        packageGrossKg: "Paket Brutto Kg",
        packageVolumeM3: "Paketvolumen m3",
      };
      return labels[key];
    }
    case "en":
    default: {
      const labels: Record<WarehousePackingCommonLabel, string> = {
        order: "Order",
        invoice: "Invoice",
        customer: "Customer",
        seller: "Seller",
        shipDate: "Ship Date",
        reference: "Reference",
        packageCount: "Package Count",
        stockFlow: "Stock Flow",
        template: "Template",
        assignedCodes: "Assigned Codes",
        hsCode: "HS Code",
        netWeightKg: "Net Weight Kg",
        packageGrossKg: "Package Gross Kg",
        packageVolumeM3: "Package Volume m3",
      };
      return labels[key];
    }
  }
}

function findPackageShipmentLines(input: BuildWarehousePackingHtmlInput, packageLabel: string) {
  return input.shipmentLines.filter((line) => line.packageLabel === packageLabel);
}

function safeText(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeMultiline(value: unknown) {
  return safeText(value).replaceAll("\n", "<br />");
}

function formatNumber(value: number, maximumFractionDigits = 2, locale = "en-US") {
  return Number(value || 0).toLocaleString(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  });
}

function formatWeight(value: number | null | undefined, locale = "en-US") {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return `${formatNumber(Number(value), 3, locale)} kg`;
}

function formatDims(lengthCm: string, widthCm: string, heightCm: string) {
  const dims = [lengthCm, widthCm, heightCm].map((value) => String(value || "").trim() || "-");
  return `${dims[0]} x ${dims[1]} x ${dims[2]} cm`;
}

function escapeAttribute(value: string) {
  return safeText(value).replaceAll("`", "&#96;");
}

function buildPackageCodePayload(input: BuildWarehousePackingHtmlInput, pkg: WarehousePackingPackage) {
  return `ORDER:${input.orderNo || "-"};INVOICE:${input.invoiceNo || "-"};PACKAGE:${pkg.label};TYPE:${pkg.packageType};QTY:${formatNumber(pkg.itemCount, 2, "en-US")}`;
}

function toCode39Text(value: string) {
  const normalized = value
    .toUpperCase()
    .replace(/[^0-9A-Z. \-$/+%]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "PACKAGE";
}

function renderCode39Svg(value: string) {
  const text = `*${toCode39Text(value)}*`;
  const narrow = 2;
  const wide = 5;
  const gap = narrow;
  const barHeight = 56;
  let cursor = 0;
  const bars: string[] = [];

  for (let charIndex = 0; charIndex < text.length; charIndex += 1) {
    const pattern = CODE39_PATTERNS[text[charIndex]] || CODE39_PATTERNS["-"];
    for (let patternIndex = 0; patternIndex < pattern.length; patternIndex += 1) {
      const width = pattern[patternIndex] === "w" ? wide : narrow;
      const isBar = patternIndex % 2 === 0;
      if (isBar) {
        bars.push(`<rect x="${cursor}" y="0" width="${width}" height="${barHeight}" rx="0.5" ry="0.5" fill="#0f172a" />`);
      }
      cursor += width;
    }
    if (charIndex < text.length - 1) cursor += gap;
  }

  const totalWidth = Math.max(cursor, 120);
  return `
    <svg viewBox="0 0 ${totalWidth} 78" xmlns="http://www.w3.org/2000/svg" aria-label="${escapeAttribute(value)}">
      <rect width="${totalWidth}" height="78" fill="#ffffff" />
      ${bars.join("")}
      <text x="${totalWidth / 2}" y="73" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-size="11" letter-spacing="1.6" fill="#0f172a">${safeText(value)}</text>
    </svg>
  `;
}

function renderQrSvg(value: string) {
  const qrcodeApi = QRCode as unknown as {
    create?: (text: string, options?: Record<string, unknown>) => { modules: { size: number; data: boolean[] } };
    default?: {
      create?: (text: string, options?: Record<string, unknown>) => { modules: { size: number; data: boolean[] } };
    };
  };
  const createQr = qrcodeApi.create || qrcodeApi.default?.create;
  if (!createQr) {
    throw new Error("QR encoder unavailable.");
  }
  const qr = createQr(value, {
    errorCorrectionLevel: "M",
    margin: 0,
  });
  const size = qr.modules.size;
  const cell = 4;
  const quiet = 4;
  const total = (size + quiet * 2) * cell;
  const cells: string[] = [];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!qr.modules.data[y * size + x]) continue;
      cells.push(
        `<rect x="${(x + quiet) * cell}" y="${(y + quiet) * cell}" width="${cell}" height="${cell}" fill="#0f172a" />`,
      );
    }
  }

  return `
    <svg viewBox="0 0 ${total} ${total}" xmlns="http://www.w3.org/2000/svg" aria-label="${escapeAttribute(value)}">
      <rect width="${total}" height="${total}" rx="10" ry="10" fill="#ffffff" />
      ${cells.join("")}
    </svg>
  `;
}

const WAREHOUSE_PACKING_THEME_PRESETS: Array<{ match: RegExp; theme: WarehousePackingTheme }> = [
  {
    match: /hengst/i,
    theme: {
      displayName: "Hengst",
      eyebrow: "Hengst Supply Chain",
      accent: "#0f766e",
      accentSoft: "#e6fffb",
      accentInk: "#134e4a",
      accentBorder: "#7dd3c7",
      footerNote: "Prepared with Hengst-aligned warehouse styling.",
    },
  },
  {
    match: /bosch/i,
    theme: {
      displayName: "Bosch",
      eyebrow: "Bosch Distribution",
      accent: "#c2410c",
      accentSoft: "#fff7ed",
      accentInk: "#7c2d12",
      accentBorder: "#fdba74",
      footerNote: "Prepared with Bosch-aligned warehouse styling.",
    },
  },
  {
    match: /mann/i,
    theme: {
      displayName: "MANN",
      eyebrow: "MANN Logistics",
      accent: "#1d4ed8",
      accentSoft: "#eff6ff",
      accentInk: "#1e3a8a",
      accentBorder: "#93c5fd",
      footerNote: "Prepared with MANN-aligned warehouse styling.",
    },
  },
  {
    match: /mahle/i,
    theme: {
      displayName: "MAHLE",
      eyebrow: "MAHLE Logistics",
      accent: "#7c2d12",
      accentSoft: "#fef3c7",
      accentInk: "#78350f",
      accentBorder: "#f59e0b",
      footerNote: "Prepared with MAHLE-aligned warehouse styling.",
    },
  },
];

export function resolveWarehousePackingTheme(sellerCompany: string): WarehousePackingTheme {
  const match = WAREHOUSE_PACKING_THEME_PRESETS.find((preset) => preset.match.test(sellerCompany || ""));
  return (
    match?.theme || {
      displayName: String(sellerCompany || "Next Master"),
      eyebrow: "Warehouse Operations",
      accent: "#2563eb",
      accentSoft: "#eff6ff",
      accentInk: "#1e3a8a",
      accentBorder: "#93c5fd",
      footerNote: "Prepared with the default Next Master warehouse styling.",
    }
  );
}

function translatePackageType(language: AppLanguage, value: string) {
  const t = createWarehousePackingTranslator(language);
  if (value === "carton") return t("inventory.carton");
  if (value === "pallet") return t("inventory.pallet");
  if (value === "crate") return t("inventory.crate");
  if (value === "bundle") return t("inventory.bundle");
  return value || "-";
}

function translateOrientation(language: AppLanguage, value: string) {
  const t = createWarehousePackingTranslator(language);
  if (value === "length-first") return t("inventory.length_first");
  if (value === "width-first") return t("inventory.width_first");
  if (value === "upright") return t("inventory.upright");
  if (value === "stacked") return t("inventory.stacked");
  return value || "-";
}

export function buildWarehousePackingWorkbook(input: BuildWarehousePackingHtmlInput, language: AppLanguage = "en"): WarehousePackingWorkbook {
  const t = createWarehousePackingTranslator(language);
  const copy = getWarehousePackingPrintCopy(language);
  return {
    rows: [
      [copy.packingPlanTitle, input.orderNo || ""],
      [translateWarehousePackingCommonLabel(language, "invoice"), input.invoiceNo || ""],
      [translateWarehousePackingCommonLabel(language, "customer"), input.customerName || "-"],
      [translateWarehousePackingCommonLabel(language, "seller"), input.sellerCompany || copy.fallbackSeller],
      [translateWarehousePackingCommonLabel(language, "shipDate"), input.shipDate || "-"],
      [t("inventory.vehicle"), input.vehicleLabel || "-"],
      [translateWarehousePackingCommonLabel(language, "reference"), input.vehicleReference || ""],
      [t("inventory.order_qty"), input.totalOrderQty],
      [t("inventory.packed_qty"), input.totalPackedQty],
      [translateWarehousePackingCommonLabel(language, "packageCount"), input.packageCount],
      [`${t("inventory.used_volume")} m3`, input.usedVolumeM3],
      [`${t("inventory.remaining_volume")} m3`, input.remainingVolumeM3],
      [`${t("inventory.loaded_gross")} Kg`, input.loadedGrossWeightKg],
      [`${t("inventory.remaining_weight")} Kg`, input.remainingWeightKg],
      [copy.packingNotesTitle, input.packingNotes || ""],
      [translateWarehousePackingCommonLabel(language, "stockFlow"), input.stockFlowNote || ""],
      [t("inventory.load_notes"), input.vehicleNotes || ""],
      [],
      [t("inventory.shipment_lines")],
      [
        t("inventory.code"),
        t("inventory.brand"),
        t("inventory.description_short"),
        t("inventory.shelf_address"),
        t("inventory.section_label"),
        t("inventory.origin_short"),
        translateWarehousePackingCommonLabel(language, "hsCode"),
        translateWarehousePackingCommonLabel(language, "netWeightKg"),
        t("inventory.order_qty"),
        t("inventory.packed_qty"),
        t("inventory.package_label"),
        t("inventory.package_type"),
        t("inventory.length_cm"),
        t("inventory.width_cm"),
        t("inventory.height_cm"),
        t("inventory.load_orientation"),
        translateWarehousePackingCommonLabel(language, "packageGrossKg"),
        translateWarehousePackingCommonLabel(language, "packageVolumeM3"),
      ],
      ...input.shipmentLines.map((line) => {
        const pkg = input.packages.find((candidate) => candidate.label === line.packageLabel);
        return [
          line.code || "-",
          line.brand || "",
          line.description || "",
          line.shelfAddress || "",
          line.sectionCode || "",
          line.origin || "",
          line.hsCode || "",
          line.netWeightKg ?? "",
          Number(line.orderQty || 0),
          Number(line.packedQty || 0),
          line.packageLabel || t("inventory.unassigned"),
          translatePackageType(language, pkg?.packageType || ""),
          pkg?.lengthCm ? Number(pkg.lengthCm) || "" : "",
          pkg?.widthCm ? Number(pkg.widthCm) || "" : "",
          pkg?.heightCm ? Number(pkg.heightCm) || "" : "",
          translateOrientation(language, pkg?.orientation || ""),
          pkg?.grossWeightKg ?? "",
          pkg?.volumeM3 ?? "",
        ];
      }),
      [],
      [t("inventory.package_summary")],
      [
        t("inventory.package_label"),
        copy.type,
        t("inventory.length_cm"),
        t("inventory.width_cm"),
        t("inventory.height_cm"),
        t("inventory.load_orientation"),
        translateWarehousePackingCommonLabel(language, "netWeightKg"),
        t("inventory.gross_weight_kg"),
        t("inventory.volume_m3"),
        copy.itemCount,
        t("inventory.notes"),
        translateWarehousePackingCommonLabel(language, "assignedCodes"),
      ],
      ...input.packages.map((pkg) => [
        pkg.label,
        translatePackageType(language, pkg.packageType),
        Number(pkg.lengthCm || 0) || "",
        Number(pkg.widthCm || 0) || "",
        Number(pkg.heightCm || 0) || "",
        translateOrientation(language, pkg.orientation),
        pkg.netWeightKg,
        pkg.grossWeightKg,
        pkg.volumeM3,
        pkg.itemCount,
        pkg.notes || "",
        pkg.assignedLines.map((line) => `${line.code} x ${line.packedQty}`).join(", "),
      ]),
      [],
      [copy.packageBreakdownTitle],
      [
        t("inventory.package_label"),
        copy.type,
        copy.dimensions,
        t("inventory.load_orientation"),
        copy.contents,
        copy.itemCount,
        translateWarehousePackingCommonLabel(language, "netWeightKg"),
        t("inventory.gross_weight_kg"),
        t("inventory.volume_m3"),
        t("inventory.notes"),
      ],
      ...input.packages.map((pkg) => [
        pkg.label,
        translatePackageType(language, pkg.packageType),
        formatDims(pkg.lengthCm, pkg.widthCm, pkg.heightCm),
        translateOrientation(language, pkg.orientation),
        findPackageShipmentLines(input, pkg.label).length
          ? findPackageShipmentLines(input, pkg.label)
              .map((line) => `${line.code || "-"}${line.description ? ` - ${line.description}` : ""} x ${line.packedQty}`)
              .join(" | ")
          : pkg.assignedLines.length
            ? pkg.assignedLines.map((line) => `${line.code} x ${line.packedQty}`).join(" | ")
            : copy.noAssignedLines,
        pkg.itemCount,
        pkg.netWeightKg,
        pkg.grossWeightKg,
        pkg.volumeM3,
        pkg.notes || "",
      ]),
      [],
      [t("inventory.loading_plan")],
      [t("inventory.load_seq"), t("inventory.package_label"), copy.type, t("inventory.load_orientation"), t("inventory.volume_m3"), t("inventory.gross_weight_kg"), t("inventory.item_qty")],
      ...input.loadingRows.map((row) => [
        row.sequence,
        row.packageLabel,
        translatePackageType(language, row.packageType),
        translateOrientation(language, row.orientation),
        row.volumeM3,
        row.grossWeightKg,
        row.itemQty,
      ]),
    ],
    numericColumns: [1, 2, 3, 7, 8, 9, 11, 12, 13, 15, 16, 17],
  };
}

export function buildWarehousePackingHtml(input: BuildWarehousePackingHtmlInput, language: AppLanguage = "en") {
  const locale = getAppLanguageLocale(language);
  const t = createWarehousePackingTranslator(language);
  const copy = getWarehousePackingPrintCopy(language);
  const theme = resolveWarehousePackingTheme(input.sellerCompany);
  const overCapacity = input.usedVolumeM3 > input.maxVolumeM3 || input.loadedGrossWeightKg > input.maxGrossWeightKg;

  const shipmentRowsHtml = input.shipmentLines.length
    ? input.shipmentLines
        .map(
          (line) => `
            <tr>
              <td>${safeText(line.code || "-")}</td>
              <td>${safeText(line.brand || "-")}</td>
              <td>${safeText(line.description || "-")}</td>
              <td>${safeText(line.shelfAddress || "-")}</td>
              <td>${safeText(line.sectionCode || "-")}</td>
              <td>${safeText(line.origin || "-")}</td>
              <td>${safeText(line.hsCode || "-")}</td>
              <td class="num">${formatWeight(line.netWeightKg, locale)}</td>
              <td class="num">${formatNumber(line.orderQty, 2, locale)}</td>
              <td class="num">${formatNumber(line.packedQty, 2, locale)}</td>
              <td>${safeText(line.packageLabel || t("inventory.unassigned"))}</td>
            </tr>
          `,
        )
        .join("")
    : `<tr><td colspan="11" class="empty-cell">${safeText(copy.noShipmentLines)}</td></tr>`;

  const packageCardsHtml = input.packages.length
    ? input.packages
        .map(
          (pkg) => `
            <div class="package-card">
              <div class="package-card__head">
                <div>
                  <div class="package-card__title">${safeText(pkg.label)}</div>
                  <div class="package-card__meta">${safeText(translatePackageType(language, pkg.packageType))} · ${safeText(formatDims(pkg.lengthCm, pkg.widthCm, pkg.heightCm))}</div>
                </div>
                <div class="package-card__meta">${safeText(t("inventory.load_orientation"))}: ${safeText(translateOrientation(language, pkg.orientation))}</div>
              </div>
              <div class="package-card__stats">
                <div><span>${safeText(copy.itemCount)}</span><strong>${formatNumber(pkg.itemCount, 2, locale)}</strong></div>
                <div><span>${safeText(t("inventory.net_weight_short"))}</span><strong>${formatWeight(pkg.netWeightKg, locale)}</strong></div>
                <div><span>${safeText(t("inventory.gross_weight_kg"))}</span><strong>${formatWeight(pkg.grossWeightKg, locale)}</strong></div>
                <div><span>${safeText(t("inventory.volume"))}</span><strong>${formatNumber(pkg.volumeM3, 2, locale)} m3</strong></div>
              </div>
              <div class="package-card__notes">${pkg.notes ? safeText(pkg.notes) : safeText(copy.noPackageNote)}</div>
              <div class="package-card__lines">
                  ${
                  findPackageShipmentLines(input, pkg.label).length
                    ? findPackageShipmentLines(input, pkg.label)
                        .map(
                          (line) =>
                            `<span class="line-pill">${safeText(line.code || "-")} · ${safeText(line.description || "-")} x ${formatNumber(line.packedQty, 2, locale)}</span>`,
                        )
                        .join("")
                    : pkg.assignedLines.length
                      ? pkg.assignedLines
                          .map(
                            (line) =>
                              `<span class="line-pill">${safeText(line.code)} x ${formatNumber(line.packedQty, 2, locale)}</span>`,
                          )
                          .join("")
                      : `<span class="line-pill line-pill--muted">${safeText(copy.noAssignedLines)}</span>`
                }
              </div>
            </div>
          `,
        )
        .join("")
    : `<div class="empty-block">${safeText(copy.noPackageShell)}</div>`;

  const loadingRowsHtml = input.loadingRows.length
    ? input.loadingRows
        .map(
          (row) => `
            <tr>
              <td class="num">${formatNumber(row.sequence, 0, locale)}</td>
              <td>${safeText(row.packageLabel)}</td>
              <td>${safeText(translatePackageType(language, row.packageType))}</td>
              <td>${safeText(translateOrientation(language, row.orientation))}</td>
              <td class="num">${formatNumber(row.volumeM3, 2, locale)} m3</td>
              <td class="num">${formatWeight(row.grossWeightKg, locale)}</td>
              <td class="num">${formatNumber(row.itemQty, 2, locale)}</td>
            </tr>
          `,
        )
        .join("")
    : `<tr><td colspan="7" class="empty-cell">${safeText(copy.noLoadingSequence)}</td></tr>`;

  const packageBreakdownHtml = input.packages.length
    ? input.packages
        .map(
          (pkg) => `
            <tr>
              <td>${safeText(pkg.label)}</td>
              <td>${safeText(translatePackageType(language, pkg.packageType))}</td>
              <td>${safeText(formatDims(pkg.lengthCm, pkg.widthCm, pkg.heightCm))}</td>
              <td>${safeText(translateOrientation(language, pkg.orientation))}</td>
              <td>
                <div class="breakdown-contents">
                  ${
                    findPackageShipmentLines(input, pkg.label).length
                      ? findPackageShipmentLines(input, pkg.label)
                          .map(
                            (line) =>
                              `<div class="breakdown-contents__line">${safeText(line.code || "-")} ${line.description ? `- ${safeText(line.description)}` : ""} x ${formatNumber(line.packedQty, 2, locale)}</div>`,
                          )
                          .join("")
                      : pkg.assignedLines.length
                        ? pkg.assignedLines
                            .map(
                              (line) =>
                                `<div class="breakdown-contents__line">${safeText(line.code)} x ${formatNumber(line.packedQty, 2, locale)}</div>`,
                            )
                            .join("")
                        : `<div class="breakdown-contents__line breakdown-contents__line--muted">${safeText(copy.noAssignedLines)}</div>`
                  }
                </div>
              </td>
              <td class="num">${formatNumber(pkg.itemCount, 2, locale)}</td>
              <td class="num">${formatWeight(pkg.netWeightKg, locale)}</td>
              <td class="num">${formatWeight(pkg.grossWeightKg, locale)}</td>
              <td class="num">${formatNumber(pkg.volumeM3, 2, locale)} m3</td>
              <td>${safeText(pkg.notes || copy.noPackageNote)}</td>
            </tr>
          `,
        )
        .join("")
    : `<tr><td colspan="10" class="empty-cell">${safeText(copy.noPackageBreakdown)}</td></tr>`;

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${safeText(input.orderNo || "packing-loading-plan")}</title>
      <style>
        :root {
          --packing-accent: ${theme.accent};
          --packing-accent-soft: ${theme.accentSoft};
          --packing-accent-ink: ${theme.accentInk};
          --packing-accent-border: ${theme.accentBorder};
        }
        @page { margin: 24mm 12mm 18mm; }
        body { font-family: "Helvetica Neue", Arial, sans-serif; color: #172033; margin: 0; background: #f5f7fb; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .document-header {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 10;
          padding: 7mm 12mm 5mm;
          background: linear-gradient(180deg, rgba(245, 247, 251, 0.98), rgba(245, 247, 251, 0.88));
          border-bottom: 1px solid rgba(216, 224, 236, 0.95);
          box-sizing: border-box;
        }
        .document-header__row { display:flex; justify-content:space-between; gap: 8mm; align-items:flex-end; }
        .document-header__title { font-size: 13.5pt; font-weight: 800; letter-spacing: -0.03em; color: #162033; margin: 0; }
        .document-header__subtitle { font-size: 7.8pt; color: #607089; margin-top: 1mm; }
        .document-header__meta { display:flex; gap: 5mm; align-items:center; flex-wrap:wrap; font-size: 7.6pt; color: #334155; }
        .document-header__meta strong { color: var(--packing-accent-ink); font-weight: 800; }
        .page { padding: 22mm 8mm 14mm; }
        .page__strip { height: 3.5mm; border-radius: 999px; background: linear-gradient(90deg, var(--packing-accent), var(--packing-accent-border)); margin-bottom: 6mm; }
        .hero { display:flex; justify-content:space-between; gap:10mm; align-items:flex-start; margin-bottom:7mm; }
        .hero__title { font-size: 19pt; font-weight: 700; line-height: 1.05; letter-spacing: -0.03em; margin: 0; }
        .hero__eyebrow { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.14em; color: var(--packing-accent-ink); margin-bottom: 2mm; }
        .hero__subtitle { margin-top: 2mm; font-size: 9pt; color: #4b5a73; }
        .hero__meta { min-width: 58mm; background: #ffffff; border: 1px solid #d8e0ec; border-radius: 16px; padding: 4mm; }
        .meta-row { display:grid; grid-template-columns: 22mm 1fr; gap: 3mm; font-size: 8pt; margin-bottom: 1.5mm; }
        .meta-row:last-child { margin-bottom: 0; }
        .meta-row span { color: #66758d; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
        .meta-row strong { color: #162033; }
        .meta-row--theme strong { color: var(--packing-accent-ink); }
        .summary-grid { display:grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4mm; margin-bottom: 6mm; }
        .summary-card { background: #ffffff; border: 1px solid #d8e0ec; border-top: 2mm solid var(--packing-accent-border); border-radius: 16px; padding: 4mm; }
        .summary-card span { display:block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.08em; color: #6a7890; margin-bottom: 1.2mm; }
        .summary-card strong { display:block; font-size: 12pt; color: #162033; }
        .status-banner { border-radius: 14px; padding: 3.6mm 4mm; margin-bottom: 6mm; font-size: 8.5pt; font-weight: 600; }
        .status-banner--ok { background: var(--packing-accent-soft); color: var(--packing-accent-ink); border: 1px solid var(--packing-accent-border); }
        .status-banner--warn { background: #fff4e6; color: #9b4d14; border: 1px solid #f2c898; }
        .section { background: #ffffff; border: 1px solid #d8e0ec; border-radius: 18px; padding: 5mm; margin-bottom: 5mm; page-break-inside: avoid; break-inside: avoid; }
        .section__head { display:flex; justify-content:space-between; gap: 4mm; align-items:flex-start; margin-bottom: 4mm; }
        .section__title { margin: 0; font-size: 13pt; font-weight: 700; letter-spacing: -0.02em; color: #162033; }
        .section__note { font-size: 8pt; color: #607089; margin-top: 1mm; }
        .notes-grid { display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 4mm; }
        .note-box { border: 1px solid #d8e0ec; border-radius: 14px; background: #f9fbff; padding: 3.5mm; min-height: 16mm; font-size: 8.3pt; line-height: 1.45; }
        .note-box__title { font-size: 7.3pt; text-transform: uppercase; letter-spacing: 0.08em; color: #6a7890; margin-bottom: 1.5mm; font-weight: 700; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        thead { display: table-header-group; }
        tbody { display: table-row-group; }
        th, td { border: 1px solid #dbe3ef; padding: 2.1mm 2.4mm; text-align: left; vertical-align: top; font-size: 8pt; }
        th { background: #eff4fb; color: #3d4a61; text-transform: uppercase; letter-spacing: 0.05em; font-size: 7.1pt; }
        td.num, th.num { text-align: right; white-space: nowrap; }
        tr { break-inside: avoid; page-break-inside: avoid; }
        .empty-cell { text-align: center; color: #73839b; background: #fbfcff; }
        .package-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4mm; break-inside: avoid; page-break-inside: avoid; }
        .package-card { border: 1px solid #d8e0ec; border-top: 2mm solid var(--packing-accent-border); border-radius: 16px; background: #fbfcff; padding: 4mm; break-inside: avoid; page-break-inside: avoid; }
        .package-card__head { display:flex; justify-content:space-between; gap: 4mm; margin-bottom: 3mm; }
        .package-card__title { font-size: 11pt; font-weight: 700; color: var(--packing-accent-ink); }
        .package-card__meta { font-size: 7.7pt; color: #5f6d84; }
        .package-card__stats { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2.5mm; margin-bottom: 3mm; }
        .package-card__stats div { border: 1px solid #dde5f1; border-radius: 12px; background: #fff; padding: 2.4mm; }
        .package-card__stats span { display:block; font-size: 6.9pt; color: #6a7890; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.8mm; }
        .package-card__stats strong { display:block; font-size: 9.6pt; color: #172033; }
        .package-card__notes { font-size: 8pt; line-height: 1.4; color: #425067; margin-bottom: 3mm; min-height: 8mm; }
        .package-card__lines { display:flex; flex-wrap:wrap; gap: 2mm; }
        .line-pill { display:inline-flex; align-items:center; border-radius: 999px; border: 1px solid #d7e0ed; padding: 1.2mm 2.3mm; font-size: 7.3pt; background: #fff; color: #213047; }
        .line-pill--muted { color: #6c7b93; background: #f7f9fc; }
        .breakdown-contents { display:flex; flex-direction:column; gap:1mm; }
        .breakdown-contents__line { font-size:7.2pt; line-height:1.28; color:#213047; }
        .breakdown-contents__line--muted { color:#6c7b93; }
        .empty-block { border: 1px dashed #d7e0ed; border-radius: 16px; padding: 8mm; text-align: center; color: #6c7b93; font-size: 8.4pt; }
        .footer { margin-top: 4mm; font-size: 7.4pt; color: #71819a; text-align: right; }
        .footer-template-note { margin-top: 1mm; font-size: 7.1pt; color: var(--packing-accent-ink); text-align: right; }
        @media print {
          body { background: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .page { padding: 0; }
        }
      </style>
    </head>
    <body>
      <header class="document-header">
        <div class="document-header__row">
          <div>
            <h1 class="document-header__title">${safeText(copy.packingPlanTitle)}</h1>
            <div class="document-header__subtitle">${safeText(input.customerName || "-")} · ${safeText(input.sellerCompany || copy.fallbackSeller)}</div>
          </div>
          <div class="document-header__meta">
            <span>${safeText(translateWarehousePackingCommonLabel(language, "order"))} <strong>${safeText(input.orderNo || "-")}</strong></span>
            <span>${safeText(translateWarehousePackingCommonLabel(language, "invoice"))} <strong>${safeText(input.invoiceNo || t("inventory.pending"))}</strong></span>
            <span>${safeText(t("inventory.date"))} <strong>${safeText(input.shipDate || "-")}</strong></span>
          </div>
        </div>
      </header>
      <div class="page">
        <section class="hero">
          <div>
            <div class="hero__eyebrow">${safeText(theme.eyebrow)}</div>
            <h1 class="hero__title">${safeText(copy.packingPlanTitle)}</h1>
            <div class="hero__subtitle">${safeText(input.customerName || "-")} · ${safeText(input.sellerCompany || copy.fallbackSeller)}</div>
          </div>
          <div class="hero__meta">
            <div class="meta-row"><span>${safeText(translateWarehousePackingCommonLabel(language, "order"))}</span><strong>${safeText(input.orderNo || "-")}</strong></div>
            <div class="meta-row"><span>${safeText(translateWarehousePackingCommonLabel(language, "invoice"))}</span><strong>${safeText(input.invoiceNo || t("inventory.pending"))}</strong></div>
            <div class="meta-row"><span>${safeText(t("inventory.date"))}</span><strong>${safeText(input.shipDate || "-")}</strong></div>
            <div class="meta-row"><span>${safeText(t("inventory.vehicle"))}</span><strong>${safeText(input.vehicleLabel || "-")}</strong></div>
            <div class="meta-row"><span>${safeText(translateWarehousePackingCommonLabel(language, "reference"))}</span><strong>${safeText(input.vehicleReference || "-")}</strong></div>
            <div class="meta-row meta-row--theme"><span>${safeText(translateWarehousePackingCommonLabel(language, "template"))}</span><strong>${safeText(theme.displayName)}</strong></div>
          </div>
        </section>

        <section class="summary-grid">
          <div class="summary-card"><span>${safeText(t("inventory.order_qty"))}</span><strong>${formatNumber(input.totalOrderQty, 2, locale)}</strong></div>
          <div class="summary-card"><span>${safeText(t("inventory.packed_qty"))}</span><strong>${formatNumber(input.totalPackedQty, 2, locale)}</strong></div>
          <div class="summary-card"><span>${safeText(t("inventory.packages"))}</span><strong>${formatNumber(input.packageCount, 0, locale)}</strong></div>
          <div class="summary-card"><span>${safeText(t("inventory.used_volume"))}</span><strong>${formatNumber(input.usedVolumeM3, 2, locale)} m3</strong></div>
          <div class="summary-card"><span>${safeText(t("inventory.loaded_gross"))}</span><strong>${formatWeight(input.loadedGrossWeightKg, locale)}</strong></div>
          <div class="summary-card"><span>${safeText(t("inventory.remaining_volume"))}</span><strong>${formatNumber(input.remainingVolumeM3, 2, locale)} m3</strong></div>
        </section>

        <div class="status-banner ${overCapacity ? "status-banner--warn" : "status-banner--ok"}">
          ${
            overCapacity
              ? safeText(copy.exceedsVehicleCapacity(formatWeight(input.remainingWeightKg, locale), `${formatNumber(input.remainingVolumeM3, 2, locale)} m3`))
              : safeText(copy.fitsInsideVehicle(formatWeight(input.remainingWeightKg, locale), `${formatNumber(input.remainingVolumeM3, 2, locale)} m3`))
          }
        </div>

        <section class="section">
          <div class="section__head">
            <div>
              <h2 class="section__title">${safeText(copy.packingNotesTitle)}</h2>
              <div class="section__note">${safeText(copy.packingNotesHelp)}</div>
            </div>
          </div>
          <div class="notes-grid">
            <div class="note-box">
              <div class="note-box__title">${safeText(copy.orderPackingTitle)}</div>
              ${input.packingNotes ? safeMultiline(input.packingNotes) : safeText(copy.noPackingNote)}
            </div>
            <div class="note-box">
              <div class="note-box__title">${safeText(copy.vehicleLoadingTitle)}</div>
              ${input.vehicleNotes ? safeMultiline(input.vehicleNotes) : safeText(copy.noVehicleLoadingNote)}
            </div>
            <div class="note-box">
              <div class="note-box__title">${safeText(copy.stockLifecycleTitle)}</div>
              ${input.stockFlowNote ? safeMultiline(input.stockFlowNote) : safeText(copy.defaultStockFlowNote)}
            </div>
          </div>
        </section>

        <section class="section">
          <div class="section__head">
            <div>
              <h2 class="section__title">${safeText(t("inventory.shipment_lines"))}</h2>
              <div class="section__note">${safeText(copy.shipmentLinesNote)}</div>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th style="width: 10%;">${safeText(t("inventory.code"))}</th>
                <th style="width: 7%;">${safeText(t("inventory.brand"))}</th>
                <th style="width: 18%;">${safeText(t("inventory.description_short"))}</th>
                <th style="width: 9%;">${safeText(t("inventory.shelf_address"))}</th>
                <th style="width: 7%;">${safeText(t("inventory.section_label"))}</th>
                <th style="width: 8%;">${safeText(t("inventory.origin_short"))}</th>
                <th style="width: 8%;">${safeText(translateWarehousePackingCommonLabel(language, "hsCode"))}</th>
                <th class="num" style="width: 9%;">${safeText(t("inventory.net_weight_short"))}</th>
                <th class="num" style="width: 7%;">${safeText(t("inventory.order_qty"))}</th>
                <th class="num" style="width: 7%;">${safeText(t("inventory.packed_qty"))}</th>
                <th style="width: 10%;">${safeText(t("inventory.package_label"))}</th>
              </tr>
            </thead>
            <tbody>${shipmentRowsHtml}</tbody>
          </table>
        </section>

        <section class="section">
          <div class="section__head">
            <div>
              <h2 class="section__title">${safeText(t("inventory.package_summary"))}</h2>
              <div class="section__note">${safeText(copy.packageSummaryNote)}</div>
            </div>
          </div>
          <div class="package-grid">${packageCardsHtml}</div>
        </section>

        <section class="section">
          <div class="section__head">
            <div>
              <h2 class="section__title">${safeText(copy.packageBreakdownTitle)}</h2>
              <div class="section__note">${safeText(copy.packageBreakdownNote)}</div>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th style="width: 8%;">${safeText(t("inventory.package_label"))}</th>
                <th style="width: 8%;">${safeText(copy.type)}</th>
                <th style="width: 12%;">${safeText(copy.dimensions)}</th>
                <th style="width: 14%;">${safeText(t("inventory.load_orientation"))}</th>
                <th style="width: 26%;">${safeText(copy.contents)}</th>
                <th class="num" style="width: 8%;">${safeText(t("inventory.item_qty"))}</th>
                <th class="num" style="width: 8%;">${safeText(t("inventory.net_weight_short"))}</th>
                <th class="num" style="width: 8%;">${safeText(t("inventory.gross_weight_kg"))}</th>
                <th class="num" style="width: 8%;">${safeText(t("inventory.volume"))}</th>
                <th style="width: 8%;">${safeText(t("inventory.notes"))}</th>
              </tr>
            </thead>
            <tbody>${packageBreakdownHtml}</tbody>
          </table>
        </section>

        <section class="section">
          <div class="section__head">
            <div>
              <h2 class="section__title">${safeText(t("inventory.loading_plan"))}</h2>
              <div class="section__note">${safeText(copy.loadingSequenceNote)}</div>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th class="num" style="width: 9%;">${safeText(t("inventory.load_seq"))}</th>
                <th style="width: 18%;">${safeText(t("inventory.package_label"))}</th>
                <th style="width: 15%;">${safeText(copy.type)}</th>
                <th style="width: 18%;">${safeText(t("inventory.load_orientation"))}</th>
                <th class="num" style="width: 14%;">${safeText(t("inventory.volume"))}</th>
                <th class="num" style="width: 14%;">${safeText(t("inventory.gross_weight_kg"))}</th>
                <th class="num" style="width: 12%;">${safeText(t("inventory.item_qty"))}</th>
              </tr>
            </thead>
            <tbody>${loadingRowsHtml}</tbody>
          </table>
        </section>

        <div class="footer">${safeText(copy.generatedBy)}</div>
        <div class="footer-template-note">${safeText(theme.footerNote)}</div>
      </div>
    </body>
  </html>`;
}

export function buildWarehousePackageLabelsHtml(
  input: BuildWarehousePackingHtmlInput,
  options?: BuildWarehousePackageLabelsOptions,
  language: AppLanguage = "en",
) {
  const locale = getAppLanguageLocale(language);
  const t = createWarehousePackingTranslator(language);
  const copy = getWarehousePackingPrintCopy(language);
  const theme = resolveWarehousePackingTheme(input.sellerCompany);
  const layout = options?.layout || "a4_single";
  const codeMode = options?.codeMode || "both";
  const selectedPackages = options?.packageLabels?.length
    ? input.packages.filter((pkg) => options.packageLabels?.includes(pkg.label))
    : input.packages;
  const labelsPerSheet = layout === "a6" || layout === "a4_single" ? 1 : layout === "a4_2up" ? 2 : 4;

  function renderSticker(pkg: WarehousePackingPackage) {
    const contents = findPackageShipmentLines(input, pkg.label);
    const noteText = String(pkg.notes || input.packingNotes || copy.stickOnOuterFace);
    const contentCount = contents.length || pkg.assignedLines.length;
    const longestContentLength = contents.length
      ? contents.reduce((max, line) => Math.max(max, `${line.code || "-"} ${line.description || "-"}`.length), 0)
      : pkg.assignedLines.reduce((max, line) => Math.max(max, `${line.code}`.length), 0);
    const densityClass =
      contentCount >= 6 || noteText.length > 180 || longestContentLength > 84
        ? "sticker--compact-2"
        : contentCount >= 4 || noteText.length > 110 || longestContentLength > 56
          ? "sticker--compact"
          : "";

    const contentHtml = contents.length
      ? contents
          .map(
            (line) => `
                <div class="sticker-contents__item">
                  <strong>${safeText(line.code || "-")}</strong>
                  <span>${safeText(line.description || "-")}</span>
                  <em>x ${formatNumber(line.packedQty, 2, locale)}</em>
                </div>
              `,
          )
          .join("")
      : pkg.assignedLines.length
        ? pkg.assignedLines
            .map(
              (line) => `
                <div class="sticker-contents__item">
                  <strong>${safeText(line.code)}</strong>
                  <span>${safeText(t("inventory.no_description"))}</span>
                  <em>x ${formatNumber(line.packedQty, 2, locale)}</em>
                </div>
              `,
            )
            .join("")
        : `<div class="sticker-contents__item sticker-contents__item--muted">${safeText(copy.noAssignedLines)}</div>`;

    const barcodeValue = toCode39Text(`PKG-${input.orderNo || "ORDER"}-${pkg.label}`);
    const qrValue = buildPackageCodePayload(input, pkg);
    const showBarcode = codeMode === "barcode" || codeMode === "both";
    const showQr = codeMode === "qr" || codeMode === "both";

    return `
      <article class="sticker ${densityClass}">
        <div class="sticker__rail"></div>
        <div class="sticker__head">
          <div>
            <div class="sticker__eyebrow">${safeText(copy.packageSticker)}</div>
            <h1 class="sticker__package">${safeText(pkg.label)}</h1>
            <div class="sticker__subtitle">${safeText(input.customerName || "-")} · ${safeText(input.sellerCompany || copy.fallbackSeller)}</div>
          </div>
          <div class="sticker__order-block">
            <div><span>${safeText(translateWarehousePackingCommonLabel(language, "order"))}</span><strong>${safeText(input.orderNo || "-")}</strong></div>
            <div><span>${safeText(translateWarehousePackingCommonLabel(language, "invoice"))}</span><strong>${safeText(input.invoiceNo || t("inventory.pending"))}</strong></div>
            <div><span>${safeText(t("inventory.date"))}</span><strong>${safeText(input.shipDate || "-")}</strong></div>
          </div>
        </div>

        <div class="sticker__grid">
          <div class="sticker__card">
            <span>${safeText(copy.type)}</span>
            <strong>${safeText(translatePackageType(language, pkg.packageType))}</strong>
          </div>
          <div class="sticker__card">
            <span>${safeText(copy.dimensions)}</span>
            <strong>${safeText(formatDims(pkg.lengthCm, pkg.widthCm, pkg.heightCm))}</strong>
          </div>
          <div class="sticker__card">
            <span>${safeText(t("inventory.load_orientation"))}</span>
            <strong>${safeText(translateOrientation(language, pkg.orientation))}</strong>
          </div>
          <div class="sticker__card">
            <span>${safeText(t("inventory.reference"))}</span>
            <strong>${safeText(input.vehicleReference || input.vehicleLabel || "-")}</strong>
          </div>
          <div class="sticker__card">
            <span>${safeText(t("inventory.item_qty"))}</span>
            <strong>${formatNumber(pkg.itemCount, 2, locale)}</strong>
          </div>
          <div class="sticker__card">
            <span>${safeText(t("inventory.net_weight_short"))} / ${safeText(t("inventory.gross_weight_kg"))}</span>
            <strong>${formatWeight(pkg.netWeightKg, locale)} / ${formatWeight(pkg.grossWeightKg, locale)}</strong>
          </div>
        </div>

        <div class="sticker__section">
          <div class="sticker__section-title">${safeText(copy.contents)}</div>
          <div class="sticker-contents">${contentHtml}</div>
        </div>

        ${
          showBarcode || showQr
            ? `
              <div class="sticker__section sticker__section--codes">
                <div class="sticker__section-title">${safeText(copy.scanCode)}</div>
                <div class="sticker-codes sticker-codes--${codeMode}">
                  ${
                    showBarcode
                      ? `<div class="sticker-code-block"><div class="sticker-code-block__label">${safeText(copy.barcode)}</div>${renderCode39Svg(barcodeValue)}</div>`
                      : ""
                  }
                  ${
                    showQr
                      ? `<div class="sticker-code-block"><div class="sticker-code-block__label">${safeText(copy.qr)}</div>${renderQrSvg(qrValue)}</div>`
                      : ""
                  }
                </div>
              </div>
            `
            : ""
        }

        <div class="sticker__footer">
          <div class="sticker__footer-note">${safeText(noteText)}</div>
          <div class="sticker__footer-tag">${safeText(copy.templateTag(theme.displayName))}</div>
        </div>
      </article>
    `;
  }

  const sheetHtml = selectedPackages.length
    ? selectedPackages
        .map(
          (pkg) => `
            <section class="sticker-sheet sticker-sheet--${layout}">
              ${Array.from({ length: labelsPerSheet }, () => renderSticker(pkg)).join("")}
            </section>
          `,
        )
        .join("")
    : `
      <section class="sticker-sheet sticker-sheet--${layout}">
        <article class="sticker sticker--empty">
          <div class="sticker__eyebrow">${safeText(copy.packageSticker)}</div>
          <h1 class="sticker__package">${safeText(copy.noPackage)}</h1>
          <div class="sticker__subtitle">${safeText(copy.createPackageShellsFirst)}</div>
        </article>
      </section>
    `;

  const pageSize = layout === "a6" ? "105mm 148mm" : "A4";

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${safeText(input.orderNo || "package-stickers")}</title>
      <style>
        :root {
          --sticker-accent: ${theme.accent};
          --sticker-accent-soft: ${theme.accentSoft};
          --sticker-accent-ink: ${theme.accentInk};
          --sticker-accent-border: ${theme.accentBorder};
        }
        @page { size: ${pageSize}; margin: ${layout === "a6" ? "10mm" : layout === "a4_single" ? "9mm 7mm 7mm" : "14mm 10mm 10mm"}; }
        body { margin: 0; font-family: "Helvetica Neue", Arial, sans-serif; background: #ffffff; color: #172033; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .document-header {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 10;
          padding: ${layout === "a4_4up" ? "3.5mm 10mm 2.5mm" : layout === "a4_single" ? "3.2mm 7mm 2.2mm" : "4.5mm 10mm 3.5mm"};
          background: rgba(255, 255, 255, 0.98);
          border-bottom: 1px solid rgba(216, 224, 236, 0.95);
          box-sizing: border-box;
        }
        .document-header__row { display:flex; justify-content:space-between; gap: 6mm; align-items:flex-end; }
        .document-header__title { font-size: ${layout === "a4_4up" ? "10pt" : layout === "a4_single" ? "11.4pt" : "13pt"}; font-weight: 800; letter-spacing: -0.03em; color: #162033; margin: 0; }
        .document-header__subtitle { font-size: ${layout === "a4_4up" ? "5.8pt" : layout === "a4_single" ? "6.2pt" : "7.2pt"}; color: #607089; margin-top: 0.5mm; }
        .document-header__meta { display:flex; gap: ${layout === "a4_single" ? "2.6mm" : "3.5mm"}; align-items:center; flex-wrap:wrap; font-size: ${layout === "a4_4up" ? "5.8pt" : layout === "a4_single" ? "6pt" : "6.8pt"}; color: #334155; }
        .document-header__meta strong { color: var(--sticker-accent-ink); font-weight: 800; }
        .sticker-sheet {
          display:grid;
          gap:${layout === "a4_single" ? "4mm" : "6mm"};
          page-break-after: always;
          break-after: page;
          break-inside: avoid;
          page-break-inside: avoid;
          width: 100%;
          box-sizing: border-box;
        }
        .sticker-sheet:last-child { page-break-after: auto; break-after: auto; }
        .sticker-sheet--a4_single { grid-template-columns: 1fr; height: calc(297mm - 18mm); }
        .sticker-sheet--a6 { grid-template-columns: 1fr; height: calc(148mm - 20mm); }
        .sticker-sheet--a4_2up { grid-template-columns: 1fr; grid-template-rows: repeat(2, minmax(0, 1fr)); height: calc(297mm - 24mm); }
        .sticker-sheet--a4_4up { grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(2, minmax(0, 1fr)); height: calc(297mm - 24mm); }
        .sticker {
          border: 0.9mm solid var(--sticker-accent-border);
          border-radius: 7mm;
          background: linear-gradient(180deg, var(--sticker-accent-soft), #ffffff 26%);
          padding: 0;
          overflow: hidden;
          min-height: 0;
          height: 100%;
          box-sizing: border-box;
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .sticker--empty { display:flex; flex-direction:column; justify-content:center; align-items:center; padding:24mm; }
        .sticker__rail { height: ${layout === "a4_4up" ? "5mm" : layout === "a4_single" ? "5.4mm" : "7mm"}; background: linear-gradient(90deg, var(--sticker-accent), var(--sticker-accent-border)); }
        .sticker__head { display:flex; justify-content:space-between; gap:${layout === "a4_single" ? "4mm" : "6mm"}; padding:${layout === "a4_4up" ? "5mm" : layout === "a4_single" ? "5.4mm" : "8mm"} ${layout === "a4_4up" ? "5mm" : layout === "a4_single" ? "6mm" : "8mm"} ${layout === "a4_single" ? "2.8mm" : "4mm"}; }
        .sticker__eyebrow { font-size:${layout === "a4_4up" ? "6.8pt" : layout === "a4_single" ? "7pt" : "8pt"}; font-weight:700; letter-spacing:${layout === "a4_single" ? "0.13em" : "0.16em"}; text-transform:uppercase; color:var(--sticker-accent-ink); margin-bottom:${layout === "a4_single" ? "1mm" : "1.4mm"}; }
        .sticker__package { font-size:${layout === "a4_4up" ? "18pt" : layout === "a4_single" ? "22pt" : "28pt"}; line-height:1; letter-spacing:-0.04em; margin:0 0 1mm; color:#111827; }
        .sticker__subtitle { font-size:${layout === "a4_4up" ? "7.6pt" : layout === "a4_single" ? "8.6pt" : "10pt"}; color:#475569; }
        .sticker__order-block { min-width:${layout === "a4_4up" ? "38mm" : layout === "a4_single" ? "45mm" : "52mm"}; border:0.35mm solid #d8e0ec; border-radius:4.5mm; background:#ffffff; padding:${layout === "a4_4up" ? "2.8mm" : layout === "a4_single" ? "2.8mm" : "4mm"}; display:flex; flex-direction:column; gap:${layout === "a4_single" ? "1.2mm" : "1.8mm"}; }
        .sticker__order-block div { display:flex; flex-direction:column; gap:0.5mm; }
        .sticker__order-block span { font-size:${layout === "a4_4up" ? "5.8pt" : layout === "a4_single" ? "6pt" : "6.8pt"}; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; }
        .sticker__order-block strong { font-size:${layout === "a4_4up" ? "7.6pt" : layout === "a4_single" ? "8pt" : "9pt"}; color:#0f172a; }
        .sticker__grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:${layout === "a4_single" ? "2.2mm" : "3mm"}; padding:0 ${layout === "a4_4up" ? "5mm" : layout === "a4_single" ? "6mm" : "8mm"} ${layout === "a4_single" ? "2.8mm" : "4mm"}; }
        .sticker__card { border:0.35mm solid #d8e0ec; border-radius:4mm; background:#ffffff; padding:${layout === "a4_4up" ? "2.4mm" : layout === "a4_single" ? "2.5mm" : "3.2mm"}; min-height:${layout === "a4_4up" ? "13mm" : layout === "a4_single" ? "13.4mm" : "16mm"}; }
        .sticker__card span { display:block; font-size:${layout === "a4_4up" ? "5.8pt" : layout === "a4_single" ? "5.9pt" : "6.8pt"}; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; margin-bottom:0.6mm; }
        .sticker__card strong { display:block; font-size:${layout === "a4_4up" ? "7.4pt" : layout === "a4_single" ? "7.9pt" : "8.8pt"}; line-height:1.18; color:#0f172a; }
        .sticker__section { padding:0 ${layout === "a4_4up" ? "5mm" : layout === "a4_single" ? "6mm" : "8mm"} ${layout === "a4_single" ? "2.8mm" : "4mm"}; break-inside: avoid; page-break-inside: avoid; }
        .sticker__section--codes { padding-top: 1mm; }
        .sticker__section-title { font-size:${layout === "a4_4up" ? "7.2pt" : layout === "a4_single" ? "7.8pt" : "8.8pt"}; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--sticker-accent-ink); margin-bottom:${layout === "a4_single" ? "1.4mm" : "2mm"}; }
        .sticker-contents { border:0.35mm solid #d8e0ec; border-radius:4.5mm; background:#ffffff; padding:${layout === "a4_4up" ? "2.6mm" : layout === "a4_single" ? "2.6mm" : "3.6mm"}; display:flex; flex-direction:column; gap:${layout === "a4_single" ? "1mm" : "1.5mm"}; }
        .sticker-contents__item { display:grid; grid-template-columns: ${layout === "a4_4up" ? "24mm" : layout === "a4_single" ? "27mm" : "30mm"} 1fr auto; gap:${layout === "a4_single" ? "1.5mm" : "2mm"}; align-items:flex-start; font-size:${layout === "a4_4up" ? "6.8pt" : layout === "a4_single" ? "7.2pt" : "8.2pt"}; line-height:${layout === "a4_single" ? "1.12" : "1.25"}; }
        .sticker-contents__item strong { color:#0f172a; }
        .sticker-contents__item span { color:#334155; }
        .sticker-contents__item em { font-style:normal; font-weight:700; color:var(--sticker-accent-ink); white-space:nowrap; }
        .sticker-contents__item--muted { color:#64748b; display:block; }
        .sticker-codes { display:grid; gap:3mm; align-items:start; }
        .sticker-codes--barcode, .sticker-codes--qr { grid-template-columns: 1fr; }
        .sticker-codes--both { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
        .sticker-code-block { border:0.35mm solid #d8e0ec; border-radius:4.5mm; background:#ffffff; padding:${layout === "a4_4up" ? "2.4mm" : layout === "a4_single" ? "2.5mm" : "3.4mm"}; }
        .sticker-code-block__label { font-size:${layout === "a4_4up" ? "5.8pt" : layout === "a4_single" ? "6pt" : "6.6pt"}; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:#64748b; margin-bottom:1mm; }
        .sticker-code-block svg { width:100%; height:auto; display:block; }
        .sticker__footer { display:flex; justify-content:space-between; gap:${layout === "a4_single" ? "3.5mm" : "5mm"}; align-items:flex-end; padding:${layout === "a4_single" ? "1.6mm" : "2mm"} ${layout === "a4_4up" ? "5mm" : layout === "a4_single" ? "6mm" : "8mm"} ${layout === "a4_4up" ? "5mm" : layout === "a4_single" ? "5.4mm" : "8mm"}; }
        .sticker__footer-note { font-size:${layout === "a4_4up" ? "6.4pt" : layout === "a4_single" ? "6.6pt" : "7.8pt"}; line-height:${layout === "a4_single" ? "1.15" : "1.3"}; color:#475569; flex:1; }
        .sticker__footer-tag { font-size:${layout === "a4_4up" ? "5.8pt" : layout === "a4_single" ? "6pt" : "7pt"}; font-weight:700; color:var(--sticker-accent-ink); text-transform:uppercase; letter-spacing:0.08em; white-space:nowrap; }
        .sticker--compact .sticker__eyebrow { font-size:${layout === "a4_4up" ? "6pt" : layout === "a4_single" ? "6.4pt" : "7.2pt"}; }
        .sticker--compact .sticker__package { font-size:${layout === "a4_4up" ? "16pt" : layout === "a4_single" ? "19pt" : "24pt"}; }
        .sticker--compact .sticker__subtitle { font-size:${layout === "a4_4up" ? "6.6pt" : layout === "a4_single" ? "7.8pt" : "8.8pt"}; }
        .sticker--compact .sticker__card strong { font-size:${layout === "a4_4up" ? "6.8pt" : layout === "a4_single" ? "7.2pt" : "8pt"}; }
        .sticker--compact .sticker-contents { padding:${layout === "a4_4up" ? "2.1mm" : layout === "a4_single" ? "2.2mm" : "3mm"}; gap:1mm; }
        .sticker--compact .sticker-contents__item { font-size:${layout === "a4_4up" ? "6pt" : layout === "a4_single" ? "6.6pt" : "7.4pt"}; line-height:1.1; }
        .sticker--compact .sticker__footer-note { font-size:${layout === "a4_4up" ? "5.8pt" : layout === "a4_single" ? "6pt" : "7pt"}; line-height:1.15; }
        .sticker--compact-2 .sticker__eyebrow { font-size:${layout === "a4_4up" ? "5.4pt" : layout === "a4_single" ? "5.8pt" : "6.6pt"}; }
        .sticker--compact-2 .sticker__package { font-size:${layout === "a4_4up" ? "14pt" : layout === "a4_single" ? "17pt" : "21pt"}; }
        .sticker--compact-2 .sticker__subtitle { font-size:${layout === "a4_4up" ? "6pt" : layout === "a4_single" ? "7.1pt" : "8pt"}; }
        .sticker--compact-2 .sticker__card { padding:${layout === "a4_4up" ? "2mm" : layout === "a4_single" ? "2.1mm" : "2.6mm"}; min-height:${layout === "a4_4up" ? "11mm" : layout === "a4_single" ? "12mm" : "14mm"}; }
        .sticker--compact-2 .sticker__card span { font-size:${layout === "a4_4up" ? "5.2pt" : layout === "a4_single" ? "5.4pt" : "6.2pt"}; }
        .sticker--compact-2 .sticker__card strong { font-size:${layout === "a4_4up" ? "6.2pt" : layout === "a4_single" ? "6.7pt" : "7.2pt"}; line-height:1.1; }
        .sticker--compact-2 .sticker-contents { padding:${layout === "a4_4up" ? "1.8mm" : layout === "a4_single" ? "2mm" : "2.6mm"}; gap:0.7mm; }
        .sticker--compact-2 .sticker-contents__item { font-size:${layout === "a4_4up" ? "5.4pt" : layout === "a4_single" ? "6.1pt" : "6.8pt"}; line-height:1.05; }
        .sticker--compact-2 .sticker__section-title { font-size:${layout === "a4_4up" ? "6.2pt" : layout === "a4_single" ? "7pt" : "7.8pt"}; margin-bottom:1.2mm; }
        .sticker--compact-2 .sticker__footer-note { font-size:${layout === "a4_4up" ? "5.2pt" : layout === "a4_single" ? "5.7pt" : "6.4pt"}; line-height:1.1; }
        .sticker--compact-2 .sticker-code-block { padding:${layout === "a4_4up" ? "2mm" : layout === "a4_single" ? "2.1mm" : "2.8mm"}; }
        @media screen {
          body { margin: 24px; background:#eef3fb; }
          .sticker-sheet { margin-bottom: 24px; }
        }
      </style>
    </head>
    <body>
      <header class="document-header">
        <div class="document-header__row">
          <div>
            <h1 class="document-header__title">${safeText(copy.packageStickersTitle)}</h1>
            <div class="document-header__subtitle">${safeText(input.customerName || "-")} · ${safeText(input.sellerCompany || copy.fallbackSeller)}</div>
          </div>
          <div class="document-header__meta">
            <span>${safeText(translateWarehousePackingCommonLabel(language, "order"))} <strong>${safeText(input.orderNo || "-")}</strong></span>
            <span>${safeText(translateWarehousePackingCommonLabel(language, "invoice"))} <strong>${safeText(input.invoiceNo || t("inventory.pending"))}</strong></span>
            <span>${safeText(t("inventory.date"))} <strong>${safeText(input.shipDate || "-")}</strong></span>
          </div>
        </div>
      </header>
      ${sheetHtml}
    </body>
  </html>`;
}
