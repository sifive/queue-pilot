# SLURM-QUERIES.md - exactly what QueuePilot runs, and why

All commands are READ-ONLY. Always carry `-M/--clusters` (compute1|testbed|primo). Always
server-side filter before post-processing to spare slurmctld. Prefer `-O FMT` (uppercase) with
width `:0` (no clipping) and `|` separator for robust parsing of wide fields (WCKey, WorkDir).

## Pending bucket summary (primary pressure signal)
    squeue -h -t PD -M <cluster> \
      -O 'Priority:0|,PendingTime:0|,Account:0|,UserName:0|,Reason:0' \
    | uniq -c | sort -r -n
Per account add `-A <acct>`. COUNT = identical jobs blocked by the same bottleneck. PRIORITY=0
means held/deeply constrained. REASON taxonomy: Priority, Resources, Licenses, Dependency,
QOSJobLimit/QOSResourceLimit, PartitionNodeLimit/PartitionTimeLimit, AssociationJobLimit/
AssociationResourceLimit, Reservation, ReqNodeNotAvail, "launch failed requeued held".

## A user's pending jobs
    squeue --me -t PD -M <cluster>
    squeue -u <user> -t PD -M <cluster> --long

## WCKey / WorkDir (needed to correlate flows & fan-out)
    squeue -u <user> -M <cluster> -O 'JobID:0|,State:0|,Name:0|,WCKey:0'
    squeue -u <user> -M <cluster> -O 'JobID:0|,State:0|,Name:0|,WorkDir:0' --sort=j

## Single job detail
    scontrol -M <cluster> show job <id> --json

## Historical runtimes / wait times (slurmdbd, for the ETA model)
    sacct -M <cluster> --starttime=<YYYY-MM-DD> \
      --state=COMPLETED,FAILED,TIMEOUT,CANCELLED \
      --format=JobID,JobName%80,User,Account,Partition,State,Submit,Start,End,Elapsed,Timelimit,ReqCPUS,ReqMem,WCKey%120,WorkDir%200 \
      --noheader --parsable2
wait_seconds = Start - Submit; elapsed_seconds from Elapsed.

## Fairshare / priority context
    sshare -U <user> -M <cluster> -o Account --noheader --parsable2   # derive accounts
    sshare -a -M <cluster>
    sprio -M <cluster> -j <jobids> -o '%i %u %r %Y %A %F %T'

## Jenkins correlation
Slurm job names like JENKINS.SLURM.VERIF.FPGA.HAPS100.MDM4.SHARK.02 map to Jenkins computer
nodes / builds. Parse the name to link a queue entry back to its Jenkins job URL.

## Time parsing
Slurm emits D-HH:MM:SS or HH:MM:SS. eta-core.parseSlurmTime handles both -> seconds.
