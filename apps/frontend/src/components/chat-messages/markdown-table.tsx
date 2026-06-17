import { useMemo } from 'react';
import { DataTableCard } from '@/components/data-table-card';

interface HastNode {
	type?: string;
	tagName?: string;
	value?: string;
	children?: HastNode[];
}

export function MarkdownTable({ node }: { node?: HastNode }) {
	const { columns, rows } = useMemo(() => extractTable(node), [node]);
	const data = useMemo(
		() => rows.map((cells) => Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? '']))),
		[columns, rows],
	);

	return <DataTableCard columns={columns} data={data} className='-mx-3 my-4' />;
}

function extractTable(node?: HastNode): { columns: string[]; rows: string[][] } {
	if (!node) {
		return { columns: [], rows: [] };
	}

	const thead = childByTag(node, 'thead');
	const tbody = childByTag(node, 'tbody');
	const headerRow = childByTag(thead, 'tr');

	const columns = childrenByTag(headerRow, 'th').map((th) => textOf(th).trim());
	const rows = childrenByTag(tbody, 'tr').map((tr) => childrenByTag(tr, 'td').map((td) => textOf(td).trim()));

	return { columns, rows };
}

const childByTag = (node: HastNode | undefined, tag: string) => node?.children?.find((child) => child.tagName === tag);

const childrenByTag = (node: HastNode | undefined, tag: string) =>
	(node?.children ?? []).filter((child) => child.tagName === tag);

const textOf = (node?: HastNode): string => {
	if (!node) {
		return '';
	}
	if (node.type === 'text') {
		return node.value ?? '';
	}
	return (node.children ?? []).map(textOf).join('');
};
