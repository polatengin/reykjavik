import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const RESOURCE_URI = "ui://time_server/time-view.html";
const TIMEZONE_OPTIONS = [
  "pst",
  "est",
  "utc",
  "european",
  "australian",
  "other",
] as const;

type TimezoneOption = (typeof TIMEZONE_OPTIONS)[number];

const PRESET_TIMEZONES: Record<Exclude<TimezoneOption, "other">, string> = {
  pst: "America/Los_Angeles",
  est: "America/New_York",
  utc: "UTC",
  european: "Europe/London",
  australian: "Australia/Sydney",
};

const SUPPORTED_TIME_ZONES = new Set(Intl.supportedValuesOf("timeZone"));

function resolveTimezone(
  timezone: TimezoneOption,
  customTimezone?: string,
): string {
  if (timezone !== "other") {
    return PRESET_TIMEZONES[timezone];
  }

  const trimmedCustomTimezone = customTimezone?.trim();
  if (!trimmedCustomTimezone) {
    throw new Error("custom_timezone is required when timezone is 'other'.");
  }

  if (!SUPPORTED_TIME_ZONES.has(trimmedCustomTimezone)) {
    throw new Error(
      `Invalid custom_timezone '${trimmedCustomTimezone}'. Provide a valid IANA timezone like 'Europe/Berlin'.`,
    );
  }

  return trimmedCustomTimezone;
}

function formatLocalTime(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(now);
}

function isTimezoneOption(value: unknown): value is TimezoneOption {
  return (
    typeof value === "string" &&
    TIMEZONE_OPTIONS.includes(value as TimezoneOption)
  );
}

type TimezoneSelection = {
  timezone: TimezoneOption;
  custom_timezone?: string;
};

function supportsElicitation(mcpServer: McpServer): boolean {
  return Boolean(mcpServer.server.getClientCapabilities()?.elicitation);
}

function getManualTimezoneSelection(
  timezone?: TimezoneOption,
  customTimezone?: string,
): TimezoneSelection | null {
  if (!timezone) {
    return null;
  }

  if (timezone !== "other") {
    return { timezone };
  }

  const trimmedCustomTimezone = customTimezone?.trim();
  if (!trimmedCustomTimezone) {
    throw new Error("custom_timezone is required when timezone is 'other'.");
  }

  return { timezone, custom_timezone: trimmedCustomTimezone };
}

async function promptForTimezoneSelection(
  mcpServer: McpServer,
): Promise<TimezoneSelection> {
  const timezoneChoice = await mcpServer.server.elicitInput({
    mode: "form",
    message: "Which timezone should I use?",
    requestedSchema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          title: "Timezone",
          description: "Choose one timezone option.",
          oneOf: [
            { const: "pst", title: "PST (America/Los_Angeles)" },
            { const: "est", title: "EST (America/New_York)" },
            { const: "utc", title: "UTC" },
            { const: "european", title: "European (Europe/London)" },
            { const: "australian", title: "Australian (Australia/Sydney)" },
            { const: "other", title: "Other (provide IANA timezone)" },
          ],
        },
      },
      required: ["timezone"],
    },
  });

  if (timezoneChoice.action !== "accept" || !timezoneChoice.content) {
    throw new Error("Timezone selection was cancelled.");
  }

  const selectedTimezone = timezoneChoice.content.timezone;
  if (!isTimezoneOption(selectedTimezone)) {
    throw new Error("Invalid timezone selection.");
  }

  if (selectedTimezone !== "other") {
    return { timezone: selectedTimezone };
  }

  const customTimezoneChoice = await mcpServer.server.elicitInput({
    mode: "form",
    message: "Provide a custom IANA timezone (for example Europe/Berlin).",
    requestedSchema: {
      type: "object",
      properties: {
        custom_timezone: {
          type: "string",
          title: "Custom timezone",
          description: "Use a valid IANA timezone identifier.",
          minLength: 1,
        },
      },
      required: ["custom_timezone"],
    },
  });

  if (customTimezoneChoice.action !== "accept" || !customTimezoneChoice.content) {
    throw new Error("Custom timezone input was cancelled.");
  }

  const customTimezone = customTimezoneChoice.content.custom_timezone;
  if (typeof customTimezone !== "string" || !customTimezone.trim()) {
    throw new Error("custom_timezone is required when timezone is 'other'.");
  }

  return {
    timezone: "other",
    custom_timezone: customTimezone.trim(),
  };
}

const APP_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>time_server</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      body {
        margin: 0;
        padding: 12px;
      }
      .card {
        border: 1px solid color-mix(in oklab, currentColor 20%, transparent);
        border-radius: 10px;
        padding: 12px;
      }
      .row {
        margin: 0 0 8px 0;
      }
      code {
        word-break: break-all;
      }
      button {
        margin-top: 8px;
        padding: 6px 10px;
        background-color: red;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <p class="row"><strong>Status:</strong> <span id="status">Connecting...</span></p>
      <p class="row"><strong>Selected timezone:</strong> <code id="selected-timezone">-</code></p>
      <p class="row"><strong>Local time:</strong> <code id="local-time">-</code></p>
      <p class="row"><strong>UTC ISO:</strong> <code id="utc-iso">-</code></p>
      <p class="row"><strong>Epoch ms:</strong> <code id="epoch-ms">-</code></p>
      <button id="refresh" type="button">Refresh time</button>
    </div>
    <script>
      (() => {
        const statusEl = document.getElementById("status");
        const selectedTimezoneEl = document.getElementById("selected-timezone");
        const localTimeEl = document.getElementById("local-time");
        const utcIsoEl = document.getElementById("utc-iso");
        const epochMsEl = document.getElementById("epoch-ms");
        const refreshBtn = document.getElementById("refresh");
        const VALID_TIMEZONE_OPTIONS = new Set(["pst", "est", "utc", "european", "australian", "other"]);
        let currentArguments = { timezone: "utc" };

        const pending = new Map();
        let nextId = 1;

        const send = (message) => {
          window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
        };

        const sendRequest = (method, params) => {
          const id = nextId++;
          send({ id, method, params });
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
          });
        };

        const normalizeArguments = (argumentsValue) => {
          if (!argumentsValue || typeof argumentsValue !== "object") {
            return null;
          }

          const timezone = argumentsValue.timezone;
          if (!VALID_TIMEZONE_OPTIONS.has(timezone)) {
            return null;
          }

          if (timezone !== "other") {
            return { timezone };
          }

          const customTimezone = typeof argumentsValue.custom_timezone === "string"
            ? argumentsValue.custom_timezone.trim()
            : "";

          if (!customTimezone) {
            return null;
          }

          return { timezone, custom_timezone: customTimezone };
        };

        const renderResult = (result) => {
          const structured = result && result.structuredContent ? result.structuredContent : {};
          const textContent = Array.isArray(result && result.content)
            ? result.content.find((item) => item && item.type === "text" && typeof item.text === "string")
            : undefined;
          const selectedTimezone = typeof structured.timezone === "string" ? structured.timezone : "-";
          const localTime = typeof structured.local_time === "string" ? structured.local_time : textContent ? textContent.text : "-";
          const utcIso = typeof structured.utc_iso === "string" ? structured.utc_iso : textContent ? textContent.text : "-";
          const epochMs = typeof structured.epoch_ms === "number" ? structured.epoch_ms : null;

          selectedTimezoneEl.textContent = selectedTimezone;
          localTimeEl.textContent = localTime;
          utcIsoEl.textContent = utcIso;
          epochMsEl.textContent = epochMs === null ? "-" : String(epochMs);
        };

        window.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || message.jsonrpc !== "2.0") {
            return;
          }

          if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
            const entry = pending.get(message.id);
            if (!entry) {
              return;
            }
            pending.delete(message.id);
            if (message.error) {
              entry.reject(new Error(message.error.message || "Unknown JSON-RPC error"));
            } else {
              entry.resolve(message.result);
            }
            return;
          }

          if (message.method === "ui/notifications/tool-result") {
            renderResult(message.params);
            statusEl.textContent = "Ready";
            return;
          }

          if (message.method === "ui/notifications/tool-cancelled") {
            statusEl.textContent = "Tool call cancelled";
            return;
          }

          if (message.method === "ui/notifications/tool-input") {
            const normalizedArguments = normalizeArguments(message.params && message.params.arguments);
            if (normalizedArguments) {
              currentArguments = normalizedArguments;
            }
            return;
          }

          if (message.method === "ping" && Object.prototype.hasOwnProperty.call(message, "id")) {
            send({ id: message.id, result: {} });
            return;
          }

          if (message.method === "ui/resource-teardown" && Object.prototype.hasOwnProperty.call(message, "id")) {
            send({ id: message.id, result: {} });
          }
        });

        refreshBtn.addEventListener("click", async () => {
          statusEl.textContent = "Refreshing...";
          try {
            if (currentArguments.timezone === "other" && !currentArguments.custom_timezone) {
              statusEl.textContent = "Ask for a custom IANA timezone first (e.g. Europe/Berlin).";
              return;
            }

            const result = await sendRequest("tools/call", { name: "get_time", arguments: currentArguments });
            renderResult(result);
            statusEl.textContent = "Ready";
          } catch (error) {
            statusEl.textContent = error instanceof Error ? error.message : "Refresh failed";
          }
        });

        const initialize = async () => {
          try {
            await sendRequest("ui/initialize", {
              protocolVersion: "2026-01-26",
              appInfo: { name: "time_server_view", version: "0.1.0" },
              appCapabilities: {},
            });
            send({ method: "ui/notifications/initialized", params: {} });
            statusEl.textContent = "Connected";
          } catch (error) {
            statusEl.textContent = error instanceof Error ? error.message : "Initialization failed";
          }
        };

        void initialize();
      })();
    </script>
  </body>
</html>`;

const server = new McpServer({
  name: "time_server",
  version: "0.1.0",
}, {
  instructions:
    "For current-time requests, call select_timezone first, then call get_time using the returned timezone and optional custom_timezone.",
});

server.registerTool(
  "select_timezone",
  {
    title: "Select Timezone",
    description:
      "Ask the user to choose a timezone (pst, est, utc, european, australian, or other with custom_timezone).",
    inputSchema: {
      timezone: z
        .enum(TIMEZONE_OPTIONS)
        .optional()
        .describe(
          "Optional fallback for clients without elicitation support: choose one of pst, est, utc, european, australian, or other.",
        ),
      custom_timezone: z
        .string()
        .optional()
        .describe(
          "Optional fallback field for non-elicitation clients when timezone is 'other'. Use an IANA timezone like Europe/Berlin.",
        ),
    },
    outputSchema: z.object({
      timezone: z
        .enum(TIMEZONE_OPTIONS)
        .describe("Selected timezone option."),
      custom_timezone: z
        .string()
        .optional()
        .describe("Custom timezone when timezone is 'other'."),
      resolved_timezone: z
        .string()
        .describe("Resolved IANA timezone to pass to get_time."),
    }),
  },
  async ({ timezone, custom_timezone }) => {
    const timezoneSelection = supportsElicitation(server)
      ? await promptForTimezoneSelection(server)
      : getManualTimezoneSelection(timezone, custom_timezone);

    if (!timezoneSelection) {
      throw new Error(
        "This client does not support interactive prompts. Provide timezone (and custom_timezone when timezone is 'other').",
      );
    }

    const resolvedTimezone = resolveTimezone(
      timezoneSelection.timezone,
      timezoneSelection.custom_timezone,
    );

    return {
      content: [
        {
          type: "text",
          text: `Selected timezone: ${timezoneSelection.timezone} (${resolvedTimezone})`,
        },
      ],
      structuredContent: {
        timezone: timezoneSelection.timezone,
        custom_timezone: timezoneSelection.custom_timezone,
        resolved_timezone: resolvedTimezone,
      },
    };
  },
);

registerAppTool(
  server,
  "get_time",
  {
    title: "Get Time",
    description:
      "Return current time for a provided timezone. Use select_timezone first, then pass its result here.",
    inputSchema: {
      timezone: z
        .enum(TIMEZONE_OPTIONS)
        .describe(
          "Required. Use the timezone returned by select_timezone: pst, est, utc, european, australian, or other.",
        ),
      custom_timezone: z
        .string()
        .optional()
        .describe(
          "Required when timezone is 'other'. Use the custom_timezone returned by select_timezone.",
        ),
    },
    outputSchema: z.object({
      timezone_choice: z
        .enum(TIMEZONE_OPTIONS)
        .describe("Requested timezone option."),
      timezone: z.string().describe("Resolved IANA timezone."),
      local_time: z
        .string()
        .describe("Current local time in selected timezone."),
      utc_iso: z.string().describe("Current UTC time in ISO 8601 format."),
      epoch_ms: z.number().int().describe("Unix epoch time in milliseconds."),
    }),
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
      },
    },
  },
  async ({ timezone, custom_timezone }) => {
    const resolvedTimezone = resolveTimezone(
      timezone,
      custom_timezone,
    );
    const now = new Date();
    const utcIso = now.toISOString();
    const epochMs = now.getTime();
    const localTime = formatLocalTime(now, resolvedTimezone);

    return {
      content: [
        {
          type: "text",
          text: `Current time in ${resolvedTimezone}: ${localTime} (UTC ${utcIso})`,
        },
      ],
      structuredContent: {
        timezone_choice: timezone,
        timezone: resolvedTimezone,
        local_time: localTime,
        utc_iso: utcIso,
        epoch_ms: epochMs,
      },
    };
  },
);

registerAppResource(
  server,
  RESOURCE_URI,
  RESOURCE_URI,
  {
    description: "Interactive MCP App view for get_time results.",
    mimeType: RESOURCE_MIME_TYPE,
  },
  async () => ({
    contents: [
      {
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: APP_HTML,
        _meta: {
          ui: {
            prefersBorder: true,
          },
        },
      },
    ],
  }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("time_server MCP server running on stdio");
}

main().catch((error: unknown) => {
  console.error("Server error:", error);
  process.exit(1);
});
