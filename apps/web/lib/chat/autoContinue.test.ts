import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createAutoContinue, MAX_AUTO_CONTINUES } from "./autoContinue";

// What the model is waiting on: an action's result, the wallet's status. NOT a screen it asked to open.
const modelAwaits = (name: string) => name === "rate_swap" || name === "getWalletStatus";
const user: UIMessage = { id: "u", role: "user", parts: [{ type: "text", text: "swap" }] };
const assistant = (...parts: unknown[]): UIMessage => ({ id: "a", role: "assistant", parts: parts as UIMessage["parts"] });
const step = { type: "step-start" };
const tool = (name: string, state: string) => ({ type: `tool-${name}`, toolCallId: `${name}-1`, state, input: {}, ...(state === "output-available" ? { output: {} } : {}) });

describe("createAutoContinue — when the browser may send the conversation back to the model by itself", () => {
  it("continues once the browser has answered an action the model asked for", () => {
    const auto = createAutoContinue(modelAwaits);
    expect(auto.shouldContinue({ messages: [user, assistant(step, tool("rate_swap", "output-available"))] })).toBe(true);
  });

  it("waits while an action is still unanswered", () => {
    const auto = createAutoContinue(modelAwaits);
    expect(auto.shouldContinue({ messages: [user, assistant(step, tool("rate_swap", "input-available"))] })).toBe(false);
  });

  it("does NOT continue a reply whose last step only ran server tools: the server stopped it (step or budget limit), and resending would open a new hold for a loop nobody asked to extend", () => {
    const auto = createAutoContinue(modelAwaits);
    expect(auto.shouldContinue({ messages: [user, assistant(step, tool("rate_swap", "output-available"), step, tool("rate_pools", "output-available"))] })).toBe(false);
  });

  it("does NOT continue after a tool that only opens another screen: the person is leaving, and the reply would be billed and never seen", () => {
    const auto = createAutoContinue(modelAwaits);
    expect(auto.shouldContinue({ messages: [user, assistant(step, tool("openDeposit", "output-available"))] })).toBe(false);
    // The wallet's status is different: the model asked a question and needs the answer to go on.
    expect(auto.shouldContinue({ messages: [user, assistant(step, tool("getWalletStatus", "output-available"))] })).toBe(true);
  });

  it("does not continue a reply that ended in text, or a conversation that ends with the person", () => {
    const auto = createAutoContinue(modelAwaits);
    expect(auto.shouldContinue({ messages: [user, assistant(step, { type: "text", text: "done" })] })).toBe(false);
    expect(auto.shouldContinue({ messages: [user] })).toBe(false);
  });

  it("gives up after a bounded number of automatic turns, until the person speaks again", () => {
    const auto = createAutoContinue(modelAwaits);
    const messages = [user, assistant(step, tool("rate_swap", "output-available"))];
    for (let i = 0; i < MAX_AUTO_CONTINUES; i++) expect(auto.shouldContinue({ messages })).toBe(true);
    expect(auto.shouldContinue({ messages })).toBe(false);
    auto.personSpoke();
    expect(auto.shouldContinue({ messages })).toBe(true);
  });
});
