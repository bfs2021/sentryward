import { describe, expect, it } from "vitest";
import { isInternalHost, isPrivateAddress } from "../src/lib/hostSafety.ts";
import { csvField, csvRow } from "../src/lib/csv.ts";
import {
  checkModel,
  connectionTarget,
  guardModels,
  hostMatches,
  mergePolicy,
  OPEN_LAYER,
  patternCovers,
  POLICY_PREFIX,
  shorterRetention,
  targetOf,
  type EffectivePolicy,
  type InstancePolicy,
  type PolicyLayer,
} from "../src/services/privacyPolicy.ts";

const OPEN_INSTANCE: InstancePolicy = { ...OPEN_LAYER, auditRetentionDays: null, retentionSource: null };

function policy(instance: Partial<PolicyLayer> = {}, workspace: Partial<PolicyLayer> = {}): EffectivePolicy {
  return mergePolicy({ ...OPEN_INSTANCE, ...instance }, { ...OPEN_LAYER, ...workspace });
}

// Never touches DNS: names map to fixed answers, anything else fails to resolve.
const resolver = (answers: Record<string, string[]>) => async (hostname: string) => {
  const addresses = answers[hostname];
  if (!addresses) throw new Error("ENOTFOUND");
  return addresses.map((address) => ({ address }));
};

describe("mergePolicy", () => {
  it("takes the shorter retention, treating null as forever", () => {
    expect(shorterRetention(null, null)).toBeNull();
    expect(shorterRetention(90, null)).toBe(90);
    expect(shorterRetention(null, 30)).toBe(30);
    expect(shorterRetention(90, 30)).toBe(30);
    expect(policy({ retentionDays: 30 }, { retentionDays: 60 }).retentionDays).toBe(30);
  });

  it("is local-only when either layer says so", () => {
    expect(policy().localOnly).toBe(false);
    expect(policy({ localOnly: true }).localOnly).toBe(true);
    expect(policy({}, { localOnly: true }).localOnly).toBe(true);
  });
});

describe("hostMatches", () => {
  const at = (hostname: string, port = "443") => ({ hostname, port });

  it("matches exact hosts case-insensitively", () => {
    expect(hostMatches("api.openai.com", at("api.openai.com"))).toBe(true);
    expect(hostMatches("API.OpenAI.com", at("api.openai.com"))).toBe(true);
    expect(hostMatches("api.openai.com", at("evil-api.openai.com"))).toBe(false);
  });

  it("matches wildcards below the domain but not the apex", () => {
    expect(hostMatches("*.example.com", at("llm.example.com"))).toBe(true);
    expect(hostMatches("*.example.com", at("a.b.example.com"))).toBe(true);
    expect(hostMatches("*.example.com", at("example.com"))).toBe(false);
    expect(hostMatches("*.example.com", at("badexample.com"))).toBe(false);
  });

  it("checks the port only when the pattern names one", () => {
    expect(hostMatches("ollama.lan:11434", at("ollama.lan", "11434"))).toBe(true);
    expect(hostMatches("ollama.lan:11434", at("ollama.lan", "443"))).toBe(false);
    expect(hostMatches("ollama.lan", at("ollama.lan", "11434"))).toBe(true);
  });

  it("matches bracketed IPv6 literals", () => {
    expect(hostMatches("[fd00::1]:8080", at("fd00::1", "8080"))).toBe(true);
  });
});

describe("patternCovers", () => {
  it("allows an equal or narrower workspace pattern", () => {
    expect(patternCovers("llm.example.com", "llm.example.com")).toBe(true);
    expect(patternCovers("*.example.com", "llm.example.com")).toBe(true);
    expect(patternCovers("*.example.com", "*.eu.example.com")).toBe(true);
    expect(patternCovers("llm.example.com", "llm.example.com:8080")).toBe(true);
  });

  it("refuses a wider one", () => {
    expect(patternCovers("llm.example.com", "*.example.com")).toBe(false);
    expect(patternCovers("*.eu.example.com", "*.example.com")).toBe(false);
    expect(patternCovers("llm.example.com:8080", "llm.example.com")).toBe(false);
    expect(patternCovers("llm.example.com", "other.example.com")).toBe(false);
  });
});

describe("targetOf", () => {
  it("resolves official hosts the way languageModel does", () => {
    const target = targetOf(undefined, {});
    expect(target("anthropic/claude-sonnet-4-5")).toMatchObject({ provider: "anthropic", host: "api.anthropic.com", port: "443" });
    expect(target("google/gemini-2.5-pro").host).toBe("generativelanguage.googleapis.com");
    // The OpenAI client Ollama is reached through defaults to OpenAI's host.
    expect(target("ollama/llama3").host).toBe("api.openai.com");
  });

  it("prefers the endpoint, then the provider's base URL", () => {
    expect(targetOf(undefined, { ollama: "http://ollama:11434/v1" })("ollama/llama3")).toMatchObject({
      hostname: "ollama",
      port: "11434",
      host: "ollama:11434",
    });
    expect(targetOf({ baseUrl: "https://proxy.lan/v1" }, { openai: "https://other/v1" })("openai/gpt-5").host).toBe("proxy.lan");
    expect(connectionTarget("openai").host).toBe("api.openai.com");
    expect(connectionTarget("ollama", "http://10.0.0.5:11434/v1").host).toBe("10.0.0.5:11434");
  });
});

describe("internal hosts", () => {
  it("classifies addresses", () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("trusts names only by what they resolve to", async () => {
    const resolve = resolver({
      ollama: ["172.18.0.4"],
      "api.openai.com": ["104.18.1.1"],
      mixed: ["10.0.0.1", "104.18.1.1"],
    });
    expect(await isInternalHost("localhost", resolve)).toBe(true);
    expect(await isInternalHost("ollama.localhost", resolve)).toBe(true);
    expect(await isInternalHost("192.168.0.10", resolve)).toBe(true);
    expect(await isInternalHost("ollama", resolve)).toBe(true);
    expect(await isInternalHost("api.openai.com", resolve)).toBe(false);
    expect(await isInternalHost("mixed", resolve)).toBe(false);
    expect(await isInternalHost("unknown.internal", resolve)).toBe(false);
  });
});

describe("checkModel", () => {
  const official = targetOf(undefined, {});
  const resolve = resolver({ "api.openai.com": ["104.18.1.1"], ollama: ["172.18.0.4"] });

  it("allows everything with no policy", async () => {
    expect(await checkModel(policy(), official("openai/gpt-5"), resolve)).toBeNull();
  });

  it("refuses a provider outside the list, naming the layer", async () => {
    const violation = await checkModel(policy({ allowedProviders: ["anthropic", "openai"] }), official("google/gemini-2.5-pro"), resolve);
    expect(violation?.message).toBe(
      `${POLICY_PREFIX} provider "google" (model google/gemini-2.5-pro) is not allowed by the instance settings. ` +
        "Allowed providers: anthropic, openai.",
    );
  });

  it("applies both layers, reporting the instance first", async () => {
    const workspaceOnly = await checkModel(policy({}, { allowedHosts: ["proxy.lan"] }), official("openai/gpt-5"), resolve);
    expect(workspaceOnly?.message).toContain("this workspace's privacy settings");
    expect(workspaceOnly?.message).toContain("host api.openai.com");

    const both = await checkModel(
      policy({ allowedProviders: ["anthropic"] }, { allowedProviders: ["ollama"] }),
      official("openai/gpt-5"),
      resolve,
    );
    expect(both?.scope).toBe("instance");
  });

  it("refuses a public host in local-only mode", async () => {
    const violation = await checkModel(policy({}, { localOnly: true }), official("openai/gpt-5"), resolve);
    expect(violation?.message).toBe(
      `${POLICY_PREFIX} local-only mode is on, and model openai/gpt-5 would send requests to api.openai.com, ` +
        "which is not a local endpoint. Use an Ollama or internal connection.",
    );
    const local = targetOf(undefined, { ollama: "http://ollama:11434/v1" })("ollama/llama3");
    expect(await checkModel(policy({ localOnly: true }), local, resolve)).toBeNull();
  });

  it("checks Ollama by its host, not its name", async () => {
    const remote = targetOf(undefined, { ollama: "https://api.openai.com/v1" })("ollama/llama3");
    expect((await checkModel(policy({ localOnly: true }), remote, resolve))?.rule).toBe("local_only");
  });
});

describe("guardModels", () => {
  it("refuses rejected and unchecked models synchronously", async () => {
    const guard = await guardModels(
      policy({ allowedProviders: ["anthropic"] }),
      ["anthropic/claude-sonnet-4-5", "openai/gpt-5"],
      undefined,
      {},
    );
    expect(() => guard.allow("anthropic/claude-sonnet-4-5")).not.toThrow();
    expect(() => guard.allow("openai/gpt-5")).toThrow(POLICY_PREFIX);
    expect(() => guard.allow("google/gemini-2.5-pro")).toThrow("was not checked");
    expect([...guard.rejected.keys()]).toEqual(["openai/gpt-5"]);
  });
});

describe("csv", () => {
  it("quotes and neutralizes formulas", () => {
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvField("-1+1")).toBe("'-1+1");
    expect(csvField(-1)).toBe("-1");
    expect(csvField(null)).toBe("");
    expect(csvField(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(csvRow(["a", 1])).toBe("a,1\r\n");
  });
});
