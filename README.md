<div align="center">

# VSCode z.ai Usage Plus

![Status bar example](./assets/screenshots/statusbar.png)

> [!NOTE]
> This is a fork of [j4rviscmd/vscode-zai-usage](https://github.com/j4rviscmd/vscode-zai-usage) — all credit for the original extension goes to [@j4rviscmd](https://github.com/j4rviscmd). This fork adds weekly quota display and extra display settings under the name **VSCode z.ai Usage Plus**.

[![Latest Release](https://img.shields.io/github/v/release/demartis/vscode-zai-usage?style=for-the-badge&color=green&label=Latest&logo=github&logoColor=white)](https://github.com/demartis/vscode-zai-usage/releases/latest)
[![Last Commit](https://img.shields.io/github/last-commit/demartis/vscode-zai-usage/main?style=for-the-badge&color=1F6FEB&label=Last%20Update&logo=github&logoColor=white)](https://github.com/demartis/vscode-zai-usage/commits/main)
[![License](https://img.shields.io/badge/License-MIT-018FF5?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](LICENSE)

<!-- markdownlint-disable-next-line -->
### Display your [GLM Coding Plan](https://z.ai/subscribe) 5-hour **and weekly** usage directly in the VS Code status bar

</div>

## Features

- Shows both token quota windows side by side: the 5-hour window **and the weekly window** (e.g. `⬡ 45% (2h30m) | Week: 12% (3d12h)`)
- Displays time remaining until each quota resets when available
- Condensed display style for a minimal status bar label (e.g. `⬡ 45% | Week: 12%`)
- Shows usage or remaining tokens (`displayMode`)
- The weekly window can be hidden entirely (`showWeekly`)
- Automatically refreshes at a configurable interval
- Secure API key storage via VS Code Secret Storage

**Status bar examples:**

|                Situation                 |              Display               |
| ---------------------------------------- | ---------------------------------- |
| Authenticated, usage available           | `⬡ 45% (2h30m) | Week: 12% (3d12h)` |
| Authenticated, no reset times            | `⬡ 45% | Week: 12%`                |
| Authenticated, remaining mode            | `⬡ 55% (2h30m) | Week: 88% (3d12h)` |
| Authenticated, condensed style           | `⬡ 45% | Week: 12%`                |
| Authenticated, weekly hidden             | `⬡ 45% (2h30m)`                    |
| No weekly entry in API response          | `⬡ 45% (2h30m)`                    |
| API key not set                          | `⬡ Set API Key`                    |
| Error / fetch failed                     | `⬡ -`                              |

> The `⬡` icon is the z.ai icon. Set `zaiUsagePlus.useIcon: false` to display `z.ai:` as a text prefix instead. The tooltip always shows the full details (percentages, reset countdowns, refresh interval) regardless of display style.

## Setup

1. Get your API token from the [z.ai API Key page](https://z.ai/manage-apikey/apikey-list)
2. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
3. Run **z.ai Usage Plus: Set API Key** and paste your token
4. The status bar will update immediately

## Commands

|               Command               |             Description              |
| ----------------------------------- | ------------------------------------ |
| `z.ai Usage Plus: Set API Key`      | Enter and verify your z.ai API token |
| `z.ai Usage Plus: Clear API Key`    | Remove the stored API token          |
| `z.ai Usage Plus: Refresh Status Bar` | Refresh usage data immediately     |

## Settings

|              Setting               |   Type    |  Default  |                                       Description                                        |
| ---------------------------------- | --------- | --------- | ---------------------------------------------------------------------------------------- |
| `zaiUsagePlus.refreshInterval`     | `number`  | `60`      | Data refresh interval in seconds                                                         |
| `zaiUsagePlus.useIcon`             | `boolean` | `true`    | Use z.ai icon (`⬡`) instead of text prefix `z.ai:`                                       |
| `zaiUsagePlus.displayMode`         | `string`  | `usage`   | Display mode: `"usage"` (e.g. `75.3%`) or `"remaining"` (e.g. `24.7%`)                   |
| `zaiUsagePlus.displayStyle`        | `string`  | `full`    | Label verbosity: `"full"` (e.g. `45% (2h30m)`) or `"condensed"` (e.g. `45%`)             |
| `zaiUsagePlus.showWeekly`          | `boolean` | `true`    | Show the weekly usage alongside the 5-hour usage                                         |
| `zaiUsagePlus.statusBarPriority`   | `number`  | `10000`   | Status bar item priority (higher = further left; requires a window reload)               |

## Requirements

- VS Code 1.85.0 or higher
- A valid z.ai API token

## Credits

Based on [vscode-zai-usage](https://github.com/j4rviscmd/vscode-zai-usage) by [@j4rviscmd](https://github.com/j4rviscmd) (MIT). Weekly usage display, display-style and weekly-visibility settings added by this fork.

## License

> [!WARNING]
> This extension uses an internal z.ai API (`api.z.ai/api/monitor/usage/quota/limit`) which is not officially documented. The API may change without notice, which could break this extension.

MIT
