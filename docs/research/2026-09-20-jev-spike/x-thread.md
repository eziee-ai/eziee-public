# Thread for X

Attach `share-card.png` to post 1. X counts every link as 23 characters; each post below is within 280.
Every number is computed from the results files by `build-share.mjs` in https://github.com/eziee-ai/jev-router-demo.

Before posting: https://eziee.ai did not load when this was written (the domain answered like a parked page). Check it points at the site.
TypeSafe's handle is not tagged because it was not verified; add it if you know it.

## 1/9

We stopped making people wait for the model to read the question.

In eziee, “where can I earn the highest APY?” now gets a ranked table in about half a second. A small decision model reads the request, code ranks the markets, and the LLM explains afterwards.

## 2/9

The test: 12 prompts over the same market table.

TypeSafe's Jev returned a typed reading (intent + which measure you asked for) in a median 0.55 s. A language model's full answer took 7.8 s.

Not like for like. The point is which one you should be waiting on to see a table.

## 3/9

The finding that shaped the design:

32/32 right market when Jev only names the measure and code does the ranking.
25/32 when Jev compares the numbers itself.

So the model reads and code chooses. Ranking is arithmetic.

## 4/9

It runs beside the LLM, never in front of it. Both start at once.

Only if Jev is confident (0.9+) before the LLM has said anything do we show the table and restart the LLM with the ranking in hand. Otherwise nothing changes: no message waits for a reading it didn't need.

## 5/9

Live on the code we built (jev-1.13.0): 195–590 ms, about 655 input tokens.

Jev sees only the text of your latest message. No wallet, no history. Its whole output is one word from a fixed list, handed to a read-only tool. It never goes near a transaction.

## 6/9

Not advice, by construction: you state the measure, code ranks by it and shows its numbers, you decide.

Ask for “the best asset to buy” with no measure and nothing gets ranked. The assistant asks what you mean by best.

## 7/9

It's all open: the harness, the data, every raw answer, and a 5-minute guide to run it yourself. No keys in the repo; bring your own.

Market data from @iter_cx, whose contracts and interface are open source.

https://github.com/eziee-ai/jev-router-demo

## 8/9

Building a DeFi protocol? Run the same test on your own markets with --markets and send us the results.

To put your protocol inside eziee, start from our MCP template: a working server, a manifest, and the checks we run on them.

https://github.com/eziee-ai/protocol-mcp-template

## 9/9

Limits: 12 prompts is a direction, not a benchmark. Testnets have little volume, so the realistic numbers are a fixture. A typed answer guarantees a decision's shape, not that it's right.

Write-up: https://eziee-ai.github.io/jev-router-demo/

eziee, the AI desk for DeFi: https://eziee.ai
