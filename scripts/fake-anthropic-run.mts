import { startFake } from "./fake-anthropic.mts";

await startFake(4010);
console.log("fake Anthropic API on http://127.0.0.1:4010");
