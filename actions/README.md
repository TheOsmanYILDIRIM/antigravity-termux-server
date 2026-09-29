# External Actions

Antigravity Actions are intentionally data-driven. Action definitions do **not**
belong in `server.js` or the Android app.

## Bundled actions

Repository-managed actions live in this directory as JSON files:

- `agy.json`
- `services.json`
- `agy-auth.json`
- `bridge.json`
- `downloads.json`
- `system.json`
- `updates.json`

Each file contains an `actions` array. Example:

```json
{
  "actions": [
    {
      "id": "example-status",
      "label": "Example durumunu göster",
      "compactLabel": "Durum",
      "category": "Example",
      "icon": "info",
      "order": 10,
      "executable": "/absolute/path/to/example",
      "args": ["status"],
      "schedulable": false,
      "alwaysEnabled": false
    }
  ]
}
```

## Device-local custom actions

Put local definitions in:

```text
~/.config/terminal-hub/actions.d/*.json
```

Local definitions override bundled definitions with the same `id`. This keeps
machine-specific commands out of Git and out of application code.

## Enable/disable filter

`~/.config/terminal-hub/actions.json` contains the enabled action IDs. The
installer creates it from `actions.json.example` if it does not exist.

An action with `"alwaysEnabled": true` remains available even when an older
enabled-list does not contain its ID. This is intended for recovery/update
actions.

## Scheduling

Only actions with:

```json
"schedulable": true
```

are accepted by the schedule API. Android receives this metadata from the
server and does not contain a hardcoded list of action IDs.

Scheduled execution is delegated to the generic:

```text
agy-action-run <action-id>
```

runner, which re-reads the same external registry and enabled manifest before
executing anything.

## Validation

Run:

```bash
node scripts/validate-actions.js
```

The updater and GitHub Actions CI run this validation automatically.
