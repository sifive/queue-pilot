// REASON taxonomy + classifier. Categories drive UI color + diagnostics wording.
export const REASON_CATEGORIES = {
  PRIORITY: "priority",
  RESOURCES: "resources",
  LICENSES: "licenses",
  DEPENDENCY: "dependency",
  QOS: "qos",
  PARTITION: "partition",
  ASSOCIATION: "association",
  RESERVATION: "reservation",
  NODE_UNAVAIL: "node_unavail",
  HELD: "held",
  OTHER: "other",
};

const RULES = [
  [/^Priority$/i, REASON_CATEGORIES.PRIORITY, "Other jobs are ranked higher (fairshare/QOS). Not broken - waiting its turn."],
  [/^Resources$/i, REASON_CATEGORIES.RESOURCES, "Eligible; waiting for CPU/mem/nodes/GPU to free. Top-of-list Resources can stall scheduling (head-of-line)."],
  [/Licen[sc]/i, REASON_CATEGORIES.LICENSES, "A shared license (e.g. snps_vcs_runtime) is fully consumed by other jobs."],
  [/Dependency/i, REASON_CATEGORIES.DEPENDENCY, "Waiting on another job to finish first."],
  [/QOS/i, REASON_CATEGORIES.QOS, "Hit a Quality-of-Service limit (walltime/CPU/concurrent jobs)."],
  [/Partition(Node|Time)Limit|PartitionConfig/i, REASON_CATEGORIES.PARTITION, "Requests more nodes/time than the partition allows - may sit indefinitely."],
  [/Association/i, REASON_CATEGORIES.ASSOCIATION, "Account/user association reached its resource limit."],
  [/Reservation/i, REASON_CATEGORIES.RESERVATION, "Waiting for a booked advanced reservation window."],
  [/ReqNodeNotAvail|DOWN|DRAINED|UnavailableNodes/i, REASON_CATEGORIES.NODE_UNAVAIL, "Required nodes are down/drained/reserved for higher-priority partitions."],
  [/requeued held|JobHeld|held/i, REASON_CATEGORIES.HELD, "Job is held (admin or user) or the partition is deeply constrained."],
];

export function classifyReason(reason = "", priority = null) {
  const r = String(reason).trim();
  for (const [re, category, explain] of RULES) {
    if (re.test(r)) return { category, explain, reason: r };
  }
  if (priority !== null && Number(priority) === 0) {
    return { category: REASON_CATEGORIES.HELD, explain: "priority=0: typically held or partition deeply constrained.", reason: r };
  }
  return { category: REASON_CATEGORIES.OTHER, explain: "Uncategorized pending reason.", reason: r };
}
