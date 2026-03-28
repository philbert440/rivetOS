---
name: gws
description: Google Workspace CLI (gws) for Gmail, Calendar, Drive, Sheets, Docs, and more. Use when: checking email, managing calendar events, searching Drive, reading/writing spreadsheets, or any Google Workspace operation. Requires GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/root/.secrets/gws-credentials.json
category: tools
tags: google,gmail,calendar,drive,sheets,docs,workspace
---
# gws — Google Workspace CLI

Use `gws` for Gmail, Calendar, Drive, Sheets, Docs, and more. Installed on all ROS agent nodes.

## Auth

Credentials are stored at `/root/.secrets/gws-credentials.json` (OAuth2 refresh token).

```bash
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/root/.secrets/gws-credentials.json
```

Account: `rivetphilbot@gmail.com` (Phil's workspace)

## Command Format

```
gws <service> <resource> [sub-resource] <method> [flags]
```

### Flags
- `--params <JSON>` — URL/query parameters
- `--json <JSON>` — Request body (POST/PATCH/PUT)
- `--format <FMT>` — Output: json (default), table, yaml, csv
- `--page-all` — Auto-paginate (NDJSON)
- `--page-limit <N>` — Max pages (default: 10)

## Gmail

```bash
# List recent messages
gws gmail users messages list --params '{"userId": "me", "maxResults": 10}'

# Search messages
gws gmail users messages list --params '{"userId": "me", "q": "is:unread newer_than:1d", "maxResults": 10}'

# Get a specific message
gws gmail users messages get --params '{"userId": "me", "id": "<messageId>", "format": "full"}'

# Send email
gws gmail users messages send --params '{"userId": "me"}' --json '{"raw": "<base64-encoded-email>"}'
```

### Sending Email Helper
To send email, you need to base64-encode an RFC 2822 message:
```bash
echo -e "To: recipient@example.com\nSubject: Hello\nContent-Type: text/plain\n\nMessage body" | base64 -w 0
```
Then pass as `{"raw": "<base64>"}`.

## Calendar

```bash
# List calendars
gws calendar calendarList list --params '{}'

# List events (next 7 days)
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2025-04-07T00:00:00Z", "timeMax": "2025-04-14T00:00:00Z", "singleEvents": true, "orderBy": "startTime"}'

# Create event
gws calendar events insert --params '{"calendarId": "primary"}' --json '{"summary": "Meeting", "start": {"dateTime": "2025-04-08T10:00:00-04:00"}, "end": {"dateTime": "2025-04-08T11:00:00-04:00"}}'

# Get event details
gws calendar events get --params '{"calendarId": "primary", "eventId": "<eventId>"}'
```

## Drive

```bash
# List files
gws drive files list --params '{"pageSize": 10}'

# Search files
gws drive files list --params '{"q": "name contains '\''report'\''", "pageSize": 10}'

# Get file metadata
gws drive files get --params '{"fileId": "<fileId>"}'

# Download file
gws drive files get --params '{"fileId": "<fileId>", "alt": "media"}' --output /tmp/file.txt
```

## Sheets

```bash
# Get spreadsheet metadata
gws sheets spreadsheets get --params '{"spreadsheetId": "<sheetId>"}'

# Read range
gws sheets spreadsheets.values get --params '{"spreadsheetId": "<sheetId>", "range": "Sheet1!A1:D10"}'

# Write range
gws sheets spreadsheets.values update --params '{"spreadsheetId": "<sheetId>", "range": "Sheet1!A1:B2", "valueInputOption": "USER_ENTERED"}' --json '{"values": [["A","B"],["1","2"]]}'

# Append rows
gws sheets spreadsheets.values append --params '{"spreadsheetId": "<sheetId>", "range": "Sheet1!A:C", "valueInputOption": "USER_ENTERED"}' --json '{"values": [["x","y","z"]]}'
```

## Other Services

```bash
# Docs - get document
gws docs documents get --params '{"documentId": "<docId>"}'

# Tasks - list task lists
gws tasks tasklists list --params '{}'

# People/Contacts
gws people people.connections list --params '{"resourceName": "people/me", "personFields": "names,emailAddresses"}'
```

## Schema Discovery

```bash
# View available methods for a service
gws schema drive.files.list
gws schema gmail.users.messages.list
```

## Available Services

drive, sheets, gmail, calendar, admin-reports, docs, slides, tasks, people, chat, classroom, forms, keep, meet, events, workflow, script

## Notes

- Always set `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` before running
- Output is JSON by default — pipe to `jq` for filtering
- Use `--page-all` for large result sets
- Confirm before sending emails or creating events
- CT114 (Rivet Local) cannot run gws due to GLIBC version — relay through other agents
