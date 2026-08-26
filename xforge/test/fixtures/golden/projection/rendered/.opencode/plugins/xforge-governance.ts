import { spawn } from "node:child_process";
import { Plugin } from "@opencode-ai/plugin";

async function dispatch(event, phase) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn("xforge", ["hook", "dispatch", "--target", "opencode", "--event", phase], { stdio: ["pipe", "pipe", "inherit"] });
    const chunks = []; child.stdout.on("data", chunk => chunks.push(chunk)); child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error("XForge hook dispatcher failed"))); child.stdin.end(JSON.stringify(event));
  });
  const decision = JSON.parse(output || "{}");
  if (decision.decision === "deny") throw new Error(decision.reason || "Denied by XForge policy");
}

export default Plugin.define({
  id: "xforge.governance",
  setup: async (ctx) => {
    await ctx.tool.hook("execute.before", event => dispatch(event, "agent.tool.before"));
  },
});
