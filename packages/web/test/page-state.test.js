import test from "node:test";
import assert from "node:assert/strict";

import {
  readUrlFilters,
  resolveLogjamAccountSelection,
  resolveSectionSearch,
  syncUrlFilters,
} from "../src/page-state.js";

test("readUrlFilters parses cluster and account from the url query string", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: {
      search: "?cluster=compute2&account=verif_bulk",
    },
  };

  assert.deepEqual(readUrlFilters(), {
    cluster: "compute2",
    account: "verif_bulk",
  });

  globalThis.window = previousWindow;
});

test("syncUrlFilters writes normalized cluster and account params", () => {
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    location: {
      href: "http://localhost:5173/?cluster=compute1#logjams",
    },
    history: {
      state: { source: "test" },
      replaceState: (...args) => calls.push(args),
    },
  };

  syncUrlFilters({ cluster: " compute2 ", account: " verif_bulk " });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], "/?cluster=compute2&account=verif_bulk#logjams");

  syncUrlFilters({ cluster: "compute2", account: "" });
  assert.equal(calls[1][2], "/?cluster=compute2#logjams");

  globalThis.window = previousWindow;
});

test("resolveLogjamAccountSelection keeps the requested account until logjam data is ready", () => {
  assert.equal(
    resolveLogjamAccountSelection({
      availableAccounts: [],
      selectedAccount: "verif_bulk",
      responseReady: false,
    }),
    "verif_bulk"
  );
});

test("resolveLogjamAccountSelection falls back only after the response is ready", () => {
  assert.equal(
    resolveLogjamAccountSelection({
      availableAccounts: [{ account: "verif_performance" }, { account: "verif_bulk" }],
      selectedAccount: "verif_bulk",
      responseReady: true,
    }),
    "verif_bulk"
  );

  assert.equal(
    resolveLogjamAccountSelection({
      availableAccounts: [{ account: "verif_performance" }, { account: "verif_bulk" }],
      selectedAccount: "missing_account",
      responseReady: true,
    }),
    "verif_performance"
  );

  assert.equal(
    resolveLogjamAccountSelection({
      availableAccounts: [],
      selectedAccount: "verif_bulk",
      responseReady: true,
    }),
    ""
  );
});

test("resolveSectionSearch clears a stale deferred filter immediately", () => {
  assert.equal(resolveSectionSearch("", "verif_bulk"), "");
  assert.equal(resolveSectionSearch("verif_bulk", "verif"), "verif");
  assert.equal(resolveSectionSearch(" verif_bulk ", " verif_bulk "), "verif_bulk");
});
