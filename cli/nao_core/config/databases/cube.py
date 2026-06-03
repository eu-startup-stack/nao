from __future__ import annotations

import json
from typing import Any, Literal

import httpx
import pandas as pd
from pydantic import Field

from nao_core.config.exceptions import InitError
from nao_core.ui import ask_text

from .base import DatabaseConfig, DatabaseTemplate
from .context import DatabaseContext

DEFAULT_SCHEMA = "default"


class CubeBackend:
    """Lightweight backend adapter over the Cube REST API."""

    def __init__(
        self,
        url: str,
        api_token: str,
        *,
        default_schema: str = DEFAULT_SCHEMA,
        headers: dict[str, str] | None = None,
        timeout: float = 30.0,
        client: httpx.Client | None = None,
    ) -> None:
        self._url = url.rstrip("/")
        self._api_token = api_token
        self._default_schema = default_schema
        self._headers = headers or {}
        self._timeout = timeout
        self._client = client or httpx.Client(timeout=timeout)
        self._owns_client = client is None
        self._meta_cache: dict[str, Any] | None = None

    def list_schemas(self) -> list[str]:
        schemas = {self.get_cube_schema(cube) for cube in self.cubes()}
        return sorted(schemas)

    def list_tables(self, database: str) -> list[str]:
        return sorted(cube["name"] for cube in self.cubes() if self.get_cube_schema(cube) == database)

    def get_cube(self, schema: str, table_name: str) -> dict[str, Any]:
        for cube in self.cubes():
            if self.get_cube_schema(cube) == schema and cube.get("name") == table_name:
                return cube
        raise ValueError(f"Cube '{schema}.{table_name}' not found in metadata")

    def get_cube_schema(self, cube: dict[str, Any]) -> str:
        value = cube.get("schema") or cube.get("namespace") or self._default_schema
        return str(value)

    def cubes(self) -> list[dict[str, Any]]:
        meta = self.meta()
        cubes = meta.get("cubes", [])
        if not isinstance(cubes, list):
            raise TypeError("Cube metadata response must contain a 'cubes' list")
        return [cube for cube in cubes if isinstance(cube, dict) and cube.get("name")]

    def meta(self) -> dict[str, Any]:
        if self._meta_cache is None:
            payload = self._request("GET", "/v1/meta")
            if not isinstance(payload, dict):
                raise TypeError("Cube metadata response must be a JSON object")
            self._meta_cache = payload
        return self._meta_cache

    def execute_cube_query(self, query: dict[str, Any]) -> pd.DataFrame:
        payload = query if "query" in query else {"query": query}
        response = self._request("POST", "/v1/load", json=payload)
        data = response.get("data", []) if isinstance(response, dict) else []
        if not isinstance(data, list):
            raise TypeError("Cube load response must contain a 'data' list")
        columns = _query_columns(payload.get("query", {}))
        df = pd.DataFrame(data)
        return df.reindex(columns=columns) if columns else df

    def disconnect(self) -> None:
        if self._owns_client:
            self._client.close()

    def _request(self, method: str, path: str, **kwargs) -> Any:
        headers = {
            "Authorization": self._api_token,
            **self._headers,
        }
        response = self._client.request(
            method,
            f"{self._url}{path}",
            headers=headers,
            timeout=self._timeout,
            **kwargs,
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as e:
            detail = response.text.strip()
            message = f"Cube API request failed with status {response.status_code}"
            raise RuntimeError(f"{message}: {detail}") from e
        return response.json()


class CubeDatabaseContext(DatabaseContext):
    """Cube context using semantic layer metadata and load queries."""

    def __init__(self, conn: CubeBackend, schema: str, table_name: str):
        super().__init__(conn, schema, table_name)
        self._cube_cache: dict[str, Any] | None = None

    @property
    def cube(self) -> dict[str, Any]:
        if self._cube_cache is None:
            self._cube_cache = self._conn.get_cube(self._schema, self._table_name)
        return self._cube_cache

    def columns(self) -> list[dict[str, Any]]:
        if self._columns_cache is None:
            self._columns_cache = [
                self._member_to_column(member, "dimension") for member in self.cube.get("dimensions", [])
            ] + [self._member_to_column(member, "measure") for member in self.cube.get("measures", [])]
        return self._columns_cache

    def row_count(self) -> int:
        if self._row_count_cache is not None:
            return self._row_count_cache

        count_measure = self._first_measure(("count", "number"))
        if not count_measure:
            self._row_count_cache = 0
            return self._row_count_cache

        try:
            df = self._conn.execute_cube_query({"measures": [count_measure]})
            value = df.iloc[0][count_measure] if not df.empty and count_measure in df.columns else 0
            self._row_count_cache = int(value or 0)
        except Exception:
            self._row_count_cache = 0
        return self._row_count_cache

    def preview(self, limit: int = 10) -> list[dict[str, Any]]:
        query = self._preview_query(limit)
        if not query:
            return []
        try:
            df = self._conn.execute_cube_query(query)
        except Exception:
            return []
        return [_json_safe_record(row) for row in df.to_dict(orient="records")]

    def description(self) -> str | None:
        description = self.cube.get("description")
        if description:
            return str(description)
        title = self.cube.get("title")
        return str(title) if title else None

    def profiling(self) -> dict[str, Any] | None:
        return None

    def _preview_query(self, limit: int) -> dict[str, Any] | None:
        dimensions = [member["name"] for member in self.cube.get("dimensions", []) if member.get("name")]
        measures = [member["name"] for member in self.cube.get("measures", []) if member.get("name")]
        query: dict[str, Any] = {"limit": max(0, int(limit))}
        if dimensions:
            query["dimensions"] = dimensions[:5]
        if measures:
            query["measures"] = measures[:1]
        return query if "dimensions" in query or "measures" in query else None

    def _first_measure(self, preferred_types: tuple[str, ...]) -> str | None:
        measures = [member for member in self.cube.get("measures", []) if member.get("name")]
        for preferred_type in preferred_types:
            for member in measures:
                if str(member.get("type", "")).lower() == preferred_type:
                    return str(member["name"])
        return str(measures[0]["name"]) if measures else None

    @staticmethod
    def _member_to_column(member: dict[str, Any], kind: str) -> dict[str, Any]:
        member_type = str(member.get("type") or kind)
        description_parts = [kind.capitalize()]
        if title := member.get("title"):
            description_parts.append(str(title))
        if description := member.get("description"):
            description_parts.append(str(description))
        return {
            "name": str(member.get("name", "")),
            "type": member_type,
            "nullable": True,
            "description": " - ".join(description_parts),
        }


class CubeConfig(DatabaseConfig):
    """Cube semantic layer configuration using the Cube REST API."""

    type: Literal["cube"] = "cube"
    url: str = Field(description="Cube API base URL, for example https://cube.example.com/cubejs-api")
    api_token: str = Field(description="Cube API token")
    default_schema: str = Field(default=DEFAULT_SCHEMA, description="Schema folder name for cubes without a namespace")
    headers: dict[str, str] = Field(default_factory=dict, description="Additional HTTP headers for Cube API requests")
    timeout: float = Field(default=30.0, gt=0, description="Cube API request timeout in seconds")
    templates: list[DatabaseTemplate] = Field(
        default_factory=lambda: [DatabaseTemplate.COLUMNS, DatabaseTemplate.PREVIEW],
        description="Which default templates to render per cube. Defaults to ['columns', 'preview'].",
    )

    @classmethod
    def promptConfig(cls) -> "CubeConfig":
        name = ask_text("Connection name:", default="cube-prod") or "cube-prod"
        url = ask_text("Cube API URL:", default="http://localhost:4000/cubejs-api") or ""
        if not url:
            raise InitError("Cube API URL is required.")
        api_token = ask_text("Cube API token:", password=True, required_field=True)
        default_schema = (
            ask_text("Default schema for cubes without namespace:", default=DEFAULT_SCHEMA) or DEFAULT_SCHEMA
        )
        return CubeConfig(
            name=name,
            url=url,
            api_token=api_token,  # type: ignore[arg-type]
            default_schema=default_schema,
        )

    def connect(self) -> CubeBackend:
        return CubeBackend(
            self.url,
            self.api_token,
            default_schema=self.default_schema,
            headers=self.headers,
            timeout=self.timeout,
        )

    def get_database_name(self) -> str:
        return self.name

    def get_schemas(self, conn: CubeBackend) -> list[str]:
        return conn.list_schemas()

    def create_context(self, conn: CubeBackend, schema: str, table_name: str) -> CubeDatabaseContext:
        return CubeDatabaseContext(conn, schema, table_name)

    def execute_cube_query(self, query: dict[str, Any]) -> pd.DataFrame:
        conn = self.connect()
        try:
            return conn.execute_cube_query(query)
        finally:
            conn.disconnect()

    def execute_sql(self, sql: str) -> pd.DataFrame:
        try:
            query = json.loads(sql)
        except json.JSONDecodeError as e:
            raise ValueError("Cube queries must be JSON objects, not SQL strings") from e
        if not isinstance(query, dict):
            raise ValueError("Cube query JSON must be an object")
        return self.execute_cube_query(query)

    def check_connection(self) -> tuple[bool, str]:
        conn = None
        try:
            conn = self.connect()
            schemas = self.get_schemas(conn)
            cube_count = sum(len(conn.list_tables(schema)) for schema in schemas)
            return True, f"Connected successfully ({cube_count} cubes across {len(schemas)} schemas found)"
        except Exception as e:
            return False, str(e)
        finally:
            if conn is not None:
                conn.disconnect()


def _query_columns(query: Any) -> list[str]:
    if not isinstance(query, dict):
        return []
    columns: list[str] = []
    for key in ("dimensions", "measures", "segments"):
        values = query.get(key, [])
        if isinstance(values, list):
            columns.extend(str(value) for value in values)
    time_dimensions = query.get("timeDimensions", [])
    if isinstance(time_dimensions, list):
        columns.extend(
            str(item["dimension"]) for item in time_dimensions if isinstance(item, dict) and item.get("dimension")
        )
    return columns


def _json_safe_record(row: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in row.items():
        if value is None or isinstance(value, (str, int, float, bool, list, dict)):
            safe[key] = value
        else:
            safe[key] = str(value)
    return safe
