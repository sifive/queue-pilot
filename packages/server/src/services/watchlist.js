// Jobs-of-interest matching + persistence.
export function matches(job, m) {
  if (m.cluster && job.cluster !== m.cluster) return false;
  if (m.user && job.user !== m.user) return false;
  if (m.account && job.account !== m.account) return false;
  if (m.jobIds && !m.jobIds.includes(job.jobId)) return false;
  if (m.workdirSubstring && !(job.workdir || "").includes(m.workdirSubstring)) return false;
  if (m.nameRegex && !new RegExp(m.nameRegex).test(job.name || "")) return false;
  if (m.wckeyGlob) { const re = new RegExp("^" + m.wckeyGlob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"); if (!re.test(job.wckey || "")) return false; }
  return true;
}

export function makeWatchlist(db) {
  return {
    add(owner, label, matcher) {
      const r = db.prepare("INSERT INTO watch(owner,label,matcher_json,created_at) VALUES(?,?,?,?)")
        .run(owner, label, JSON.stringify(matcher), Math.floor(Date.now() / 1000));
      return { id: r.lastInsertRowid, owner, label, matcher };
    },
    list(owner) {
      return db.prepare("SELECT * FROM watch WHERE owner=?").all(owner)
        .map((w) => ({ ...w, matcher: JSON.parse(w.matcher_json) }));
    },
    remove(id) { db.prepare("DELETE FROM watch WHERE id=?").run(id); },
    resolve(jobs, matcher) { return jobs.filter((j) => matches(j, matcher)); },
  };
}
