# AxionGraph

Invisible events. Replayable graphs. AxionGraph is an append-only execution-graph event model and deterministic reducer — provider-agnostic, storage is a port.

This repository contains the TypeScript and Python implementations for the AxionGraph primitive. The shared repository keeps the public contract, fixtures, and release history aligned across both languages.

## Packages

- npm: `axiongraph`
- PyPI: `axiongraph`

## Install

```sh
npm install axiongraph
pip install axiongraph
```

## Layout

- `ts/` - TypeScript implementation and npm package.
- `py/` - Python implementation and PyPI package.
- `fixtures/` - Shared conformance and parity fixtures when the primitive needs them.

## Development

Run TypeScript checks from `ts/`:

```sh
pnpm verify
```

Run Python checks from `py/`:

```sh
uv sync --dev
uv run --with ruff ruff check .
uv run --with ruff ruff format --check .
uv run --with ty ty check
uv run --with pytest --with pytest-asyncio python -m pytest
```

## License

MIT
