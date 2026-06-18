import { Button } from "./Button";
import { Input } from "./Input";
import { Select } from "./Select";
import { translateAppText, type AppLanguage } from "../../../shared/i18n";

type WarehouseBarcodeBindingOption = {
  value: string;
  label: string;
};

type WarehouseBarcodeBindingCandidate = {
  id: string;
  title: string;
  subtitle: string;
  meta: string;
};

type WarehouseBarcodeBindingPanelProps = {
  language?: AppLanguage;
  intro: string;
  barcodeLabel: string;
  barcodeValue: string;
  onBarcodeChange: (value: string) => void;
  barcodePlaceholder: string;
  selectedItemLabel: string;
  selectedItemId: string;
  itemLabel: string;
  itemOptions: WarehouseBarcodeBindingOption[];
  onSelectItem: (value: string) => void;
  suggestedItems: WarehouseBarcodeBindingCandidate[];
  emptySuggestionText: string;
  noteLabel: string;
  noteValue: string;
  onNoteChange: (value: string) => void;
  notePlaceholder: string;
  lastScanValue?: string;
  onUseLastScan?: () => void;
  onSave: () => void;
  saveLabel: string;
  saveBusy?: boolean;
  saveBusyLabel?: string;
  disabled?: boolean;
};

export function WarehouseBarcodeBindingPanel({
  language = "en",
  intro,
  barcodeLabel,
  barcodeValue,
  onBarcodeChange,
  barcodePlaceholder,
  selectedItemLabel,
  selectedItemId,
  itemLabel,
  itemOptions,
  onSelectItem,
  suggestedItems,
  emptySuggestionText,
  noteLabel,
  noteValue,
  onNoteChange,
  notePlaceholder,
  lastScanValue,
  onUseLastScan,
  onSave,
  saveLabel,
  saveBusy = false,
  saveBusyLabel,
  disabled = false,
}: WarehouseBarcodeBindingPanelProps) {
  return (
    <div className="warehouse-binding">
      <div className="warehouse-binding__steps" aria-hidden="true">
        <div className="warehouse-binding__step">
          <span>1</span>
          <strong>{translateAppText(language, "inventory.binding_step_scan_new_barcode")}</strong>
        </div>
        <div className="warehouse-binding__step">
          <span>2</span>
          <strong>{translateAppText(language, "inventory.binding_step_select_correct_item")}</strong>
        </div>
        <div className="warehouse-binding__step">
          <span>3</span>
          <strong>{translateAppText(language, "inventory.binding_step_save_permanent_link")}</strong>
        </div>
      </div>

      <div className="warehouse-binding__summary">
        <div className={`warehouse-binding__summary-card ${barcodeValue ? "warehouse-binding__summary-card--active" : ""}`}>
          <span>{translateAppText(language, "inventory.binding_summary_barcode")}</span>
          <strong>{barcodeValue || translateAppText(language, "inventory.binding_summary_scan_or_type")}</strong>
        </div>
        <div className={`warehouse-binding__summary-card ${selectedItemId ? "warehouse-binding__summary-card--active" : ""}`}>
          <span>{translateAppText(language, "inventory.binding_summary_selected_item")}</span>
          <strong>{selectedItemLabel || translateAppText(language, "inventory.binding_summary_choose_matching_line")}</strong>
        </div>
      </div>

      <div className="warehouse-binding__intro">{intro}</div>

      <div className="settings-grid">
        <Input label={barcodeLabel} value={barcodeValue} onChange={onBarcodeChange} placeholder={barcodePlaceholder} disabled={disabled} />
        <Select label={itemLabel} value={selectedItemId} options={itemOptions} onChange={onSelectItem} />
      </div>

      <div className="warehouse-binding__candidate-block">
        <div className="warehouse-binding__candidate-title">{translateAppText(language, "inventory.binding_suggested_items")}</div>
        {suggestedItems.length ? (
          <div className="warehouse-binding__candidates">
            {suggestedItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`warehouse-binding-candidate ${selectedItemId === item.id ? "warehouse-binding-candidate--selected" : ""}`.trim()}
                onClick={() => onSelectItem(item.id)}
                disabled={disabled}
              >
                <span className="warehouse-binding-candidate__eyebrow">
                  {selectedItemId === item.id
                    ? translateAppText(language, "inventory.binding_selected")
                    : translateAppText(language, "inventory.binding_tap_to_select")}
                </span>
                <strong>{item.title}</strong>
                <span>{item.subtitle}</span>
                <small>{item.meta}</small>
              </button>
            ))}
          </div>
        ) : (
          <div className="warehouse-binding__empty">{emptySuggestionText}</div>
        )}
      </div>

      <div className="customers-form-row customers-form-row--top">
        <div className="customers-form-row__label">{noteLabel}</div>
        <div className="customers-field-wrap customers-field-wrap--full">
          <label className="field customer-field">
            <textarea
              className="field__input field__input--textarea"
              value={noteValue}
              onChange={(event) => onNoteChange(event.target.value)}
              placeholder={notePlaceholder}
            />
          </label>
        </div>
      </div>

      <div className="toolbar toolbar--wrap">
        <Button variant="secondary" onClick={onUseLastScan} disabled={disabled || !lastScanValue || !onUseLastScan}>
          {translateAppText(language, "inventory.use_last_scan")}
        </Button>
        <Button onClick={onSave} busy={saveBusy} busyLabel={saveBusyLabel} disabled={disabled || !barcodeValue.trim() || !selectedItemId}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
