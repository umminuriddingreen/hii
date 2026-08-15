import type { AgentStatus } from "../../types/agentTask";
import { Badge } from "../ui/Badge";
import { agentStatusLabel, agentStatusStyle } from "../../lib/status";

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return <Badge className={agentStatusStyle[status]}>{agentStatusLabel[status]}</Badge>;
}
