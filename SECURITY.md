# Security

## API Key Permissions

This MCP requires the following Bybit API key permissions:
- **Read**: Required for all data tools
- **Trade**: Required for execution tools (`place_trade`, `close_position`, `manage_position`, `place_option_trade`, `close_option_position`)

**Never enable Withdrawal or Transfer permissions.** This MCP does not use them.

## What is logged

- Tool names and non-sensitive parameters (symbol, side, qty, orderType)
- Server timestamps
- Error messages from Bybit API responses

## What is never logged

- API keys or secrets
- Full request bodies containing authentication headers
- Account balances or position details beyond what's returned to the user

## Reporting vulnerabilities

If you discover a security issue, please open a private security advisory on GitHub rather than a public issue. Do not include API keys or account details in any report.
