# URLAutoFill

URLAutoFill embeds websites in the app and can fill configured URL login fields from local passkey profiles when you open them.

## Features

- Save passkey profiles with a URL, display name, and optional sign-in credentials
- Open saved sites in a tab, sidebar pane, or separate window
- Optional automatic sign-in using configured username and password field names
- Insert gate links in notes and open sites from the command palette or ribbon

## Manual installation

1. Download the latest release (`main.js`, `manifest.json`, and `styles.css`).
2. Create a folder named `urlautofill` inside your vault's `.obsidian/plugins/` directory.
3. Copy the three files into that folder.
4. Enable **URLAutoFill** under **Settings → Community plugins**.

## Usage

1. Open **Settings → URLAutoFill** and click **New passkey**.
2. Enter the site URL, name, and optional sign-in details.
3. Open the site from the ribbon icon, command palette, or passkey list.

You can also use the **Create new site** and **List sites** commands.

### Automatic sign-in

When enabled for a passkey, URLAutoFill submits the configured username and password when the page opens. Some sites use non-standard field names; adjust the advanced username and password field names if needed.

### Gate links

Use the editor menu to insert a gate link, or convert an existing link to a gate link. Gate links open the configured site through URLAutoFill.

## Security and privacy

Passkey data (URLs, usernames, and passwords) is stored locally in the plugin settings file inside your vault. It is not sent to a remote service by this plugin.

Do not use URLAutoFill for high-security credentials unless you understand the risk. Embedded pages run in a webview and local settings are not encrypted by default.

## Development

Requirements: Node.js and npm.

```bash
npm install
npm run build
```

For development with automatic rebuilds:

```bash
npm run dev
```

Copy `main.js`, `manifest.json`, and `styles.css` into your test vault's `.obsidian/plugins/urlautofill/` folder, then reload the plugin or restart the app.

Run tests:

```bash
npm test
```

## License

MIT
