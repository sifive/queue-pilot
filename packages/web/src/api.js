const J = (p) => fetch(p).then((r) => r.json());
export const api = {
  clusters: () => J("/api/clusters"),
  pressure: (cluster) => J(`/api/pressure?cluster=${cluster}`),
  pending: (cluster, groupBy = "account,reason") => J(`/api/pending?cluster=${cluster}&groupBy=${groupBy}`),
  diagnose: (cluster, q = {}) => J(`/api/diagnose?cluster=${cluster}&${new URLSearchParams(q)}`),
  watch: (owner = "me") => J(`/api/watch?owner=${owner}`),
  watchStatus: (id, owner = "me") => J(`/api/watch/${id}/status?owner=${owner}`),
};
