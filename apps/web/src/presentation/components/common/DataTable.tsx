import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import {useInterfaceText} from '../../../i18n/InterfaceText';

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
  rowKey?: (row: T, index: number) => string | number;
  renderRowDetails?: (row: T) => ReactNode;
  externalSort?: { key: string; direction: "asc" | "desc" } | null;
  onExternalSort?: (sort: { key: string; direction: "asc" | "desc" } | null) => void;
};

function getStableRowKey<T>(row: T, index: number) {
  const candidate = row as T & { id?: unknown; lineId?: unknown; code?: unknown; product_code?: unknown };
  const identity = candidate.id || candidate.lineId || candidate.product_code || candidate.code;
  return identity == null || String(identity).trim() === "" ? `row-${index}` : `${String(identity)}-${index}`;
}

export function DataTable<T>({
  rows,
  columns,
  emptyText,
  onRowClick,
  rowClassName,
  className = "",
  wrapClassName = "",
  rowKey,
  renderRowDetails,
  externalSort,
  onExternalSort,
}: DataTableProps<T>) {
  const { t,locale } = useI18n();
  const ui=useInterfaceText();
  const headerText=(header:string)=>locale==='tr'&&header==='No'?'Numara':ui(header);
  const [sortKey, setSortKey] = useState("");
  const [sortDirection, setSortDirection] = useState<"asc" | "">("");
  const resolvedEmptyText = emptyText ?? t("common.noRowsFound");

  const sortedRows = useMemo(() => {
    if (onExternalSort || !sortKey || !sortDirection) return rows;
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
  }, [columns, rows, sortDirection, sortKey, onExternalSort]);

  function handleHeaderClick(column: Column<T>) {
    if (!column.sortValue) return;
    if (onExternalSort) {
      if (externalSort?.key !== column.key) onExternalSort({key:column.key,direction:"asc"});
      else if (externalSort.direction === "asc") onExternalSort({key:column.key,direction:"desc"});
      else onExternalSort(null);
      return;
    }
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
        <div className="empty-state">{ui(resolvedEmptyText)}</div>
      </div>
    );
  }

  return (
    <div className={`table-wrap data-table-shell${wrapClassName ? ` ${wrapClassName}` : ""}`}>
      <table className={`data-table${className ? ` ${className}` : ""}`}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} aria-sort={onExternalSort && externalSort?.key === column.key ? (externalSort.direction === "asc" ? "ascending" : "descending") : undefined}>
                {column.sortValue ? (
                  <button
                    type="button"
                    className={`data-table__sort-button${onExternalSort ? (externalSort?.key === column.key ? " active" : "") : (sortKey === column.key && sortDirection === "asc" ? " active" : "")}`}
                    onClick={() => handleHeaderClick(column)}
                  >
                    <span>{headerText(column.header)}</span>
                    <span className="data-table__sort-indicator" aria-hidden="true">
                      {onExternalSort ? (externalSort?.key === column.key ? (externalSort.direction === "asc" ? "↑" : "↓") : "↕") : (sortKey === column.key && sortDirection === "asc" ? "↑" : "↕")}
                    </span>
                  </button>
                ) : (
                  headerText(column.header)
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, index) => {
            const details = renderRowDetails?.(row);
            return <Fragment key={rowKey ? rowKey(row, index) : getStableRowKey(row, index)}>
            <tr
              onClick={onRowClick ? (event) => handleRowClick(row, event) : undefined}
              className={`${rowClassName?.(row) || ""}${onRowClick ? " data-table__row--clickable" : ""}`}
            >
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
            {details != null ? <tr className="data-table__details-row"><td colSpan={columns.length}>{details}</td></tr> : null}
            </Fragment>;
          })}
        </tbody>
      </table>
    </div>
  );
}
