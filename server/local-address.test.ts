// Whether an engine's address is a program on this computer or on its own
// network rather than a hosted provider: such a program may log what it is
// sent, and nothing here can know.
import { describe, expect, it } from "vitest";

import { localAddress } from "./local-address.ts";

describe("an engine's address", () => {
  it("is local for this computer, a private network address and a local name", () => {
    for (const url of [
      // this computer
      "http://127.0.0.1:11434/v1", "http://127.8.9.10/v1", "http://localhost:1234/v1", "http://LOCALHOST:1234", "http://models.localhost:8080/v1",
      "http://[::1]:8080/v1", "http://0.0.0.0:8080/v1", "http://[::]:8080/v1", "http://[::ffff:127.0.0.1]:8080/v1",
      // a private network, a link-local address, a shared address space (a tailnet)
      "http://10.0.0.5:8000/v1", "http://172.16.4.2/v1", "http://172.31.255.254/v1", "https://192.168.1.20:8443/v1", "http://169.254.10.10/v1", "http://100.64.0.3:11434/v1", "http://100.127.9.9/v1",
      "http://[fd12:3456:789a::1]:8080/v1", "http://[fc00::1]/v1", "http://[fe80::1]/v1", "http://[::ffff:192.168.1.20]/v1",
      // a name only this network knows
      "http://studio.local:1234/v1", "http://Mac-Mini.local/v1", "http://ollama:11434/v1", "http://gpu-box/v1", "http://nas.lan:8080/v1", "http://llm.internal/v1", "http://box.home.arpa/v1",
    ]) expect(localAddress(url), url).toBe(true);
  });

  it("is not local for a hosted provider", () => {
    for (const url of [
      "https://api.openai.com/v1", "https://openrouter.ai/api/v1", "https://api.x.ai/v1", "https://api.mistral.ai/v1", "https://api.cerebras.ai/v1",
      "https://8.8.8.8/v1", "https://172.32.0.1/v1", "https://172.15.0.1/v1", "https://100.63.0.1/v1", "https://100.128.0.1/v1", "https://169.253.1.1/v1", "https://11.0.0.1/v1",
      "https://[2606:4700::1111]/v1", "https://local.example.com/v1", "https://localhost.example.com/v1", "https://internal.example.com/v1",
    ]) expect(localAddress(url), url).toBe(false);
  });

  it("is local when the address cannot be read: not knowing is not a reason to say nothing is kept", () => {
    for (const url of ["", "not a url", "127.0.0.1:11434", "http://"]) expect(localAddress(url), JSON.stringify(url)).toBe(true);
  });
});
