import { parseSlurmTime } from "@queuepilot/shared";

const nowEpoch = () => Math.floor(Date.now() / 1000);

function first(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function stringField(...values) {
  for (const value of values) {
    const candidate = first(value);
    if (candidate == null) continue;
    if (typeof candidate === "string") return candidate;
    if (typeof candidate === "number") return String(candidate);
    if (typeof candidate === "object") {
      if (typeof candidate.name === "string") return candidate.name;
      if (typeof candidate.value === "string") return candidate.value;
      if (typeof candidate.number === "number") return String(candidate.number);
    }
  }
  return "";
}

export function numberField(...values) {
  for (const value of values) {
    const candidate = first(value);
    if (candidate == null || candidate === "") continue;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string") {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof candidate === "object") {
      if (typeof candidate.number === "number" && Number.isFinite(candidate.number)) return candidate.number;
      if (typeof candidate.value === "number" && Number.isFinite(candidate.value)) return candidate.value;
      if (typeof candidate.set === "number" && Number.isFinite(candidate.set)) return candidate.set;
    }
  }
  return 0;
}

export function epochField(...values) {
  for (const value of values) {
    const candidate = first(value);
    if (candidate == null || candidate === "" || candidate === "None" || candidate === "Unknown") continue;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return Math.floor(candidate);
    if (typeof candidate === "string") {
      if (/^\d+$/.test(candidate)) return Number(candidate);
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    }
    if (typeof candidate === "object") {
      if (typeof candidate.number === "number" && Number.isFinite(candidate.number)) return Math.floor(candidate.number);
      if (typeof candidate.value === "number" && Number.isFinite(candidate.value)) return Math.floor(candidate.value);
      if (typeof candidate.set === "number" && Number.isFinite(candidate.set)) return Math.floor(candidate.set);
    }
  }
  return 0;
}

export function timeFieldSeconds(value, { numericUnit = "seconds" } = {}) {
  const candidate = first(value);
  if (candidate == null || candidate === "" || candidate === "None" || candidate === "Unknown" || candidate === "UNLIMITED" || candidate === "N/A" || candidate === "INVALID") {
    return 0;
  }
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return Math.floor(candidate * (numericUnit === "minutes" ? 60 : 1));
  }
  if (typeof candidate === "string") {
    if (/^\d+$/.test(candidate.trim())) {
      return Math.floor(Number(candidate) * (numericUnit === "minutes" ? 60 : 1));
    }
    return parseSlurmTime(candidate);
  }
  if (typeof candidate === "object") {
    if (typeof candidate.number === "number" && Number.isFinite(candidate.number)) {
      return Math.floor(candidate.number * (numericUnit === "minutes" ? 60 : 1));
    }
    if (typeof candidate.value === "number" && Number.isFinite(candidate.value)) {
      return Math.floor(candidate.value * (numericUnit === "minutes" ? 60 : 1));
    }
    if (typeof candidate.set === "number" && Number.isFinite(candidate.set)) {
      return Math.floor(candidate.set * (numericUnit === "minutes" ? 60 : 1));
    }
  }
  return 0;
}

export function normalizeJob(raw, cluster) {
  const state = stringField(raw.StateCompact, raw.job_state, raw.state, raw.state_current, raw.job_state_name);
  const submit = epochField(raw.Submit, raw.submit, raw.submit_time);
  const start = epochField(raw.Start, raw.start, raw.start_time);
  const end = epochField(raw.End, raw.end, raw.end_time);
  const pendingFromTimestamps = submit ? Math.max(0, (start || nowEpoch()) - submit) : 0;
  const elapsedFromTimestamps = start ? Math.max(0, (end || nowEpoch()) - start) : 0;
  const timelimitSeconds = timeFieldSeconds(raw.TimeLimit ?? raw.Timelimit ?? raw.time_limit ?? raw.timelimit, { numericUnit: "minutes" });

  return {
    jobId: stringField(raw.JobID, raw.job_id, raw.id),
    cluster,
    name: stringField(raw.Name, raw.JobName, raw.name, raw.job_name),
    user: stringField(raw.UserName, raw.User, raw.user_name, raw.user),
    account: stringField(raw.Account, raw.account),
    partition: stringField(raw.Partition, raw.partition),
    state,
    reason: stringField(raw.Reason, raw.state_reason, raw.reason),
    priority: numberField(raw.Priority, raw.priority),
    pendingSeconds: timeFieldSeconds(raw.PendingTime ?? raw.pending_time) || pendingFromTimestamps,
    elapsedSeconds: timeFieldSeconds(raw.TimeUsed ?? raw.Elapsed ?? raw.time_used ?? raw.elapsed) || elapsedFromTimestamps,
    timelimitSeconds,
    reqCpus: numberField(raw.NumCPUs, raw.ReqCPUS, raw.req_cpus, raw.num_cpus, raw.cpus),
    reqMem: stringField(raw.MinMemory, raw.ReqMem, raw.req_mem, raw.min_memory, raw.memory_per_node),
    wckey: stringField(raw.WCKey, raw.wckey),
    workdir: stringField(raw.WorkDir, raw.current_working_directory, raw.work_dir),
    nodelist: stringField(raw.NodeList, raw.nodes, raw.node_list),
    dependency: stringField(raw.Dependency, raw.dependencies, raw.dependency),
  };
}

export function normalizeHistoryRow(raw, cluster) {
  const submit = epochField(raw.Submit, raw.submit);
  const start = epochField(raw.Start, raw.start);
  const end = epochField(raw.End, raw.end);
  const elapsedSeconds = timeFieldSeconds(raw.Elapsed ?? raw.elapsed);
  const timelimitSeconds = timeFieldSeconds(raw.Timelimit ?? raw.time_limit, { numericUnit: "minutes" });

  return {
    jobId: stringField(raw.JobID, raw.job_id, raw.id),
    cluster,
    name: stringField(raw.JobName, raw.Name, raw.name),
    user: stringField(raw.User, raw.UserName, raw.user_name, raw.user),
    account: stringField(raw.Account, raw.account),
    partition: stringField(raw.Partition, raw.partition),
    finalState: stringField(raw.State, raw.state),
    submit,
    start,
    end,
    waitSeconds: submit && start ? Math.max(0, start - submit) : 0,
    elapsedSeconds,
    timelimitSeconds,
    reqCpus: numberField(raw.ReqCPUS, raw.NumCPUs, raw.req_cpus, raw.cpus),
    reqMem: stringField(raw.ReqMem, raw.MinMemory, raw.req_mem),
    wckey: stringField(raw.WCKey, raw.wckey),
    workdir: stringField(raw.WorkDir, raw.current_working_directory, raw.work_dir),
  };
}
