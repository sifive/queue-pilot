import { config } from "../config.js";
import { CliAdapter } from "./cli.js";
import { RestdAdapter } from "./restd.js";
import { MockAdapter } from "./mock.js";

export function makeAdapter(name = config.adapter) {
  switch (name) {
    case "restd": return new RestdAdapter();
    case "mock": return new MockAdapter();
    case "cli":
    default: return new CliAdapter();
  }
}
