import { useEffect, useMemo, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { createCodeReference, deleteCodeReference, fetchCodeReferences, importCodeReferences, inspectCodeReferenceUsage, updateCodeReference } from "../../infrastructure/api/codeReferencesApi";
import { parseCsv } from "../../shared/csv";
import type { BrandOption } from "../../types/brand";
import type { CodeReferenceRow, CodeReferenceUsage } from "../../types/codeReferences";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { downloadCodeReferenceTemplate } from "../../shared/importTemplates";

export function CodeReferencesPage() {
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [rows, setRows] = useState<CodeReferenceRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, CodeReferenceRow>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [savingCreate, setSavingCreate] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createBrandName, setCreateBrandName] = useState("");
  const [importing, setImporting] = useState(false);
  const [rowActionKey, setRowActionKey] = useState("");
  const [oldCodeUsage, setOldCodeUsage] = useState<CodeReferenceUsage | null>(null);
  const [newCodeUsage, setNewCodeUsage] = useState<CodeReferenceUsage | null>(null);
  const [createDraft, setCreateDraft] = useState({
    brand: "",
    old_code: "",
    new_code: "",
    original_number: "",
    reason: "",
  });

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const result = await fetchCloudBrands();
        if (!cancelled) setBrands(result);
      } catch {
        if (!cancelled) setBrands([]);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void reload(submittedSearch);
  }, [submittedSearch]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!showCreateDialog || !createDraft.brand || !createDraft.old_code.trim()) {
        setOldCodeUsage(null);
        return;
      }

      try {
        const usage = await inspectCodeReferenceUsage({
          brand: createDraft.brand,
          code: createDraft.old_code,
        });
        if (!cancelled) setOldCodeUsage(usage);
      } catch {
        if (!cancelled) setOldCodeUsage(null);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [showCreateDialog, createDraft.brand, createDraft.old_code]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!showCreateDialog || !createDraft.brand || !createDraft.new_code.trim()) {
        setNewCodeUsage(null);
        return;
      }

      try {
        const usage = await inspectCodeReferenceUsage({
          brand: createDraft.brand,
          code: createDraft.new_code,
        });
        if (!cancelled) setNewCodeUsage(usage);
      } catch {
        if (!cancelled) setNewCodeUsage(null);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [showCreateDialog, createDraft.brand, createDraft.new_code]);

  const brandOptions = [
    ...brands.map((item) => ({ value: item.name, label: item.name })),
    { value: "__new__", label: "New brand..." },
  ];
  const createValidationMessage = useMemo(() => {
    if (!createDraft.brand) return "Select a brand first.";
    if (createDraft.brand === "__new__" && !createBrandName.trim()) return "Enter the new brand name.";
    if (!createDraft.old_code.trim()) return "Enter the old code.";
    if (!createDraft.new_code.trim()) return "Enter the new code.";
    if (createDraft.old_code.trim().toLowerCase() === createDraft.new_code.trim().toLowerCase()) {
      return "Old Code and New Code cannot be the same.";
    }
    return "";
  }, [createBrandName, createDraft.brand, createDraft.new_code, createDraft.old_code]);

  function renderUsageHint(kind: "old" | "new", usage: CodeReferenceUsage | null) {
    if (!usage) return null;

    if (kind === "old" && usage.matchesNewCode.length) {
      const linked = usage.matchesNewCode[0];
      return (
        <div className="warning-text">
          This code is already used as a current valid code. Old code for it is <strong>{linked.old_code}</strong>.
        </div>
      );
    }

    if (kind === "old" && usage.matchesOldCode.length) {
      const linked = usage.matchesOldCode[0];
      return (
        <div className="warning-text">
          This old code already exists and currently maps to <strong>{linked.new_code}</strong>.
        </div>
      );
    }

    if (kind === "new" && usage.matchesOldCode.length) {
      const linked = usage.matchesOldCode[0];
      return (
        <div className="warning-text">
          This code is already registered as an old code and maps to <strong>{linked.new_code}</strong>.
        </div>
      );
    }

    if (kind === "new" && usage.matchesNewCode.length) {
      const linked = usage.matchesNewCode[0];
      return (
        <div className="info-text">
          This code is already used as a current valid code for old code <strong>{linked.old_code}</strong>.
        </div>
      );
    }

    return null;
  }

  async function reload(nextSearch = submittedSearch) {
    setLoading(true);
    setError("");
    try {
      const result = await fetchCodeReferences(nextSearch);
      setRows(result);
    } catch (caught) {
      setRows([]);
      setError(caught instanceof Error ? caught.message : "Code references load failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateReference() {
    const oldCode = createDraft.old_code.trim();
    const newCode = createDraft.new_code.trim();

    if (createValidationMessage) {
      setError(createValidationMessage);
      actionFeedback.fail(createValidationMessage);
      return;
    }

    try {
      setCreateError("");
      setError("");
      setStatus("");
      setSavingCreate(true);
      actionFeedback.begin(`Creating code reference for ${oldCode}...`);
      const created = await createCodeReference({
        brand: createDraft.brand === "__new__" ? createBrandName.trim() : createDraft.brand,
        old_code: oldCode,
        new_code: newCode,
        original_number: createDraft.original_number.trim() || null,
        reason: createDraft.reason.trim() || null,
      });
      setRows((current) => [created, ...current.filter((row) => row.id !== created.id)]);
      setCreateDraft({ brand: "", old_code: "", new_code: "", original_number: "", reason: "" });
      setCreateBrandName("");
      setShowCreateDialog(false);
      setStatus(`Code reference saved. Quotes will warn for old code ${oldCode} and use ${newCode}.`);
      actionFeedback.succeed(`Code reference saved for ${oldCode}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Code reference create failed";
      setCreateError(message);
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setSavingCreate(false);
    }
  }

  const columns = useMemo(
    () => [
      {
        key: "brand",
        header: "Brand",
        render: (row: CodeReferenceRow) => (
          <select
            className="inline-edit-input"
            value={drafts[row.id]?.brand ?? row.brand}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.id]: { ...(current[row.id] || row), brand: event.target.value },
              }))
            }
          >
            {brandOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ),
      },
      {
        key: "old",
        header: "Old Code",
        render: (row: CodeReferenceRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.id]?.old_code ?? row.old_code}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.id]: { ...(current[row.id] || row), old_code: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "new",
        header: "New Code",
        render: (row: CodeReferenceRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.id]?.new_code ?? row.new_code}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.id]: { ...(current[row.id] || row), new_code: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "original",
        header: "Original Number",
        render: (row: CodeReferenceRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.id]?.original_number ?? row.original_number ?? ""}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.id]: { ...(current[row.id] || row), original_number: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "reason",
        header: "Reason",
        render: (row: CodeReferenceRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.id]?.reason ?? row.reason ?? ""}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.id]: { ...(current[row.id] || row), reason: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "active",
        header: "Active",
        render: (row: CodeReferenceRow) => (
          <select
            className="inline-edit-input"
            value={String(drafts[row.id]?.is_active ?? row.is_active)}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.id]: { ...(current[row.id] || row), is_active: event.target.value === "true" },
              }))
            }
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ),
      },
      {
        key: "actions",
        header: "Actions",
        render: (row: CodeReferenceRow) => (
          <div className="inline-actions">
            <Button
              variant="secondary"
              className="button--compact"
              onClick={async () => {
                try {
                  setError("");
                  setStatus("");
                  setRowActionKey(`save:${row.id}`);
                  const draft = drafts[row.id] || row;
                  actionFeedback.begin(`Saving code reference for ${draft.old_code}...`);
                  await updateCodeReference(row.id, {
                    brand: draft.brand,
                    old_code: draft.old_code,
                    new_code: draft.new_code,
                    original_number: draft.original_number || null,
                    reason: draft.reason || null,
                    is_active: draft.is_active,
                  });
                  await reload(submittedSearch);
                  setStatus(`Code reference updated for ${draft.old_code}.`);
                  actionFeedback.succeed(`Code reference updated for ${draft.old_code}.`);
                } catch (caught) {
                  const message = caught instanceof Error ? caught.message : "Code reference update failed";
                  setError(message);
                  actionFeedback.fail(message);
                } finally {
                  setRowActionKey("");
                }
              }}
              busy={rowActionKey === `save:${row.id}`}
              busyLabel="Saving..."
            >
              Save
            </Button>
            <Button
              variant="secondary"
              className="button--compact danger-button"
              onClick={async () => {
                if (!confirm(`Delete old/new code reference ${row.old_code} -> ${row.new_code}?`)) return;
                try {
                  setError("");
                  setStatus("");
                  setRowActionKey(`delete:${row.id}`);
                  actionFeedback.begin(`Deleting code reference for ${row.old_code}...`);
                  await deleteCodeReference(row.id);
                  await reload(submittedSearch);
                  setStatus(`Code reference deleted for ${row.old_code}.`);
                  actionFeedback.succeed(`Code reference deleted for ${row.old_code}.`);
                } catch (caught) {
                  const message = caught instanceof Error ? caught.message : "Code reference delete failed";
                  setError(message);
                  actionFeedback.fail(message);
                } finally {
                  setRowActionKey("");
                }
              }}
              busy={rowActionKey === `delete:${row.id}`}
              busyLabel="Deleting..."
            >
              Delete
            </Button>
          </div>
        ),
      },
    ],
    [brandOptions, drafts, submittedSearch],
  );

  return (
    <div className="page-stack">
      <section className="section-card">
        <div className="section-card__header section-card__header--row">
          <div>
            <h2>Code References</h2>
            <p>Manage old code to new code supersessions by brand. Quotes will warn only from these approved references.</p>
          </div>
          <div className="toolbar">
            <Input value={search} onChange={setSearch} placeholder="Search code references" />
            <Button onClick={() => setSubmittedSearch(search)}>Search</Button>
            <Button variant="secondary" onClick={() => setShowImportDialog(true)}>
              Import CSV
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setCreateError("");
                setCreateBrandName("");
                setCreateDraft((current) => ({
                  ...current,
                  brand: current.brand || brands[0]?.name || "",
                }));
                setShowCreateDialog(true);
              }}
            >
              Add Reference
            </Button>
          </div>
        </div>
        <div className="section-card__body">
          <div className="meta-row">
            <span>{loading ? "Loading code references..." : `${rows.length.toLocaleString("en-US")} code references loaded`}</span>
            {error ? <span className="error-text">{error}</span> : null}
            {!error && status ? <span className="success-text">{status}</span> : null}
          </div>
          <DataTable rows={rows} columns={columns} emptyText={loading ? "Loading..." : "No code references found"} />
        </div>
      </section>

      {showCreateDialog ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-card__header">
              <div>
                <h3>Add Code Reference</h3>
                <p>Create an approved old-code to new-code mapping for quotes and pricing warnings.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label="Brand"
                value={createDraft.brand}
                options={brandOptions}
                onChange={(value) => {
                  setCreateError("");
                  if (value !== "__new__") setCreateBrandName("");
                  setCreateDraft((current) => ({ ...current, brand: value }));
                }}
              />
              {createDraft.brand === "__new__" ? (
                <Input
                  label="Brand Name"
                  value={createBrandName}
                  onChange={(value) => {
                    setCreateError("");
                    setCreateBrandName(value);
                  }}
                />
              ) : null}
              <Input
                label="Old Code"
                value={createDraft.old_code}
                onChange={(value) => {
                  setCreateError("");
                  setCreateDraft((current) => ({ ...current, old_code: value }));
                }}
              />
              <Input
                label="New Code"
                value={createDraft.new_code}
                onChange={(value) => {
                  setCreateError("");
                  setCreateDraft((current) => ({ ...current, new_code: value }));
                }}
              />
              <Input
                label="Original Number"
                value={createDraft.original_number}
                onChange={(value) => {
                  setCreateError("");
                  setCreateDraft((current) => ({ ...current, original_number: value }));
                }}
              />
              <Input
                label="Reason"
                value={createDraft.reason}
                onChange={(value) => {
                  setCreateError("");
                  setCreateDraft((current) => ({ ...current, reason: value }));
                }}
              />
            </div>
            {renderUsageHint("old", oldCodeUsage)}
            {renderUsageHint("new", newCodeUsage)}
            {createValidationMessage ? <div className="warning-text">{createValidationMessage}</div> : null}
            {createError ? <div className="error-text">{createError}</div> : null}
            <div className="modal-hint">Quotes will only warn about old-to-new code changes when a reference exists here. Original Number helps same-brand matching discipline.</div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setCreateError("");
                  setCreateBrandName("");
                  setShowCreateDialog(false);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleCreateReference()}
                disabled={savingCreate}
                busy={savingCreate}
                busyLabel="Creating..."
              >
                Create Reference
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {showImportDialog ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-card__header">
              <div>
                <h3>Import Code References CSV</h3>
                <p>Accepted columns: Brand, Old_Code, New_Code, Original_Number, Reason, Active.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <label className="field field--full">
                <span className="field__label">File</span>
                <input className="field__input" type="file" accept=".csv,text/csv" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} />
              </label>
              <Input label="Selected file" value={importFile?.name ?? ""} onChange={() => undefined} disabled />
            </div>
            <div className="modal-hint">Duplicate control is automatic. Same brand + old code will update the existing reference instead of creating a duplicate row.</div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadCodeReferenceTemplate();
                  actionFeedback.succeed("Code reference sample template downloaded.");
                }}
              >
                Download Sample Template
              </Button>
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShowImportDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!importFile) return;
                  try {
                    setError("");
                    setStatus("");
                    setImporting(true);
                    actionFeedback.begin("Importing code references...");
                    const text = await importFile.text();
                    const parsed = parseCsv(text);
                    const [header = [], ...dataRows] = parsed;
                    const lowerHeader = header.map((cell) => cell.trim().toLowerCase());
                    const indexOf = (aliases: string[], fallback: number) => {
                      const found = lowerHeader.findIndex((cell) => aliases.includes(cell));
                      return found >= 0 ? found : fallback;
                    };

                    const brandIndex = indexOf(["brand"], 0);
                    const oldCodeIndex = indexOf(["old_code", "old code"], 1);
                    const newCodeIndex = indexOf(["new_code", "new code"], 2);
                    const originalIndex = indexOf(["original_number", "original number", "oem", "oem_no"], 3);
                    const reasonIndex = indexOf(["reason", "note", "notes"], 4);
                    const activeIndex = indexOf(["active", "is_active"], 5);

                    const rowsToImport = dataRows.map((row) => ({
                      brand: String(row[brandIndex] || "").trim(),
                      old_code: String(row[oldCodeIndex] || "").trim(),
                      new_code: String(row[newCodeIndex] || "").trim(),
                      original_number: String(row[originalIndex] || "").trim() || null,
                      reason: String(row[reasonIndex] || "").trim() || null,
                      is_active: String(row[activeIndex] || "true").trim().toLowerCase() !== "false",
                    }));

                    await importCodeReferences(rowsToImport);
                    setImportFile(null);
                    setShowImportDialog(false);
                    await reload(submittedSearch);
                    setStatus("Code references imported successfully.");
                    actionFeedback.succeed("Code references imported successfully.");
                  } catch (caught) {
                    const message = caught instanceof Error ? caught.message : "Code reference import failed";
                    setError(message);
                    actionFeedback.fail(message);
                  } finally {
                    setImporting(false);
                  }
                }}
                disabled={importing || !importFile}
                busy={importing}
                busyLabel="Importing..."
              >
                Import
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
