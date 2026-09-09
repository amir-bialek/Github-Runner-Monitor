import { SxProps, Theme } from '@mui/material/styles';
import { TableCell, TableSortLabel } from '@mui/material';
import { SortState } from '../utils/sorting';

interface SortableHeadCellProps<Column extends string> {
  column: Column;
  label: string;
  sort: SortState<Column>;
  onSort: (column: Column) => void;
  align?: 'left' | 'right';
  sx?: SxProps<Theme>;
}

function SortableHeadCell<Column extends string>({
  column,
  label,
  sort,
  onSort,
  align,
  sx,
}: SortableHeadCellProps<Column>) {
  const active = sort.column === column;

  return (
    <TableCell
      scope="col"
      align={align}
      sortDirection={active ? sort.direction : false}
      sx={{ fontWeight: 700, ...sx }}
    >
      <TableSortLabel
        active={active}
        direction={active ? sort.direction : 'asc'}
        onClick={() => onSort(column)}
      >
        {label}
      </TableSortLabel>
    </TableCell>
  );
}

export default SortableHeadCell;
