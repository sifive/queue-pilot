const J = (p, opts = {}) => fetch(p, opts).then((r) => r.json());
export const api = {
  clusters: (opts) => J("/api/clusters", opts),
  pressure: (cluster, opts) => J(`/api/pressure?cluster=${cluster}`, opts),
  pending: (cluster, groupBy = "account,reason", opts) => J(`/api/pending?cluster=${cluster}&groupBy=${groupBy}`, opts),
  diagnose: (cluster, q = {}, opts) => J(`/api/diagnose?cluster=${cluster}&${new URLSearchParams(q)}`, opts),
  watch: (owner = "me", opts) => J(`/api/watch?owner=${owner}`, opts),
  watchStatus: (id, owner = "me", opts) => J(`/api/watch/${id}/status?owner=${owner}`, opts),
};
