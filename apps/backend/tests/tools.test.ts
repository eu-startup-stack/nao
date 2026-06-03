import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/mcp', () => ({
	mcpService: {
		getMcpTools: () => ({}),
	},
}));
vi.mock('../src/agents/tools/story', () => ({ default: {} }));
vi.mock('../src/agents/tools/clarification', () => ({ default: {} }));
vi.mock('../src/agents/tools/display-chart', () => ({ default: {} }));
vi.mock('../src/agents/tools/execute-cube-query', () => ({ default: {} }));
vi.mock('../src/agents/tools/execute-python', () => ({ default: {} }));
vi.mock('../src/agents/tools/execute-sandboxed-code', () => ({ default: {} }));
vi.mock('../src/agents/tools/execute-sql', () => ({ default: {} }));
vi.mock('../src/agents/tools/grep', () => ({ default: {} }));
vi.mock('../src/agents/tools/list', () => ({ default: {} }));
vi.mock('../src/agents/tools/read', () => ({ default: {} }));
vi.mock('../src/agents/tools/read-query-result', () => ({ default: {} }));
vi.mock('../src/agents/tools/search', () => ({ default: {} }));
vi.mock('../src/agents/tools/suggest-follow-ups', () => ({ default: {} }));

import { getTools } from '../src/agents/tools';

describe('getTools', () => {
	it('does not expose the Cube query tool by default', () => {
		const tools = getTools(null, undefined, { mcpEnabled: false });

		expect(Object.keys(tools)).toContain('execute_sql');
		expect(Object.keys(tools)).not.toContain('execute_cube_query');
	});

	it('exposes the Cube query tool when Cube is enabled', () => {
		const tools = getTools(null, undefined, { mcpEnabled: false, cubeEnabled: true });

		expect(Object.keys(tools)).toContain('execute_sql');
		expect(Object.keys(tools)).toContain('execute_cube_query');
	});
});
