import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

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
    _meta: {},
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("time_server MCP server running on stdio");
}

main().catch((error: unknown) => {
  console.error("Server error:", error);
  process.exit(1);
});
