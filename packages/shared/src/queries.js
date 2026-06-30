// Canonical, read-only Slurm query/format definitions. The cli adapter builds argv from these;
// the parser maps columns back by FIELD ORDER. Uppercase -O + width :0 (no clip) + "|" separator.

export const SEP = "|";

// Order matters: parser uses this to assign columns.
export const PENDING_FIELDS = ["Priority", "PendingTime", "Account", "UserName", "Reason"];
export const JOB_FIELDS = [
  "JobID", "Name", "UserName", "Account", "Partition", "StateCompact", "Reason",
  "Priority", "PendingTime", "TimeUsed", "TimeLimit", "NumCPUs", "MinMemory",
  "WCKey", "WorkDir", "NodeList", "Dependency",
];

export const fmtO = (fields) => fields.map((f) => `${f}:0`).join(`${SEP},`);

// squeue argv builders (return arrays; adapter prepends ssh/`squeue`).
export function squeuePending({ cluster, account, user }) {
  const a = ["-h", "-t", "PD", "-M", cluster, "-O", fmtO(PENDING_FIELDS)];
  if (account) a.push("-A", account);
  if (user) a.push("-u", user);
  return a;
}
export function squeueJobs({ cluster, states = "PD,R", account, user, partition }) {
  const a = ["-h", "-t", states, "-M", cluster, "-O", fmtO(JOB_FIELDS)];
  if (account) a.push("-A", account);
  if (user) a.push("-u", user);
  if (partition) a.push("-p", partition);
  return a;
}
export function scontrolShowJob({ cluster, jobId }) {
  return ["-M", cluster, "show", "job", String(jobId), "--json"];
}
export const SACCT_FORMAT = [
  "JobID", "JobName%80", "User", "Account", "Partition", "State", "Submit",
  "Start", "End", "Elapsed", "Timelimit", "ReqCPUS", "ReqMem", "WCKey%120", "WorkDir%200",
];
export function sacctHistory({ cluster, startTime, states = "COMPLETED,FAILED,TIMEOUT,CANCELLED" }) {
  return ["-M", cluster, `--starttime=${startTime}`, `--state=${states}`,
    `--format=${SACCT_FORMAT.join(",")}`, "--noheader", "--parsable2", "--allocations"];
}
export function sshareAccounts({ cluster, user }) {
  return ["-M", cluster, "-U", user, "-o", "Account", "--noheader", "--parsable2"];
}

// Parse one "|"-separated squeue line into an object using a field order.
export function parsePipeLine(line, fields) {
  const parts = line.split(SEP).map((s) => s.trim());
  const o = {};
  fields.forEach((f, i) => (o[f] = parts[i] ?? ""));
  return o;
}
