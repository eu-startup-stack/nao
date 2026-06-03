from __future__ import annotations

from pathlib import Path

import httpx
from rich.progress import Progress

from nao_core.commands.sync.providers.databases.provider import sync_database
from nao_core.config.base import NaoConfig
from nao_core.config.databases.cube import CubeBackend, CubeConfig, CubeDatabaseContext


def test_cube_config_loads_from_yaml_dict():
    config = NaoConfig.model_validate(
        {
            "project_name": "cube-project",
            "databases": [
                {
                    "name": "cube-prod",
                    "type": "cube",
                    "url": "https://cube.example.com/cubejs-api",
                    "api_token": "secret",
                }
            ],
        }
    )

    db = config.databases[0]
    assert isinstance(db, CubeConfig)
    assert db.get_database_name() == "cube-prod"


def test_cube_backend_discovers_metadata_and_executes_query():
    backend = _backend_with_responses(
        {
            ("GET", "https://cube.example.com/cubejs-api/v1/meta"): {
                "cubes": [
                    {
                        "name": "Orders",
                        "schema": "sales",
                        "dimensions": [{"name": "Orders.status", "type": "string"}],
                        "measures": [{"name": "Orders.count", "type": "number"}],
                    }
                ]
            },
            ("POST", "https://cube.example.com/cubejs-api/v1/load"): {
                "data": [{"Orders.status": "completed", "Orders.count": 12}]
            },
        }
    )

    assert backend.list_schemas() == ["sales"]
    assert backend.list_tables("sales") == ["Orders"]

    df = backend.execute_cube_query({"measures": ["Orders.count"], "dimensions": ["Orders.status"]})

    assert df.to_dict(orient="records") == [{"Orders.status": "completed", "Orders.count": 12}]
    assert df.columns.tolist() == ["Orders.status", "Orders.count"]


def test_cube_context_maps_dimensions_and_measures_to_columns():
    backend = _backend_with_responses(
        {
            ("GET", "https://cube.example.com/cubejs-api/v1/meta"): {
                "cubes": [
                    {
                        "name": "Orders",
                        "title": "Orders cube",
                        "dimensions": [
                            {"name": "Orders.status", "title": "Status", "type": "string"},
                        ],
                        "measures": [
                            {"name": "Orders.count", "title": "Count", "type": "number"},
                        ],
                    }
                ]
            }
        }
    )
    ctx = CubeDatabaseContext(backend, "default", "Orders")

    assert ctx.description() == "Orders cube"
    assert ctx.columns() == [
        {
            "name": "Orders.status",
            "type": "string",
            "nullable": True,
            "description": "Dimension - Status",
        },
        {
            "name": "Orders.count",
            "type": "number",
            "nullable": True,
            "description": "Measure - Count",
        },
    ]


def test_cube_sync_renders_metadata_files(tmp_path: Path, monkeypatch):
    backend = _backend_with_responses(
        {
            ("GET", "https://cube.example.com/cubejs-api/v1/meta"): {
                "cubes": [
                    {
                        "name": "Orders",
                        "dimensions": [{"name": "Orders.status", "type": "string"}],
                        "measures": [{"name": "Orders.count", "type": "number"}],
                    }
                ]
            },
            ("POST", "https://cube.example.com/cubejs-api/v1/load"): {
                "data": [{"Orders.status": "completed", "Orders.count": 12}]
            },
        }
    )
    config = CubeConfig(name="cube-prod", url="https://cube.example.com/cubejs-api", api_token="secret")
    monkeypatch.setattr(CubeConfig, "connect", lambda self: backend)

    with Progress(transient=True) as progress:
        state = sync_database(config, tmp_path, progress)

    table_path = tmp_path / "type=cube" / "database=cube-prod" / "schema=default" / "table=Orders"
    assert state.tables_synced == 1
    assert "Orders.status (string" in (table_path / "columns.md").read_text()
    assert '"Orders.count": 12' in (table_path / "preview.md").read_text()


def _backend_with_responses(responses: dict[tuple[str, str], dict]) -> CubeBackend:
    def handler(request: httpx.Request) -> httpx.Response:
        key = (request.method, str(request.url))
        if key not in responses:
            return httpx.Response(404, json={"error": f"Unhandled request {key}"})
        return httpx.Response(200, json=responses[key])

    client = httpx.Client(transport=httpx.MockTransport(handler))
    return CubeBackend("https://cube.example.com/cubejs-api", "secret", client=client)
