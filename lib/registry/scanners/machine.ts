import os from "node:os";
import { RegistryMachine } from "../types";
import { homePath } from "../local-files";

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function scanMachine(): RegistryMachine {
  const hostname = os.hostname();
  const home = os.homedir();

  return {
    id: slug(hostname || "local-machine"),
    hostname,
    os: `${os.platform()}-${os.arch()}`,
    home,
    role: "primary-workstation",
    paths: {
      home,
      hiiRepo: homePath("hii"),
      hermesHome: homePath(".hermes"),
      codexHome: homePath(".codex"),
      hiiRuntime: homePath(".hii")
    }
  };
}
