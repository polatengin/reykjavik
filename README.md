# reykjavik MCP Server

A minimal MCP server built with TypeScript and Node.js over **stdio**.

- **Server name:** `reykjavik`

## Tools

- **Name:** `select_timezone`
- **Description:** Ask the user to choose timezone first.
- **Input (`arguments`):**
  - Interactive behavior: in supporting clients (like VS Code), this tool prompts for timezone selection.
  - `timezone` (fallback for non-elicitation clients): one of `pst`, `est`, `utc`, `european`, `australian`, `other`
  - `custom_timezone` (fallback; required only when `timezone=other`): IANA timezone string (e.g. `Europe/Berlin`)
- **Output (`structuredContent`):**
  - `timezone` (string): selected timezone option
  - `custom_timezone` (string, optional): provided when `timezone=other`
  - `resolved_timezone` (string): resolved IANA timezone

- **Name:** `get_time`
- **Description:** Return current time for timezone provided by `select_timezone`.
- **Input (`arguments`):**
  - `timezone` (required): one of `pst`, `est`, `utc`, `european`, `australian`, `other`
  - `custom_timezone` (required only when `timezone=other`): IANA timezone string
- **Output (`structuredContent`):**
  - `timezone_choice` (string): requested timezone option
  - `timezone` (string): resolved IANA timezone
  - `local_time` (string): formatted current time in selected timezone
  - `utc_iso` (string): current UTC time in ISO 8601 format
  - `epoch_ms` (number): Unix epoch time in milliseconds
- **MCP Apps UI resource:** `ui://reykjavik/time-view.html` (linked via `get_time` metadata)

Preset mapping:
- `pst` -> `America/Los_Angeles`
- `est` -> `America/New_York`
- `utc` -> `UTC`
- `european` -> `Europe/London`
- `australian` -> `Australia/Sydney`

## Run

```bash
npm install
npm run build
npm start
```

## MCP client command

Use the built server entrypoint:

```bash
node /absolute/path/to/mcp-apps/dist/index.js
```
