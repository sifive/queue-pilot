# Regression Slurm Job Triage Workflow

Reference workflow for monitoring and triaging regression jobs that are not moving forward in
Slurm, especially Jenkins-driven regression flows where pending jobs, fan-out `srun` jobs, WCKey
patterns, or WorkDir patterns need to be inspected.

## Purpose

Use this workflow when we need to understand why regression jobs are stalled in Slurm. Jobs can be
blocked by normal queue pressure, but a running parent regression can also create a logjam when its
child `srun` jobs re-enter the pending queue and wait behind existing work.

## Step 1: Load the queue inspection helpers

Load `sifive/dops/devops-utils` first so `keephdr` and `colpipe` are available for readable queue
output.

```bash
module load sifive/dops/devops-utils
which keephdr
which colpipe
```

## Step 2: Check whether the problem is local to the user, the account, or the broader queue

Start narrow and widen only as needed.

- For your own pending jobs, use `squeue --me -t PD`.
- For a specific account, use `squeue -A <account> -t PD --long`.
- For all accounts you can use, derive `ACCT_LIST` from `sshare` and run
  `squeue -A ${ACCT_LIST} -t PD --long`.

```bash
squeue --me -t PD | less
```

```bash
squeue -A <account> -t PD --long | less
```

```bash
mapfile -t ACCT_ARRAY < <(sshare --noheader --parsable2 -U "$USER" -o %A)
ACCT_LIST=$(echo "${ACCT_ARRAY[*]}" | tr ' ' ,)
squeue -A "${ACCT_LIST}" -t PD --long | head -10
```

## Step 3: Bucket pending jobs so the bottleneck becomes obvious

For regression triage, the most useful high-level view is a bucketized pending-job summary by
priority, pending time, account, username, and reason.

```bash
FMT="Priority:0|,PendingTime:0|,Account:0|,UserName:0|,Reason:0"
HDR=${FMT//:0/}; HDR=${HDR//,/}; HDR="COUNT|${HDR^^}"
squeue -h -t PD -O "$FMT" |
  (
    echo "${HDR}"
    uniq -c |
      sed 's/^[ ]*\([^ ]*\) /\1|/' |
      sort -r -n -k3 -t '|'
  ) | colpipe
```

If the regression account is already known, scope the same recipe to that account first.

```bash
FMT="Priority:0|,PendingTime:0|,Account:0|,UserName:0|,Reason:0"
HDR=${FMT//:0/}; HDR=${HDR//,/}; HDR="COUNT|${HDR^^}"
squeue -h -t PD -A verif_performance -O "$FMT" |
  (
    echo "${HDR}"
    uniq -c |
      sed 's/^[ ]*\([^ ]*\) /\1|/' |
      sort -r -n -k3 -t '|'
  ) | colpipe
```

## Step 4: Interpret the `REASON` column before going deeper

Use the queue summary to classify the issue:

- `Priority` means other jobs are ahead in scheduling order.
- `Resources` means the required CPUs, memory, nodes, or GPUs are not free yet.
- `Licensing` or `Licenses` means the required shared software licenses are fully consumed.
- `Dependency` means the job is waiting on another job to finish.
- `QOSJobLimit` or `QOSResourceLimit` means the job hit QoS-defined limits.
- `PartitionNodeLimit` or `PartitionTimeLimit` means the request exceeds what the partition allows.
- `AssociationJobLimit` or `AssociationResourceLimit` means the account or user hit allocation
  limits.
- `Reservation` means the job is waiting for a reserved slot.

Also pay attention to zero priority or held states. A priority of `0` usually means the job is
held or the partition is deeply constrained.

## Step 5: Check whether a running regression is blocked by fan-out jobs

A common regression failure mode is that a running parent job spawns additional `srun` work, and
those child jobs land at the end of the pending queue. In a heavily loaded system, that can delay
the parent flow's completion and create a visible logjam.

When a regression looks "stuck" even though some part of it is already running, check this pattern
before assuming the scheduler is broken.

## Step 6: Search by WCKey when the regression identifier is in pipeline metadata

If the regression name or suite shows up in WCKey, query `squeue -O` with the full `WCKey` field
and filter for the regression path fragment.

```bash
squeue -u <user> -O 'JobID:0|,State:0|,Name:0|,WCKey:0' | keephdr grep ':<regression-key>/' | colpipe
```

Example:

```bash
squeue -u jenkins -O 'JobID:0|,State:0|,Name:0|,WCKey:0' | keephdr grep ':pre-merge-v2/' | colpipe
```

## Step 7: Search by WorkDir when the regression identifier is in filesystem paths

If the regression name is easier to recognize in archived build paths than in WCKey, inspect the
full `WorkDir` field instead.

```bash
squeue -u <user> -O 'JobID:0|,State:0|,Name:0|,WorkDir:0' --sort=j |
  keephdr grep '<regression-name-or-build-id>' | colpipe |
  sed 's|/scratch|\\\n\t/scratch|'
```

Example:

```bash
squeue -u jenkins -O 'JobID:0|,State:0|,Name:0|,WorkDir:0' --sort=j |
  keephdr grep full-cheetah1 | colpipe |
  sed 's|/scratch|\\\n\t/scratch|'
```

## Recommended response pattern

When we use this workflow during triage, structure the conclusion like this:

1. State whether the regression appears blocked by `Priority`, `Licenses`, `Dependency`, resource
   limits, or held state.
2. Say whether the blockage is isolated to one user, one account, or widespread across the queue.
3. If it is a regression flow, check WCKey and WorkDir for the regression identifier and call out
   matching running and pending jobs.
4. If there is evidence of fan-out `srun` jobs behind a running parent flow, call that out
   explicitly as the likely reason the regression is not moving forward.

## Default command bundle

```bash
module load sifive/dops/devops-utils

FMT="Priority:0|,PendingTime:0|,Account:0|,UserName:0|,Reason:0"
HDR=${FMT//:0/}; HDR=${HDR//,/}; HDR="COUNT|${HDR^^}"

squeue -h -t PD -O "$FMT" |
  (
    echo "${HDR}"
    uniq -c |
      sed 's/^[ ]*\([^ ]*\) /\1|/' |
      sort -r -n -k3 -t '|'
  ) | colpipe

squeue -u <user> -O 'JobID:0|,State:0|,Name:0|,WCKey:0' | keephdr grep ':<regression-key>/' | colpipe

squeue -u <user> -O 'JobID:0|,State:0|,Name:0|,WorkDir:0' --sort=j |
  keephdr grep '<regression-name-or-build-id>' | colpipe |
  sed 's|/scratch|\\\n\t/scratch|'
```

## Sources

- `sifive.atlassian.net/wiki/spaces/SysDocs/pages/4414537834`
- `sifive.atlassian.net/wiki/spaces/SysDocs/pages/3216769038`
