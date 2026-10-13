import { describe, expect, it } from "vitest";
import { languageModelFor } from "./languageModel";

describe("languageModelFor", () => {
  it("calls OpenAI directly for an openai/* model when the key is set", () => {
    const model = languageModelFor("openai/gpt-5.5", { OPENAI_API_KEY: "sk-test" });
    expect(typeof model).toBe("object");
    expect(model).toMatchObject({ modelId: "gpt-5.5", provider: expect.stringMatching(/^openai/) });
  });

  it("leaves an openai/* model on the gateway without the key", () => {
    expect(languageModelFor("openai/gpt-5.5", {})).toBe("openai/gpt-5.5");
  });

  it("leaves every other model on the gateway", () => {
    expect(languageModelFor("moonshotai/kimi-k3", { OPENAI_API_KEY: "sk-test" })).toBe("moonshotai/kimi-k3");
  });
});
