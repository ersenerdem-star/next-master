import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../../i18n/I18nProvider";

type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null | undefined;
};

type DataTableProps<T> = {
  rows: T[];
  columns: Column<T>[];
  emptyText?: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  className?: string;
  wrapClassName?: string;
};

export function DataTable<T>({
  rows,
  columns,
  emptyText,
  onRowClick,
  rowClassName,
  className = "",
  wrapClassName = "",
}: DataTableProps<T>) {
  const { t } = useI18n();
  const [sortKey, setSortKey] = useState("");
  const [sortDirection, setSortDirection] = useState<"asc" | "">("");
  const resolvedEmptyText = emptyText ?? t("common.noRowsFound");

  const sortedRows = useMemo(() => {
    if (!sortKey || !sortDirection) return rows;
    const column = columns.find((item) => item.key === sortKey);
    if (!column?.sortValue) return rows;
    const nextRows = [...rows];
    nextRows.sort((left, right) => {
      const leftValue = column.sortValue?.(left);
      const rightValue = column.sortValue?.(right);
      const leftText = typeof leftValue === "number" ? leftValue : String(leftValue ?? "").trim().toLowerCase();
      const rightText = typeof rightValue === "number" ? rightValue : String(rightValue ?? "").trim().toLowerCase();
      if (leftText === rightText) return 0;
      return leftText > rightText ? 1 : -1;
    });
    return nextRows;
  }, [columns, rows, sortDirection, sortKey]);

  function handleHeaderClick(column: Column<T>) {
    if (!column.sortValue) return;
    if (sortKey !== column.key) {
      setSortKey(column.key);
      setSortDirection("asc");
      return;
    }
    if (sortDirection === "asc") {
      setSortKey("");
      setSortDirection("");
      return;
    }
    setSortDirection("asc");
  }

  function handleRowClick(row: T, event: React.MouseEvent<HTMLTableRowElement>) {
    if (!onRowClick) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button, input, select, textarea, a, label")) {
      return;
    }
    onRowClick(row);
  }

  if (!rows.length) {
    return (
      <div className={`table-wrap data-table-shell${wrapClassName ? ` ${wrapClassName}` : ""}`}>
        <div className="empty-state">{resolvedEmptyText}</div>
      </div>
    );
  }

  return (
    <div className={`table-wrap data-table-shell${wrapClassName ? ` ${wrapClassName}` : ""}`}>
      <table className={`data-table${className ? ` ${className}` : ""}`}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>
                {column.sortValue ? (
                  <button
                    type="button"
                    className={`data-table__sort-button${sortKey === column.key && sortDirection === "asc" ? " active" : ""}`}
                    onClick={() => handleHeaderClick(column)}
                  >
                    <span>{column.header}</span>
                    <span className="data-table__sort-indicator" aria-hidden="true">
                      {sortKey === column.key && sortDirection === "asc" ? "↑" : "↕"}
                    </span>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, index) => (
            <tr key={index} onClick={onRowClick ? (event) => handleRowClick(row, event) : undefined} className={`${rowClassName?.(row) || ""}${onRowClick ? " data-table__row--clickable" : ""}`}>
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
