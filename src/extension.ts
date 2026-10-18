import * as vscode from "vscode";

/**
 * Represents a single usage limit entry returned by the z.ai quota API.
 */
interface ZaiLimit {
  /** The type identifier of the limit (e.g. `"TOKENS_LIMIT"`). */
  type: string;
  /**
   * Window length unit of this limit: `1` = days, `3` = hours, `5` = minutes,
   * `6` = weeks. The weekly quota is the entry with `unit: 6`.
   */
  unit?: number;
  /** The current usage as a decimal percentage (e.g. `0.753` means 75.3 %). */
  percentage: number;
  /** Unix timestamp (ms) at which this limit will reset. */
  nextResetTime: number;
}

/**
 * The top-level response shape returned by the z.ai quota/limit API endpoint.
 */
interface ZaiApiResponse {
  /** Whether the API call succeeded. `false` indicates an application-level error. */
  success?: boolean;
  /** Application-level error code, present when `success` is `false`. */
  code?: number;
  /** Human-readable error message, present when `success` is `false`. */
  msg?: string;
  /** The payload containing the list of quota limits. */
  data: {
    /** Array of per-type quota limit entries. */
    limits: ZaiLimit[];
  };
}

/**
 * The structure persisted to `globalState` for caching API responses.
 */
interface CacheData {
  /** Schema version used to invalidate stale cache entries across extension updates. */
  version: string;
  /** Unix timestamp (ms) at which the cache entry was written. */
  timestamp: number;
  /** The raw API response that was cached. */
  data: ZaiApiResponse;
}

/**
 * Simplified token-usage statistics derived from a {@link ZaiApiResponse}.
 */
interface UsageData {
  /** Rounded token usage percentage (one decimal place, e.g. `75.3`). */
  percentage: number;
  /** Unix timestamp (ms) of the next quota reset, or `null` if unknown. */
  nextResetTime: number | null;
  /** Weekly window statistics, or `null` when the response has no weekly entry. */
  weekly: WeeklyUsage | null;
}

/**
 * Weekly token-usage statistics, taken from the weekly (`unit: 6`) entry
 * of the quota limits array.
 */
interface WeeklyUsage {
  /** Rounded token usage percentage (one decimal place, e.g. `75.3`). */
  percentage: number;
  /** Unix timestamp (ms) of the next weekly reset, or `null` if unknown. */
  nextResetTime: number | null;
}

/** Schema version embedded in every cache entry; increment to bust old caches. */
const CACHE_VERSION = "1.0";
/** Key used to store the cache object in `vscode.ExtensionContext.globalState`. */
const CACHE_KEY = "zaiUsagePlus.cache";
/** Key used to store the API key in `vscode.ExtensionContext.secrets`. */
const API_KEY_SECRET = "zaiUsagePlus.apiKey";
/** The z.ai quota/limit API endpoint. */
const API_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

/**
 * Activates the extension.
 * @param context - The extension context provided by VSCode.
 */
export function activate(context: vscode.ExtensionContext): void {
  const priority = vscode.workspace
    .getConfiguration("zaiUsagePlus")
    .get<number>("statusBarPriority", 10000);

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    priority,
  );
  statusBarItem.text = getLabel("...");
  statusBarItem.show();

  let intervalId: ReturnType<typeof setInterval> | undefined;

  /**
   * Returns the polling interval in milliseconds from the workspace configuration.
   * The value is clamped to a minimum of 10 seconds to prevent API flooding.
   *
   * @returns The refresh interval in milliseconds (minimum 10,000 ms).
   */
  function getRefreshInterval(): number {
    const seconds = vscode.workspace
      .getConfiguration("zaiUsagePlus")
      .get<number>("refreshInterval", 60);
    // Clamp to a minimum of 10 seconds to prevent API flooding from invalid config values.
    return Math.max(seconds, 10) * 1000;
  }

  /**
   * Builds the status bar label by prepending the configured prefix to a given suffix.
   * Uses a custom icon when the `useIcon` setting is enabled, otherwise falls back to "z.ai:".
   *
   * @param suffix - The text to append after the prefix (e.g. "75.3% (2h30m)").
   * @returns The fully composed status bar label string.
   */
  function getLabel(suffix: string): string {
    const useIcon = vscode.workspace
      .getConfiguration("zaiUsagePlus")
      .get<boolean>("useIcon", true);
    const prefix = useIcon ? "$(zai-icon-plus)" : "z.ai:";
    return `${prefix} ${suffix}`;
  }

  /**
   * Retrieves the cached API response from the extension's global state.
   * Returns `null` when no cache exists or when the stored cache version does not
   * match the current {@link CACHE_VERSION}.
   *
   * @returns The cached {@link CacheData} object, or `null` if absent or stale.
   */
  function getCache(): CacheData | null {
    const cache = context.globalState.get<CacheData>(CACHE_KEY);
    if (!cache || cache.version !== CACHE_VERSION) {
      return null;
    }
    return cache;
  }

  /**
   * Persists the given API response to the extension's global state as a versioned cache entry.
   * The entry records the current timestamp so that {@link isCacheValid} can later evaluate
   * whether the data is still fresh.
   *
   * @param data - The raw {@link ZaiApiResponse} to store in the cache.
   * @returns `void`
   */
  function setCache(data: ZaiApiResponse): void {
    context.globalState.update(CACHE_KEY, {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      data,
    } satisfies CacheData);
  }

  /**
   * Maps a raw quota limit entry to simplified usage statistics.
   *
   * @param limit - The raw {@link ZaiLimit} entry to map.
   * @returns The rounded usage percentage and next reset timestamp.
   */
  function toUsage(limit: ZaiLimit): {
    percentage: number;
    nextResetTime: number | null;
  } {
    return {
      percentage: Math.round(limit.percentage * 10) / 10,
      nextResetTime: limit.nextResetTime ?? null,
    };
  }

  /**
   * Extracts token-usage statistics from a raw API response.
   * Looks for the `TOKENS_LIMIT` (5-hour window) entry inside `data.limits` and
   * maps it to a simplified {@link UsageData} object; when the response also
   * contains a weekly (`unit: 6`) entry, it is exposed via `usage.weekly`.
   *
   * @param data - The raw {@link ZaiApiResponse} returned by the z.ai quota API.
   * @returns A {@link UsageData} object containing the usage percentage and next reset
   *   timestamp, or `null` when the expected data structure is absent.
   */
  function extractUsageData(data: ZaiApiResponse): UsageData | null {
    const limits = data.data?.limits;
    if (!Array.isArray(limits)) {
      return null;
    }

    const tokenLimit = limits.find((l) => l.type === "TOKENS_LIMIT");
    if (!tokenLimit) {
      return null;
    }

    // The weekly window is a separate entry in the same limits array.
    const weeklyLimit = limits.find((l) => l.unit === 6);

    return {
      ...toUsage(tokenLimit),
      weekly: weeklyLimit ? toUsage(weeklyLimit) : null,
    };
  }

  /**
   * Determines whether a cached API response is still valid and can be used
   * without issuing a new network request.
   *
   * A cache is considered invalid when any of the following conditions are met:
   * - The cache object is `null`.
   * - The elapsed time since caching exceeds the configured refresh interval.
   * - The `nextResetTime` stored in the cache is in the past, meaning a usage
   *   reset has already occurred and fresh data is required.
   *
   * @param cache - The {@link CacheData} to validate, or `null`.
   * @returns `true` if the cache is fresh and can be used; `false` otherwise.
   */
  function isCacheValid(cache: CacheData | null): boolean {
    if (!cache) {
      return false;
    }
    if (Date.now() - cache.timestamp >= getRefreshInterval()) {
      return false;
    }
    // If nextResetTime stored in the cache is in the past, invalidate and fetch fresh data.
    const usage = extractUsageData(cache.data);
    if (usage?.nextResetTime && usage.nextResetTime <= Date.now()) {
      return false;
    }
    return true;
  }

  /**
   * Formats the time remaining until the next usage quota reset into a short
   * human-readable string such as `"(2h30m)"`, `"(45m)"`, or `"(3d12h)"`
   * for windows longer than a day.
   *
   * Returns an empty string when `nextResetTime` is falsy, non-positive, or
   * already in the past.
   *
   * @param nextResetTime - The Unix timestamp (in milliseconds) of the next reset,
   *   or `null` if unknown.
   * @returns A formatted countdown string like `"(1h5m)"`, or `""` if not applicable.
   */
  function formatResetTime(nextResetTime: number | null): string {
    if (!nextResetTime || nextResetTime <= 0) {
      return "";
    }
    const diffMs = nextResetTime - Date.now();
    if (diffMs <= 0) {
      return "";
    }
    const diffSec = Math.floor(diffMs / 1000);
    const diffHours = Math.floor(diffSec / 3600);
    const diffMins = Math.floor((diffSec % 3600) / 60);
    const parts: string[] = [];
    if (diffHours >= 24) {
      parts.push(`${Math.floor(diffHours / 24)}d`);
      parts.push(`${diffHours % 24}h`);
    } else {
      if (diffHours > 0) parts.push(`${diffHours}h`);
      parts.push(`${diffMins}m`);
    }
    return `(${parts.join("")})`;
  }

  /**
   * Calls the z.ai quota API with the provided API key and returns the parsed response.
   *
   * Returns `null` on any of the following failure conditions:
   * - A non-2xx HTTP status code is received.
   * - The HTTP 200 response payload contains `success: false` (the API may return
   *   authentication errors with a 200 status, so the payload must be inspected).
   * - A network or parsing error is thrown.
   *
   * @param apiKey - The Bearer token used to authenticate the API request.
   * @returns A promise that resolves to the {@link ZaiApiResponse}, or `null` on failure.
   */
  async function fetchFromApi(apiKey: string): Promise<ZaiApiResponse | null> {
    try {
      const response = await fetch(API_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        console.error(
          "[z.ai Usage Plus] API HTTP error:",
          response.status,
          await response.text(),
        );
        return null;
      }

      const data: ZaiApiResponse = await response.json();

      // The API may return an authentication error within a 200 response — always inspect the payload.
      if (data.success === false) {
        console.error(
          "[z.ai Usage Plus] API error response:",
          data.code,
          data.msg,
        );
        return null;
      }

      return data;
    } catch (error) {
      console.error("[z.ai Usage Plus] Error:", error);
      return null;
    }
  }

  /**
   * Orchestrates the full usage-data retrieval flow: secret lookup → cache check →
   * optional API call → stale-cache fallback.
   *
   * Resolution order:
   * 1. If no API key is stored, returns `noApiKey: true` immediately.
   * 2. If a valid cache entry exists, returns the cached data without an API call.
   * 3. Calls the API; on success, writes the response to the cache and returns it.
   * 4. On API failure, falls back to the expired cache if one is available.
   * 5. Returns `usage: null` when all sources are unavailable.
   *
   * @returns A promise resolving to an object with:
   *   - `usage` — The parsed {@link UsageData}, or `null` when unavailable.
   *   - `apiCalled` — `true` when a live API request was made successfully.
   *   - `noApiKey` — `true` when no API key is stored in the secret store.
   */
  async function fetchUsage(): Promise<{
    usage: UsageData | null;
    apiCalled: boolean;
    noApiKey: boolean;
  }> {
    const apiKey = await context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      return { usage: null, apiCalled: false, noApiKey: true };
    }

    const cache = getCache();

    if (cache && isCacheValid(cache)) {
      return {
        usage: extractUsageData(cache.data),
        apiCalled: false,
        noApiKey: false,
      };
    }

    const apiData = await fetchFromApi(apiKey);

    if (apiData) {
      setCache(apiData);
      return {
        usage: extractUsageData(apiData),
        apiCalled: true,
        noApiKey: false,
      };
    }

    // Fall back to the expired cache when the API call fails.
    if (cache) {
      return {
        usage: extractUsageData(cache.data),
        apiCalled: false,
        noApiKey: false,
      };
    }

    return { usage: null, apiCalled: false, noApiKey: false };
  }

  /**
   * Starts (or restarts) the polling interval that periodically calls
   * {@link updateStatusBar}.
   *
   * If a previous interval is already running it is cleared before a new one
   * is created, ensuring that configuration changes (e.g. `refreshInterval`)
   * take effect immediately without spawning duplicate timers.
   *
   * @returns `void`
   */
  function startInterval(): void {
    if (intervalId !== undefined) {
      clearInterval(intervalId);
    }
    intervalId = setInterval(updateStatusBar, getRefreshInterval());
  }

  /**
   * Configures the status bar item to reflect the "no API key" state.
   *
   * Sets the item's label to "Set API Key" and attaches the `zaiUsagePlus.setApiKey`
   * command so that clicking the item opens the API key input prompt.
   *
   * @returns `void`
   */
  function applyNoApiKeyState(): void {
    statusBarItem.command = "zaiUsagePlus.setApiKey";
    statusBarItem.text = getLabel("Set API Key");
    statusBarItem.tooltip = "Click to set your z.ai API key";
  }

  /**
   * Converts a usage percentage to the value shown in the status bar, taking the
   * display mode into account.
   *
   * @param percentage - The usage percentage (0-100) as returned by the API.
   * @param isRemaining - Whether the "remaining" display mode is active.
   * @returns The display percentage (one decimal place).
   */
  function toDisplayPercentage(
    percentage: number,
    isRemaining: boolean,
  ): number {
    return isRemaining ? Math.round((100 - percentage) * 10) / 10 : percentage;
  }

  /**
   * Builds the weekly portion of the status bar label, e.g. `" | Week: 12% (3d12h)"`.
   *
   * Returns an empty string when the weekly entry is absent or hidden by the
   * `showWeekly` setting; in condensed style the reset countdown is omitted.
   *
   * @param weekly - The {@link WeeklyUsage} from the API, or `null`.
   * @param isRemaining - Whether the "remaining" display mode is active.
   * @param isCondensed - Whether the "condensed" display style is active.
   * @returns The weekly label fragment, or `""` when unavailable or hidden.
   */
  function formatWeeklySuffix(
    weekly: WeeklyUsage | null,
    isRemaining: boolean,
    isCondensed: boolean,
  ): string {
    if (!weekly) {
      return "";
    }
    const percentage = toDisplayPercentage(weekly.percentage, isRemaining);
    const resetStr = isCondensed ? "" : formatResetTime(weekly.nextResetTime);
    return ` | Week: ${percentage}%${resetStr ? ` ${resetStr}` : ""}`;
  }

  /**
   * Fetches the latest usage data and updates the status bar item accordingly.
   *
   * Possible outcomes:
   * - **No API key**: delegates to {@link applyNoApiKeyState} to prompt the user.
   * - **Fetch failure**: displays a dash and an error tooltip.
   * - **Success**: renders the usage percentage and optional reset countdown; also
   *   shows a tooltip with full details and the configured refresh interval.
   *
   * The `displayStyle` setting controls the label verbosity: "full" shows
   * percentages with reset countdowns, "condensed" shows bare percentages.
   * The `showWeekly` setting toggles the weekly window on or off.
   *
   * After a successful live API call ({@link fetchUsage} returns `apiCalled: true`),
   * the polling interval is restarted via {@link startInterval} so that the next
   * refresh is scheduled relative to the moment fresh data was obtained.
   *
   * @returns A promise that resolves once the status bar has been updated.
   */
  async function updateStatusBar(): Promise<void> {
    const { usage, apiCalled, noApiKey } = await fetchUsage();

    if (noApiKey) {
      applyNoApiKeyState();
    } else if (usage === null) {
      statusBarItem.command = "zaiUsagePlus.updateStatusBar";
      statusBarItem.text = getLabel("-");
      statusBarItem.tooltip =
        "Unable to fetch z.ai usage data (click to refresh)";
    } else {
      statusBarItem.command = "zaiUsagePlus.updateStatusBar";
      const refreshSec = getRefreshInterval() / 1000;
      const resetStr = formatResetTime(usage.nextResetTime);

      const config = vscode.workspace.getConfiguration("zaiUsagePlus");
      // Get display settings (defaults: "usage" mode, "full" style, weekly shown)
      const displayMode = config.get<string>("displayMode", "usage");
      const displayStyle = config.get<string>("displayStyle", "full");
      const showWeekly = config.get<boolean>("showWeekly", true);

      // Calculate display percentage based on display mode
      const isRemaining = displayMode === "remaining";
      const isCondensed = displayStyle === "condensed";
      const displayPercentage = toDisplayPercentage(
        usage.percentage,
        isRemaining,
      );

      const suffix = isCondensed
        ? `${displayPercentage}%`
        : resetStr
          ? `${displayPercentage}% ${resetStr}`
          : `${displayPercentage}%`;
      statusBarItem.text = getLabel(
        suffix +
          (showWeekly
            ? formatWeeklySuffix(usage.weekly, isRemaining, isCondensed)
            : ""),
      );

      // Build tooltip text (the tooltip always shows the full details)
      const resetTooltip = resetStr
        ? ` — resets in ${resetStr.replace(/[()]/g, "")}`
        : "";
      const weeklyResetStr = usage.weekly
        ? formatResetTime(usage.weekly.nextResetTime)
        : "";
      const weeklyTooltip =
        showWeekly && usage.weekly
          ? `\nWeekly ${displayMode}: ${toDisplayPercentage(usage.weekly.percentage, isRemaining)}%` +
            (weeklyResetStr
              ? ` — resets in ${weeklyResetStr.replace(/[()]/g, "")}`
              : "")
          : "";
      statusBarItem.tooltip =
        `z.ai token ${displayMode}: ${displayPercentage}%${resetTooltip}` +
        weeklyTooltip +
        `\n(auto-refreshes every ${refreshSec}s. click to refresh immediately)`;
    }

    if (apiCalled) {
      startInterval();
    }
  }

  /**
   * Handles the `zaiUsagePlus.setApiKey` command.
   *
   * Prompts the user for a Bearer token, verifies it against the z.ai API,
   * and — on success — persists it to the secret store and refreshes the status bar.
   * On verification failure the stored key and cache are both cleared.
   */
  const setApiKeyCmd = vscode.commands.registerCommand(
    "zaiUsagePlus.setApiKey",
    async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: "Enter your z.ai API key",
        placeHolder: "Bearer token...",
        password: true,
        ignoreFocusOut: true,
      });

      if (!apiKey) {
        return;
      }

      statusBarItem.text = getLabel("$(loading~spin) Verifying...");
      const result = await fetchFromApi(apiKey);

      if (result === null) {
        await context.secrets.delete(API_KEY_SECRET);
        await context.globalState.update(CACHE_KEY, undefined);
        vscode.window.showErrorMessage(
          "z.ai Usage Plus: Failed to verify API key. Please check the key and try again.",
        );
        await updateStatusBar();
        return;
      }

      await context.secrets.store(API_KEY_SECRET, apiKey);
      setCache(result);
      vscode.window.showInformationMessage(
        "z.ai Usage Plus: API key saved successfully.",
      );
      await updateStatusBar();
      startInterval();
    },
  );

  /**
   * Handles the `zaiUsagePlus.clearApiKey` command.
   *
   * Removes the stored API key from the secret store, clears the usage cache,
   * and transitions the status bar to the "no API key" state.
   */
  const clearApiKeyCmd = vscode.commands.registerCommand(
    "zaiUsagePlus.clearApiKey",
    async () => {
      await context.secrets.delete(API_KEY_SECRET);
      await context.globalState.update(CACHE_KEY, undefined);
      applyNoApiKeyState();
      vscode.window.showInformationMessage("z.ai Usage Plus: API key cleared.");
    },
  );

  /**
   * Handles the `zaiUsagePlus.updateStatusBar` command.
   *
   * Manually refreshes the status bar by calling {@link updateStatusBar}.
   * This command can be bound to the status bar item or triggered via command palette.
   *
   * Shows a loading indicator for at least 400ms to prevent flickering.
   */
  const updateStatusBarCmd = vscode.commands.registerCommand(
    "zaiUsagePlus.updateStatusBar",
    async () => {
      statusBarItem.text = "$(loading~spin) Refreshing...";
      // Wait at least 400ms to prevent flickering
      await new Promise((resolve) => setTimeout(resolve, 400));
      await updateStatusBar();
    },
  );

  updateStatusBar();
  startInterval();

  context.subscriptions.push(
    statusBarItem,
    setApiKeyCmd,
    clearApiKeyCmd,
    updateStatusBarCmd,
    /**
     * Listens for workspace configuration changes and re-applies them immediately.
     *
     * When `zaiUsagePlus.refreshInterval`, `zaiUsagePlus.useIcon`, `zaiUsagePlus.displayMode`,
     * `zaiUsagePlus.displayStyle`, or `zaiUsagePlus.showWeekly` changes, the status bar is
     * refreshed and the polling interval is restarted so the new settings take effect
     * without requiring a window reload.
     *
     * When `zaiUsagePlus.statusBarPriority` changes, the user is notified that a window
     * reload is required for the new priority to take effect, because the priority is
     * set at status bar item creation time and cannot be changed at runtime.
     */
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("zaiUsagePlus.refreshInterval") ||
        e.affectsConfiguration("zaiUsagePlus.useIcon") ||
        e.affectsConfiguration("zaiUsagePlus.displayMode") ||
        e.affectsConfiguration("zaiUsagePlus.displayStyle") ||
        e.affectsConfiguration("zaiUsagePlus.showWeekly")
      ) {
        updateStatusBar();
        startInterval();
      }
      if (e.affectsConfiguration("zaiUsagePlus.statusBarPriority")) {
        void (async () => {
          const selection = await vscode.window.showInformationMessage(
            "z.ai Usage Plus: Status bar priority changed. Reload the window to apply.",
            "Reload Window",
          );
          if (selection === "Reload Window") {
            await vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
          }
        })();
      }
    }),
    {
      dispose: () => {
        if (intervalId !== undefined) clearInterval(intervalId);
      },
    },
  );
}

/**
 * Deactivates the extension.
 * Called when VSCode is shutting down or the extension is disabled.
 */
export function deactivate(): void {}
