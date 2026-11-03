// 1.0's five roles as data (ARCH 4.8). Reply schemas arrive with their milestones (6.2–6.5 in M2, M9).
import { deepFreeze } from "./standard.js";
import type { Role } from "./types.js";

export const roles: readonly Role[] = deepFreeze([
  { id: "planner", coreInstructions: "special-agents:planner", replySchema: "plan", permissions: "read-only",
    defaultAgent: "claude" },
  { id: "ticket-maker", coreInstructions: "special-agents:ticket-maker", replySchema: "population",
    permissions: "read-only", defaultAgent: "claude" },
  { id: "builder", coreInstructions: "special-agents:builder", replySchema: "builder", permissions: "write",
    defaultAgent: "codex" },
  { id: "qa", coreInstructions: "special-agents:qa", replySchema: "verdict", permissions: "read-only",
    defaultAgent: "claude" },
  { id: "manager", coreInstructions: "special-agents:manager", replySchema: null, permissions: "read-only",
    defaultAgent: "claude" },
]);

export function findRole(id: string, list: readonly Role[] = roles): Role | undefined {
  return list.find((role) => role.id === id);
}
