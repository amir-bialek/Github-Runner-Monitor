import { useCallback, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export type SortValue = string | number | null;

export interface SortState<Column extends string> {
  column: Column;
  direction: SortDirection;
}

export interface TableSort<Column extends string> {
  sort: SortState<Column>;
  toggle: (column: Column) => void;
}

export function useTableSort<Column extends string>(
  initial: SortState<Column>,
  defaultDirection: (column: Column) => SortDirection = () => 'asc',
): TableSort<Column> {
  const [sort, setSort] = useState<SortState<Column>>(initial);

  const toggle = useCallback(
    (column: Column) => {
      setSort((current) =>
        current.column === column
          ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
          : { column, direction: defaultDirection(column) },
      );
    },
    [defaultDirection],
  );

  return { sort, toggle };
}

export function sortRows<Row, Column extends string>(
  rows: Row[],
  sort: SortState<Column>,
  valueOf: (row: Row, column: Column) => SortValue,
): Row[] {
  return [...rows].sort((a, b) => {
    const left = valueOf(a, sort.column);
    const right = valueOf(b, sort.column);

    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;

    const compared =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        :
          String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });

    return sort.direction === 'asc' ? compared : -compared;
  });
}
