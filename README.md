# Extended Browser

Extended Browser embeds websites in Obsidian and can fill configured URL login fields from local passkey profiles when you open them.

## Features

- Save passkey profiles with a URL, display name, and optional sign-in credentials
- Open saved sites in a tab, a separate window, or a floating window
- Open saved websites in a floating window so you can keep a web page visible while working in notes. To use it, open the Command Palette with Cmd+P and run Toggle floating preview. The floating preview can be resized and includes a back button for navigation.
- Optional automatic sign-in using configured username and password field names
- Insert gate links in notes and open sites from the command palette or ribbon

## Usage

1. Open **Settings → Extended Browser** and click **New passkey**.
2. Enter the site URL, name, and optional sign-in details.
3. Open the site from the ribbon icon, command palette, or passkey list.

You can also use the **Create new site** and **List sites** commands.

### Automatic sign-in

When enabled for a passkey, Extended Browser submits the configured username and password when the page opens. Automatic sign-in is available for supported websites. Google uses official API connection instead of embedded sign-in.

Some sites use non-standard field names; adjust the advanced username and password field names if needed.

### Gate links

Use the editor menu to insert a gate link, or convert an existing link to a gate link. Gate links open the configured site through Extended Browser.

## Security and privacy

Passkey data (URLs, usernames, and passwords) is stored locally in the plugin settings file inside your vault. It is not sent to a remote service by this plugin.

Do not use Extended Browser for high-security credentials unless you understand the risk. Embedded pages run in a webview and local settings are not encrypted by default.

## License

MIT
