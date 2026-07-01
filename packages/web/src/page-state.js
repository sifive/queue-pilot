function normalizedText(value) {
  return String(value || "").trim();
}

export function readUrlFilters() {
  if (typeof window === "undefined") return { cluster: "", account: "" };
  const params = new URLSearchParams(window.location.search);
  return {
    cluster: normalizedText(params.get("cluster")),
    account: normalizedText(params.get("account")),
  };
}

export function syncUrlFilters({ cluster = "", account = "" }) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const nextCluster = normalizedText(cluster);
  const nextAccount = normalizedText(account);

  if (nextCluster) url.searchParams.set("cluster", nextCluster);
  else url.searchParams.delete("cluster");

  if (nextAccount) url.searchParams.set("account", nextAccount);
  else url.searchParams.delete("account");

  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function resolveSectionSearch(search, deferredSearch) {
  const liveSearch = normalizedText(search);
  if (!liveSearch) return "";
  return normalizedText(deferredSearch);
}

export function resolveLogjamAccountSelection({ availableAccounts = [], selectedAccount = "", responseReady = false }) {
  if (!responseReady) return selectedAccount;
  if (!availableAccounts.length) return "";
  if (availableAccounts.some((account) => normalizedText(account?.account) === normalizedText(selectedAccount))) {
    return selectedAccount;
  }
  return normalizedText(availableAccounts[0]?.account);
}
