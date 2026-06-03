import type { executeCubeQuery } from '@nao/shared/tools';
import { executeCubeQuery as schemas } from '@nao/shared/tools';

import { ExecuteSqlOutput, renderToModelOutput } from '../../components/tool-outputs';
import { env } from '../../env';
import { ToolContext } from '../../types/tools';
import { createTool } from '../../utils/tools';

export async function executeQuery(
	{ cube_query, database_id }: executeCubeQuery.Input,
	context: ToolContext,
): Promise<executeCubeQuery.Output> {
	const envVars = context.envVars;
	const response = await fetch(`http://localhost:${env.FASTAPI_PORT}/execute_cube_query`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			query: cube_query,
			nao_project_folder: context.projectFolder,
			...(database_id && { database_id }),
			...(Object.keys(envVars).length > 0 && { env_vars: envVars }),
		}),
	});

	if (!response.ok) {
		const errorData = await response.json().catch(() => ({ detail: response.statusText }));
		throw new Error(`Error executing Cube query: ${JSON.stringify(errorData.detail)}`);
	}

	const data = await response.json();
	const id = `query_${crypto.randomUUID().slice(0, 8)}` as const;

	context.queryResults.set(id, { columns: data.columns, data: data.data });

	return {
		_version: '1',
		...data,
		id,
	};
}

export default createTool<executeCubeQuery.Input, executeCubeQuery.Output>({
	description:
		'Execute a Cube semantic layer query JSON object against a Cube connection and return the results. If multiple Cube connections are configured, specify the database_id.',
	inputSchema: schemas.InputSchema,
	outputSchema: schemas.OutputSchema,
	execute: executeQuery,
	toModelOutput: ({ output }) => renderToModelOutput(ExecuteSqlOutput({ output }), output),
});
