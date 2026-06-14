# Security

## API Key Permissions

This MCP requires the following Bybit API key permissions:
- **Read**: Required for all data tools
- **Trade**: Required for execution tools (`place_trade`, `close_position`, `manage_position`, `place_option_trade`, `close_option_position`)

**Never enable Withdrawal or Transfer permissions.** This MCP does not use them.

## What is logged

Logging is minimal and goes to **stderr only** (stdout is the MCP transport):

- A startup banner stating which network (testnet/mainnet) the server connects to
- A warning when locally computed option Greeks diverge >5% from Bybit's (possible stale data)
- A warning when an option position with an unparseable symbol is skipped in `get_account_status`

No tool names, parameters, request bodies, or timestamps are logged.

## What is never logged

- API keys or secrets (Bybit error messages are additionally scrubbed of the API key before reaching tool output)
- Request bodies or authentication headers
- Account balances or position details beyond what's returned to the user

## Reporting vulnerabilities

If you discover a security issue, please open a private security advisory on GitHub rather than a public issue. Do not include API keys or account details in any report.
