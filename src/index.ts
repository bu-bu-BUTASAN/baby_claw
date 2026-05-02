import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const pluginId = "baby_claw";
const version = "0.1.0";
const healthcheckPayload = {
  ok: true,
  plugin: pluginId,
  version,
};

export default definePluginEntry({
  id: pluginId,
  name: "Baby Claw",
  description: "Privacy-preserving baby care record tools for OpenClaw.",
  register(api) {
    api.registerTool({
      name: "baby_claw_healthcheck",
      label: "Baby Claw Healthcheck",
      description: "Return the Baby Claw plugin health status.",
      parameters: Type.Object({}),
      async execute() {
        return {
          details: healthcheckPayload,
          content: [
            {
              type: "text",
              text: JSON.stringify(healthcheckPayload),
            },
          ],
        };
      },
    });
  },
});
