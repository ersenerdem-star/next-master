import type { ReactNode } from "react";

type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
};

type DataTableProps<T> = {
  rows: T[];
  columns: Column<T>[];
  emptyText?: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
};

export function DataTable<T>({ rows, columns, emptyText = "No rows found", onRowClick, rowClassName }: DataTableProps<T>) {
  if (!rows.length) {
    return <div className="empty-state">{emptyText}</div>;
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} onClick={onRowClick ? () => onRowClick(row) : undefined} className={`${rowClassName?.(row) || ""}${onRowClick ? " data-table__row--clickable" : ""}`}>
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
