import { formatCellValue } from '@nao/shared/story-table-utils';

type TableRow = Record<string, unknown>;

const escapeCsvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function tableToCsv(columns: string[], rows: TableRow[]): string {
	return [
		columns.map(escapeCsvCell).join(','),
		...rows.map((row) => columns.map((column) => escapeCsvCell(formatCellValue(row[column]))).join(',')),
	].join('\n');
}

export function tableToTsv(columns: string[], rows: TableRow[]): string {
	const clean = (value: string) => value.replace(/[\t\n]/g, ' ');
	return [
		columns.map(clean).join('\t'),
		...rows.map((row) => columns.map((column) => clean(formatCellValue(row[column]))).join('\t')),
	].join('\n');
}

export function downloadCsv(filename: string, csv: string): void {
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}
