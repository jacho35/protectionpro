# ProtectionPro MCP server

Lets an AI agent (Claude Desktop, Claude Code, any MCP client) read and update
ProtectionPro projects and run studies. It wraps the REST API through
`clients/python/protectionpro_client.py`.

## Tools

| Tool | |
|---|---|
| `list_projects`, `project_overview`, `list_components`, `get_component`, `list_component_types`, `list_revisions` | read |
| `run_analysis(project_id, kind, params)` | run any `/api/analysis/*` study on the saved project (nothing saved) |
| `update_component_props`, `add_component`, `move_component`, `add_wire`, `rename_project`, `create_revision` | edit |
| `delete_component` (also removes its wires), `delete_wire` | delete |
| `create_project` | project lifecycle |

Every edit/delete saves a revision snapshot first (restore it from the app's
revision history); invalid input (unknown type, prop or port) is rejected before
anything is saved. The server has no tool to delete projects (components and wires only). `PROTECTIONPRO_READONLY=1`
hides every tool in the edit, delete and lifecycle rows.

Component types, ports and default props come from `protectionpro_mcp/component_catalog.json`,
generated from the frontend: after changing `COMPONENT_DEFS` run
`node clients/mcp/build_catalog.mjs`.

## Install (Python ≥ 3.10)

```bash
pip install ./clients/python ./clients/mcp
```

## Configure

Create a dedicated user for the agent (admin-minted invite), then:

```bash
export PROTECTIONPRO_URL=http://localhost:8000
export PROTECTIONPRO_EMAIL=agent@example.com
export PROTECTIONPRO_PASSWORD=...        # logs in again automatically when the 7-day token expires
export PROTECTIONPRO_READONLY=1          # optional: hide the write tools
```

Share only the projects the agent should touch with that user (view or edit).

## Register with a client

Claude Code:
```bash
claude mcp add protectionpro -e PROTECTIONPRO_URL=... -e PROTECTIONPRO_EMAIL=... -e PROTECTIONPRO_PASSWORD=... -- protectionpro-mcp
```

Claude Desktop / other (`mcpServers` JSON):
```json
{"protectionpro": {"command": "protectionpro-mcp",
  "env": {"PROTECTIONPRO_URL": "http://localhost:8000",
          "PROTECTIONPRO_EMAIL": "agent@example.com",
          "PROTECTIONPRO_PASSWORD": "..."}}}
```
